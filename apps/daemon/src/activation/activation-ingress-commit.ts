/**
 * (G/H) The tail of `effect.activate`: assemble the durable record from what each authority
 * produced, then commit it and the budget hold as ONE decision.
 *
 * SPLIT OUT OF `activation-ingress.ts` when adding the durable budget stage pushed that file
 * to 417 physical lines, past this repository's 400-line split line. The seam is a real one
 * rather than a line-count dodge: everything here runs AFTER the last judgement — no stage
 * below refuses on a domain fact — so the file above stays exactly "the ordered sequence of
 * judgements" and this one is "what is written once they all pass".
 *
 * THE RESERVED -> ACTIVATED BUDGET TRANSITION IS DEFERRED, AND THAT IS FORCED, NOT PREFERRED.
 * `decision-ledger-legs.ts` refuses a duplicate aggregateId across legs, so the budget
 * aggregate may appear EXACTLY ONCE in one legs commit — and `reserveForAdmission` is the
 * transition that MOVES units, while `activateReservation` binds an attempt and moves none.
 * Deferring costs no money-safety: the attempt binding still lands durably on the ACTIVATION
 * aggregate, and `settleBudgetReservation` locates its target from the open reservations by
 * reservationId without ever requiring an ACTIVATED record.
 */

import { SUPERVISOR_ACTIVATION_VERSION } from "@moe/runner";
import type { ActivationCommit, EffectIntent } from "@moe/runner";
import type { ProviderSlotReservation } from "@moe/scheduler";
import type {
  CommandDecisionRecord, ExpectedVersionDecisionLeg, SqliteEventStore,
} from "@moe/store";

import type { ClaimSuccessors } from "../work/work-kernel.js";

import { commitActivationLedgerRecord } from "./activation-ledger-commit.js";
import {
  ACTIVATION_LEDGER_LAYER,
  ACTIVATION_LEDGER_RECORD_VERSION,
} from "./activation-ledger-contracts.js";
import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";
import { activationIngressRefusal } from "./activation-ingress-contracts.js";
import type {
  ActivationIngressOutcome, ActivationIngressRequest,
} from "./activation-ingress-contracts.js";

export interface ActivationStageResult {
  readonly commit: ActivationCommit;
  readonly predecessorAttemptVersion: number;
}

export interface AssembleInput {
  readonly activation: ActivationStageResult;
  readonly armed: EffectIntent;
  readonly providerSlot: ProviderSlotReservation;
  readonly successors: ClaimSuccessors;
}

/**
 * (G) Every field comes from the authority that produced it. `budgetView` and
 * `budgetReservation` are the DURABLE ledger record's own arrays read back out of what its
 * writer committed, carried through the budget stage and the claim tail untouched:
 * recomputing either here would be a second unauthorised arithmetic over the same units.
 */
export function assembleActivationRecord(input: AssembleInput): ActivationLedgerRecord {
  const { armed, successors } = input;
  const { commit } = input.activation;
  return {
    activationDigest: commit.activationDigest,
    activationVersion: SUPERVISOR_ACTIVATION_VERSION,
    attempt: commit.attempt,
    budgetReservation: successors.budgetReservation,
    budgetView: successors.budgetView,
    effectIntent: commit.intent,
    grant: commit.grant,
    lease: successors.lease,
    predecessorAttemptVersion: input.activation.predecessorAttemptVersion,
    predecessorIntentVersion: armed.version,
    providerSlot: input.providerSlot,
    recordVersion: ACTIVATION_LEDGER_RECORD_VERSION,
  };
}

function accepted(
  decision: CommandDecisionRecord,
  disposition: "COMMITTED" | "REPLAYED",
): ActivationIngressOutcome {
  return Object.freeze({
    advisoryOnly: false as const,
    authority: "DURABLE_DECISION" as const,
    decision,
    disposition: disposition === "COMMITTED" ? ("DECIDED" as const) : ("REPLAYED" as const),
    kind: "effect.activate" as const,
    ok: true as const,
  });
}

/**
 * (H) One atomic decision: attempt, slot, lease, effect, grant and the durable hold together.
 *
 * The budget leg ALWAYS reaches this commit — a captured-but-uncommitted leg reported as
 * success would be a fabricated receipt, and if this commit refuses, NEITHER aggregate moves.
 * On a byte-identical replay the leg is the ORIGINAL durable event rebuilt, which is what makes
 * the store recognise the retry: it folds every secondary leg's fence into the request
 * identity, so a one-leg retry of a two-leg decision is a DIFFERENT command to it.
 */
export function commitActivationStage(
  store: SqliteEventStore,
  request: ActivationIngressRequest,
  bytes: Uint8Array,
  record: ActivationLedgerRecord,
  budgetLeg: ExpectedVersionDecisionLeg,
): ActivationIngressOutcome {
  const key = {
    commandId: request.commandId,
    principalId: request.principalId,
    projectId: request.projectId,
  };
  const committed = commitActivationLedgerRecord(store, {
    budgetLeg,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    key,
    record,
    requestBytes: bytes,
  });
  if (!committed.ok) {
    return activationIngressRefusal({ code: committed.code, refusedBy: committed.layer });
  }
  const decision = store.getCommandDecision(key);
  if (decision === null) {
    // The ledger reported a commit the decision table cannot show. Unverifiable evidence never
    // becomes authority, so this is a refusal, not an accept.
    return activationIngressRefusal({
      code: "ACTIVATION_LEDGER_EVIDENCE_ABSENT",
      refusedBy: ACTIVATION_LEDGER_LAYER,
    });
  }
  return accepted(decision, committed.disposition);
}
