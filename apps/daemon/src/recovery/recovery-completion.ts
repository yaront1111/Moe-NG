import { applyApprovalCommand, reduceProject } from "@moe/core";
import type { ApprovalDecisionRecord, RecoveryCompletionWitness } from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import {
  RECOVERY_COMPLETION_COMMAND_KIND,
  RECOVERY_COMPLETION_LAYER,
  RECOVERY_COMPLETION_SCHEMA_VERSION,
  RECOVERY_STEP_UP_REF_PREFIX,
  RECOVERY_STEP_UP_WINDOW_SECONDS,
  recoveryCompletionRefusal,
} from "./recovery-completion-digest.js";
import type { RecoveryCompletionRefused } from "./recovery-completion-digest.js";
import {
  CORE_APPROVAL_LAYER,
  PROJECT_REDUCER_LAYER,
  completionStale,
  decodeRecoveryCompleteRequest,
  evidenceAbsent,
  evidenceMismatched,
  isHex64,
  isInstant,
  nonEmpty,
  projectStateOf,
  readRecoveryCompletionEvidence,
  storeUnavailable,
} from "./recovery-completion-evidence.js";
import type { RecoveryCompleteRequest } from "./recovery-completion-evidence.js";

/** One public surface for the command: the evidence reader is republished here. */
export {
  decodeRecoveryCompleteRequest,
  readRecoveryCompletionEvidence,
} from "./recovery-completion-evidence.js";
export type {
  RecoveryCompleteRequest,
  RecoveryCompletionEvidenceFound,
  RecoveryCompletionEvidenceResult,
} from "./recovery-completion-evidence.js";

/**
 * `recovery.complete` — the one durable command that clears QUIESCED.
 *
 * IT CLEARS THE EFFECT EMBARGO WITHOUT TOUCHING IT. The embargo is a pure
 * function of the project's own lifecycle and `recoveryRequired` flag, both of
 * which move inside the single committed authority sequence below. There is no
 * separate release call here and there must never be one: a second switch could
 * be flipped while the project stayed fenced.
 *
 * NOTHING THE CALLER SENDS IS AUTHORITY. The request carries POINTERS — a
 * reconciliation record digest, an approval record and its decide command. The
 * accepted digest, the witness hashes, the incarnation ref and the truth class
 * are recomputed or read out of the store, so a caller cannot name the facts
 * that authorise its own completion.
 *
 * STAGE ORDER IS THE CONTRACT:
 *   A  envelope decode        structural, DAEMON_INGRESS, above everything
 *   B  durable replay         answered from the store, never re-adjudicated
 *   C  evidence + digest      inventory, restore, anchor, project state
 *   D  expectedVersion CAS    the caller's observation of the aggregate
 *   E  approval               core first, then the bindings core cannot judge
 *   F  reduceProject          the pure lifecycle authority
 *   G  ONE durable commit     the decision and ProjectRecovered together
 *
 * Nothing is written before (G) and every gate accumulates into locals, so a
 * partially completed recovery is unreachable rather than merely untested.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RecoveryCompletionAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: typeof RECOVERY_COMPLETION_COMMAND_KIND;
  readonly ok: true;
  readonly witness: RecoveryCompletionWitness;
}

export type RecoveryCompletionOutcome = RecoveryCompletionAccepted | RecoveryCompletionRefused;

type ApprovalVerdict =
  | { readonly ok: true; readonly approval: ApprovalDecisionRecord }
  | { readonly ok: false; readonly refusal: RecoveryCompletionRefused };

const approvalInvalid = (reason: string): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_APPROVAL_INVALID", reason, refusedBy: RECOVERY_COMPLETION_LAYER,
  });

/**
 * Step-up recency, measured against the SERVER's decision instant. The ref is a
 * caller-presented claim; what is enforced is that it states an instant, is not
 * in the future, and is inside the same 300s window core applies to a capability
 * step-up. Authenticating the step-up itself belongs to the identity fence.
 */
function recentStepUp(stepUpAuthRef: string | null, decidedAt: string): boolean {
  if (stepUpAuthRef === null || !stepUpAuthRef.startsWith(RECOVERY_STEP_UP_REF_PREFIX)) {
    return false;
  }
  const rest = stepUpAuthRef.slice(RECOVERY_STEP_UP_REF_PREFIX.length);
  // The LAST colon: an ISO instant carries two of its own, and splitting on the
  // first would truncate every timestamp to its hour and refuse every ref.
  const separator = rest.lastIndexOf(":");
  if (separator < 0) return false;
  const at = rest.slice(0, separator);
  if (!isInstant(at) || !isHex64(rest.slice(separator + 1))) return false;
  const elapsed = Date.parse(decidedAt) - Date.parse(at);
  return elapsed >= 0 && elapsed < RECOVERY_STEP_UP_WINDOW_SECONDS * 1_000;
}

/**
 * (E) Core judges the approval lifecycle and every invariant it owns, and its
 * code is surfaced UNCHANGED — the same discipline `planning-services.ts`
 * applies for the J1 journey. Only the bindings core has no opinion about are
 * added on top: R3 exactly, HUMAN exactly, an APPROVE carrying a stated reason,
 * a recent recovery step-up, and the digest this completion recomputed.
 *
 * THE PROJECT AND INCARNATION BINDING RIDES ON THE DIGEST. Both are framed
 * components of the preimage, so an approval bound to another project's or
 * another incarnation's evidence produces a different hash and is refused here
 * as a digest mismatch. There is deliberately no second, weaker comparison
 * against caller-named refs: a check a caller could satisfy by restating its own
 * request is not a binding.
 *
 * The existing `approval.decide` handler is NOT reused: it binds
 * `exactRevisionHash` to a planning run's submissionHash (planning-services.ts),
 * which is the J1 journey and knows nothing about recovery evidence.
 */
function verifyApproval(request: RecoveryCompleteRequest, digest: string): ApprovalVerdict {
  const verdict = applyApprovalCommand(request.approval, request.command);
  if (!verdict.ok) {
    return {
      ok: false,
      refusal: recoveryCompletionRefusal({
        code: verdict.error.code, error: verdict.error,
        reason: "The supplied approval is not a legal decision on its own lifecycle.",
        refusedBy: CORE_APPROVAL_LAYER,
      }),
    };
  }
  const approval = verdict.value;
  if (approval.actorKind !== "HUMAN" || approval.truthClass !== "HUMAN_APPROVED") {
    return { ok: false, refusal: approvalInvalid("recovery.complete is human-only.") };
  }
  if (approval.riskTier !== "R3") {
    return { ok: false, refusal: approvalInvalid("recovery.complete demands an R3 approval.") };
  }
  if (approval.decision !== "APPROVE" || !nonEmpty(approval.decisionReason)) {
    return { ok: false, refusal: approvalInvalid("An R3 completion needs a reasoned APPROVE.") };
  }
  if (!recentStepUp(approval.stepUpAuthRef, request.decidedAt)) {
    return { ok: false, refusal: approvalInvalid("The approval carries no recent step-up.") };
  }
  if (approval.exactRevisionHash !== digest) {
    return {
      ok: false,
      refusal: recoveryCompletionRefusal({
        code: "RECOVERY_COMPLETION_DIGEST_MISMATCH",
        reason: "The approval is bound to different recovery evidence than the store holds.",
        refusedBy: RECOVERY_COMPLETION_LAYER,
      }),
    };
  }
  return { ok: true, approval };
}

const eventIdFor = (commandId: string): string => `recovery-complete:${commandId}:recovered`;

function accepted(
  decision: CommandDecisionRecord,
  disposition: "DECIDED" | "REPLAYED",
  witness: RecoveryCompletionWitness,
): RecoveryCompletionAccepted {
  return Object.freeze({
    advisoryOnly: false as const,
    authority: "DURABLE_DECISION" as const,
    decision,
    disposition,
    kind: RECOVERY_COMPLETION_COMMAND_KIND,
    ok: true as const,
    witness,
  });
}

/**
 * (B) A retry is answered from what was DURABLY DERIVED, never echoed back from
 * the caller: the committed `ProjectRecovered` event is re-read and its witness
 * returned. A stored decision that is not this command's, or one whose event
 * binds a different reconciliation record, is a divergence and refuses.
 */
function answerReplayed(
  store: SqliteEventStore,
  request: RecoveryCompleteRequest,
  prior: CommandDecisionRecord,
): RecoveryCompletionOutcome {
  if (
    prior.commandKind !== RECOVERY_COMPLETION_COMMAND_KIND
    || prior.targetAggregateId !== request.projectId
    || prior.effectDisposition !== "EFFECTS_COMMITTED"
  ) {
    return evidenceMismatched("A different command already holds this command identity.");
  }
  const wanted = eventIdFor(request.commandId);
  for (const event of store.readAggregateEvents(request.projectId, 0, 1_000).items) {
    if (event.eventId !== wanted) continue;
    const parsed: unknown = JSON.parse(decoder.decode(event.payload));
    const witness = (parsed as { witness?: RecoveryCompletionWitness }).witness;
    if (witness === undefined) break;
    if (witness.inventoryReconciliationHash !== request.reconciliationDigest) {
      return evidenceMismatched("The replayed completion bound a different reconciliation record.");
    }
    return accepted(prior, "REPLAYED", witness);
  }
  return evidenceAbsent("The stored completion decision has no readable recovered event.");
}

/** (F)+(G) The pure lifecycle authority, then ONE commit carrying its event. */
function commit(
  store: SqliteEventStore,
  request: RecoveryCompleteRequest,
  witness: RecoveryCompletionWitness,
): RecoveryCompletionOutcome {
  const verdict = reduceProject(projectStateOf(store, request.projectId) ?? undefined, {
    commandId: request.commandId,
    expectedVersion: request.expectedVersion,
    kind: "recovery.complete",
    witness,
  });
  if (!verdict.ok) {
    return recoveryCompletionRefusal({
      code: verdict.error.code, error: verdict.error,
      reason: "The project lifecycle refused this completion.",
      refusedBy: PROJECT_REDUCER_LAYER,
    });
  }
  const [event] = verdict.events;
  if (event === undefined) {
    return evidenceAbsent("The reducer accepted without emitting an event.");
  }
  const commandId = request.commandId;
  let response: ReturnType<SqliteEventStore["commitExpectedVersionDecision"]>;
  try {
    response = store.commitExpectedVersionDecision({
      commandKind: RECOVERY_COMPLETION_COMMAND_KIND,
      committedResultBytes: encoder.encode(JSON.stringify(verdict.state)),
      correlationId: request.correlationId,
      decidedAt: request.decidedAt,
      events: [{
        domainSchemaVersion: RECOVERY_COMPLETION_SCHEMA_VERSION,
        eventId: eventIdFor(commandId),
        eventType: event.kind,
        payload: encoder.encode(JSON.stringify(event)),
      }],
      expectedVersion: request.expectedVersion,
      key: { commandId, principalId: request.principalId, projectId: request.projectId },
      requestBytes: request.bytes,
      targetAggregateId: request.projectId,
    });
  } catch (error) {
    return error instanceof DurableStoreError
      ? completionStale(error.code)
      : storeUnavailable(error);
  }
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return completionStale(response.decision.resultCode);
  }
  return accepted(response.decision, response.disposition, witness);
}

export function runRecoveryCompleteCommand(
  store: SqliteEventStore,
  input: unknown,
): RecoveryCompletionOutcome {
  const decoded = decodeRecoveryCompleteRequest(input);
  if (!decoded.ok) return decoded.refusal;
  const request = decoded.request;
  let prior: CommandDecisionRecord | null;
  try {
    prior = store.getCommandDecision({
      commandId: request.commandId,
      principalId: request.principalId,
      projectId: request.projectId,
    });
  } catch (error) {
    return storeUnavailable(error);
  }
  if (prior !== null) return answerReplayed(store, request, prior);

  const found = readRecoveryCompletionEvidence(
    store, request.projectId, request.reconciliationDigest,
  );
  if (!found.ok) return found;
  let observed: number;
  try {
    observed = store.getAggregateVersion(request.projectId);
  } catch (error) {
    return storeUnavailable(error);
  }
  // This layer owns the CAS so the code stays reachable: handing the caller's
  // number to the reducer instead would let core's EXPECTED_VERSION_CONFLICT
  // answer first and leave RECOVERY_COMPLETION_STALE untestable.
  if (request.expectedVersion !== observed) return completionStale(null);

  const verified = verifyApproval(request, found.digest);
  if (!verified.ok) return verified.refusal;
  return commit(store, request, Object.freeze({
    coverageProofHash: found.coverageProofHash,
    inventoryReconciliationHash: found.record.recordDigest,
    recoveryDecisionRef: verified.approval.approvalRef,
    recoveryIncarnationRef: found.record.incarnationRef,
    // Server-owned literal. Forwarding a caller's truth class would let a
    // request nominate the authority class of its own recovery.
    truthClass: "HUMAN_APPROVED" as const,
  }));
}
