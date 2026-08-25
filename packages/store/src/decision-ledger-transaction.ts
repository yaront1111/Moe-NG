import { DurableStoreError, IdempotencyConflictError } from "./store-contracts.js";
import type {
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
} from "./store-contracts.js";
import { invalidInput } from "./store-input.js";
import { INTERNAL_IDENTIFIER_PREFIX } from "./store-internals.js";
import type { StoredCommandDecision } from "./store-internals.js";
import { toCommandDecisionResponse } from "./store-rows.js";
import { applyCommitWithinTransaction } from "./event-ledger-transaction.js";
import type { CommitApply } from "./event-ledger-transaction.js";
import {
  commitAcceptedDecisionEffect,
  commitRejectedDecisionEffect,
  identifyDecisionRequest,
  lockedDecisionProposal,
  planDecision,
  snapshotDecisionRequest,
} from "./decision-ledger-canonical.js";
import type {
  CanonicalDecisionEffect,
  DecisionEffectContext,
  DecisionPlan,
} from "./decision-ledger-canonical.js";
import { writeCanonicalDecision } from "./decision-ledger-record.js";
import type { DecisionRecordContext } from "./decision-ledger-record.js";
import { DecisionPreflightStore } from "./decision-ledger-preflight.js";
import type { CommitExpectedVersionDecisionLegsInput } from "./decision-legs-contracts.js";
import {
  additionalLegFences,
  decideLegsUnderLock,
  planLegsDecision,
  snapshotLegsRequest,
} from "./decision-ledger-legs.js";
import type { DecisionLegsPlan } from "./decision-ledger-legs.js";
import { assertDecisionNamespaceFree } from "./decision-ledger-namespace.js";
import { buildDecisionLegRoster } from "./decision-leg-roster-persistence.js";

interface DecisionAttempt {
  commitAttempted: boolean;
}

/**
 * The atomic expected-version decision transaction. Internal to the decision
 * ledger; never exported from the package root.
 */
export class DecisionTransactionStore extends DecisionPreflightStore {
  public commitExpectedVersionDecision(
    rawInput: CommitExpectedVersionDecisionInput,
  ): CommandDecisionResponse {
    return this.commitDecision(rawInput, null);
  }

  public commitExpectedVersionDecisionWithApply(
    rawInput: CommitExpectedVersionDecisionInput,
    apply: CommitApply,
  ): CommandDecisionResponse {
    return this.commitDecision(rawInput, apply);
  }

  /**
   * One decision, several fenced aggregates, one transaction. Legs 1..N append
   * under their own leg receipts; the durable decision record describes the
   * PRIMARY leg exactly as a single-aggregate decision describes its only one.
   */
  public commitExpectedVersionDecisionLegs(
    rawInput: CommitExpectedVersionDecisionLegsInput,
  ): CommandDecisionResponse {
    this.requireDecisionWriteScope();
    const legsRequest = snapshotLegsRequest(rawInput);
    const { request } = legsRequest;
    for (const leg of legsRequest.legs) {
      if (leg.aggregateId.startsWith(INTERNAL_IDENTIFIER_PREFIX)) {
        return invalidInput(
          "legs[].aggregateId uses Moe's reserved internal identifier namespace",
        );
      }
    }
    const identities = identifyDecisionRequest(request, additionalLegFences(legsRequest));
    const preflight = this.preflightDecision(request, identities);
    if (preflight.kind === "SETTLED") {
      return preflight.response;
    }
    // Built directly rather than through planDecision: that helper's
    // preflight-proposal optimisation reads a top-level `events` a legs input
    // does not have, so it would re-snapshot committedResultBytes and then
    // swallow a guaranteed throw into a proposalFailure the leg loop never reads.
    return this.runDecisionTransaction(
      {
        identities,
        metadata: preflight.metadata,
        preflightProposal: null,
        proposalFailure: null,
        request,
      },
      null,
      planLegsDecision(legsRequest, identities.decisionId, preflight.metadata.decidedAt),
    );
  }

  private commitDecision(
    rawInput: CommitExpectedVersionDecisionInput,
    apply: CommitApply | null,
  ): CommandDecisionResponse {
    this.requireDecisionWriteScope();
    const request = snapshotDecisionRequest(rawInput);
    if (request.targetAggregateId.startsWith(INTERNAL_IDENTIFIER_PREFIX)) {
      return invalidInput("targetAggregateId uses Moe's reserved internal identifier namespace");
    }
    const identities = identifyDecisionRequest(request);
    const preflight = this.preflightDecision(request, identities);
    if (preflight.kind === "SETTLED") {
      return preflight.response;
    }
    return this.runDecisionTransaction(
      planDecision(request, identities, preflight.metadata, preflight.observedVersion),
      apply,
    );
  }

  private runDecisionTransaction(
    plan: DecisionPlan,
    apply: CommitApply | null,
    legsPlan: DecisionLegsPlan | null = null,
  ): CommandDecisionResponse {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin expected-version decision transaction");
    }
    const attempt: DecisionAttempt = { commitAttempted: false };
    try {
      this.assertDurableProjectBinding();
      const historical = this.loadCommandDecisionByKey(plan.request.key);
      if (historical !== null) {
        if (historical.requestSha256 !== plan.identities.requestSha256) {
          throw new IdempotencyConflictError(plan.request.key);
        }
        return this.commitAndRespond(attempt, historical, "REPLAYED");
      }
      assertDecisionNamespaceFree(
        this.database,
        (commandId) => this.loadReceipt(commandId, false) !== null,
        plan.identities,
        legsPlan,
      );
      return this.commitAndRespond(
        attempt,
        legsPlan === null
          ? this.decideUnderLock(plan, apply)
          : decideLegsUnderLock(
              { effect: this.effectContext(), record: this.recordContext() },
              plan.identities,
              plan.metadata,
              legsPlan,
            ),
        "DECIDED",
      );
    } catch (error) {
      throw this.classifyDecisionFailure(error, attempt.commitAttempted);
    }
  }

  private commitAndRespond(
    attempt: DecisionAttempt,
    decision: StoredCommandDecision,
    disposition: CommandDecisionResponse["disposition"],
  ): CommandDecisionResponse {
    attempt.commitAttempted = true;
    this.database.exec("COMMIT");
    return toCommandDecisionResponse(decision, disposition);
  }

  private decideUnderLock(
    plan: DecisionPlan,
    apply: CommitApply | null,
  ): StoredCommandDecision {
    const { identities, metadata, request } = plan;
    const observedVersion = this.assertAggregateTail(request.targetAggregateId);
    let effect: CanonicalDecisionEffect;
    if (observedVersion === request.expectedVersion) {
      effect = commitAcceptedDecisionEffect(
        this.effectContext(),
        lockedDecisionProposal(plan),
        observedVersion,
      );
    } else {
      effect = commitRejectedDecisionEffect(
        this.effectContext(),
        request,
        identities,
        metadata.decidedAt,
        observedVersion,
      );
    }
    const decision = writeCanonicalDecision(this.recordContext(), {
      effect,
      identities,
      metadata,
      observedVersion,
      request,
      roster: buildDecisionLegRoster(identities.decisionId, [{
        aggregateId: request.targetAggregateId,
        expectedVersion: request.expectedVersion,
        receipt: effect.effectDisposition === "EFFECTS_COMMITTED" ? effect.receipt : null,
      }]),
    });
    if (apply !== null && effect.effectDisposition === "EFFECTS_COMMITTED") {
      applyCommitWithinTransaction(this.database, apply, effect.receipt);
    }
    return decision;
  }

  private recordContext(): DecisionRecordContext {
    return { prepare: (sql) => this.database.prepare(sql) };
  }

  private effectContext(): DecisionEffectContext {
    return {
      assertAggregateTail: (aggregateId) => this.assertAggregateTail(aggregateId),
      writeCommitEffects: (input, requestSha256, previousVersion) =>
        this.writeCommitEffects(input, requestSha256, previousVersion),
    };
  }

  private classifyDecisionFailure(error: unknown, commitAttempted: boolean): unknown {
    const transactionEndedAfterCommitAttempt = commitAttempted && !this.database.isTransaction;
    let rollbackError: unknown;
    if (this.database.isTransaction) {
      try {
        this.database.exec("ROLLBACK");
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
    }
    if (transactionEndedAfterCommitAttempt || rollbackError !== undefined) {
      const causes = rollbackError === undefined ? [error] : [error, rollbackError];
      this.poison();
      return new DurableStoreError(
        "OUTCOME_UNKNOWN",
        "the scoped command decision could not be proven; reopen and reconcile by composite key",
        { cause: new AggregateError(causes) },
      );
    }
    if (error instanceof DurableStoreError) {
      return error;
    }
    return this.normalizeOperationalError(error, "commit expected-version decision");
  }
}
