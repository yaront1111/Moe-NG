import { DurableStoreError, IdempotencyConflictError } from "./store-contracts.js";
import type {
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
} from "./store-contracts.js";
import { invalidInput } from "./store-input.js";
import { INTERNAL_IDENTIFIER_PREFIX } from "./store-internals.js";
import type { SnapshotDecisionMetadata, StoredCommandDecision } from "./store-internals.js";
import { toCommandDecisionResponse } from "./store-rows.js";
import { applyCommitWithinTransaction } from "./event-ledger-transaction.js";
import type { CommitApply } from "./event-ledger-transaction.js";
import {
  commitAcceptedDecisionEffect,
  commitRejectedDecisionEffect,
  identifyDecisionRequest,
  lockedDecisionProposal,
  planDecision,
  snapshotDecisionInputMetadata,
  snapshotDecisionRequest,
} from "./decision-ledger-canonical.js";
import type {
  CanonicalDecisionEffect,
  DecisionEffectContext,
  DecisionIdentities,
  DecisionPlan,
} from "./decision-ledger-canonical.js";
import { writeCanonicalDecision } from "./decision-ledger-record.js";
import { DecisionReplayStore } from "./decision-ledger-replay.js";

const COLLIDING_DECISION_ID_QUERY =
  "SELECT 1 AS value FROM command_decisions WHERE decision_id = ?";

interface DecisionAttempt {
  commitAttempted: boolean;
}

/**
 * The atomic expected-version decision transaction. Internal to the decision
 * ledger; never exported from the package root.
 */
export class DecisionTransactionStore extends DecisionReplayStore {
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

  private commitDecision(
    rawInput: CommitExpectedVersionDecisionInput,
    apply: CommitApply | null,
  ): CommandDecisionResponse {
    this.requireOpen();
    if (this.projectId === null || !this.writeProjectAsserted) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "scoped command decisions require an explicitly project-asserted store handle",
      );
    }
    const request = snapshotDecisionRequest(rawInput);
    if (request.key.projectId !== this.projectId) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_MISMATCH",
        `the command belongs to project ${JSON.stringify(request.key.projectId)}, but this database is bound to ${JSON.stringify(this.projectId)}`,
      );
    }
    if (request.targetAggregateId.startsWith(INTERNAL_IDENTIFIER_PREFIX)) {
      return invalidInput("targetAggregateId uses Moe's reserved internal identifier namespace");
    }
    const identities = identifyDecisionRequest(request);
    // One read snapshot for the two-SELECT tail check; a commit landing between
    // them must stay an ordinary race, not a STORE_CORRUPT preflight verdict.
    const preflight = this.readSnapshotOperation("preflight expected-version decision", () => {
      this.assertDurableProjectBinding();
      return {
        historical: this.loadCommandDecisionByKey(request.key),
        observedVersion: this.assertAggregateTail(request.targetAggregateId),
      };
    });
    if (preflight.historical !== null) {
      return this.reconcileHistoricalDecision(
        request.key,
        identities.requestSha256,
        new DurableStoreError(
          "STORE_CORRUPT",
          "a command decision disappeared between preflight and locked replay",
        ),
      );
    }
    let metadata: SnapshotDecisionMetadata;
    try {
      metadata = snapshotDecisionInputMetadata(request);
    } catch (metadataError) {
      return this.reconcileHistoricalDecision(
        request.key,
        identities.requestSha256,
        metadataError,
      );
    }
    return this.runDecisionTransaction(
      planDecision(request, identities, metadata, preflight.observedVersion),
      apply,
    );
  }

  private runDecisionTransaction(
    plan: DecisionPlan,
    apply: CommitApply | null,
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
      this.assertDecisionNamespaceFree(plan.identities);
      return this.commitAndRespond(attempt, this.decideUnderLock(plan, apply), "DECIDED");
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

  private assertDecisionNamespaceFree(identities: DecisionIdentities): void {
    const collidingDecision = this.database
      .prepare(COLLIDING_DECISION_ID_QUERY)
      .get(identities.decisionId);
    if (collidingDecision !== undefined) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "a scoped command decision ID collides with a different composite key",
      );
    }
    if (this.loadReceipt(identities.receiptCommandId, false) !== null) {
      throw new DurableStoreError(
        "DURABLE_ID_CONFLICT",
        "the internal decision receipt ID is already occupied",
      );
    }
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
    const decision = writeCanonicalDecision(
      { prepare: (sql) => this.database.prepare(sql) },
      { effect, identities, metadata, observedVersion, request },
    );
    if (apply !== null && effect.effectDisposition === "EFFECTS_COMMITTED") {
      applyCommitWithinTransaction(this.database, apply, effect.receipt);
    }
    return decision;
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
