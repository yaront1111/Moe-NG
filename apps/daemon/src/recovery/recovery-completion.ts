import { applyApprovalCommand, reduceProject } from "@moe/core";
import type { ApprovalDecisionRecord, RecoveryCompletionWitness } from "@moe/core";
import { DurableStoreError } from "@moe/store";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import {
  RECOVERY_COMPLETION_COMMAND_KIND,
  RECOVERY_COMPLETION_LAYER,
  RECOVERY_COMPLETION_SCHEMA_VERSION,
  recoveryCompletionRefusal,
} from "./recovery-completion-digest.js";
import type { RecoveryCompletionRefused } from "./recovery-completion-digest.js";
import {
  CORE_APPROVAL_LAYER,
  PROJECT_REDUCER_LAYER,
  completionStale,
  decodeRecoveryCompleteRequest,
  evidenceAbsent,
  nonEmpty,
  projectStateOf,
  readRecoveryCompletionEvidence,
  storeUnavailable,
} from "./recovery-completion-evidence.js";
import type { RecoveryCompleteRequest } from "./recovery-completion-evidence.js";
import type {
  RecoveryCompletionAuthority,
  RecoveryCompletionAuthorityGrant,
} from "./recovery-completion-authority.js";
import type { RecoveryCompletionEvidenceFound } from "./recovery-completion-evidence.js";
import {
  acceptedRecoveryCompletion,
  answerRecoveryCompletionReplay,
  recoveryCompletionEventId,
} from "./recovery-completion-replay.js";
import type { RecoveryCompletionOutcome } from "./recovery-completion-replay.js";

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
 * reconciliation record digest, an approval record, its decide command, and a
 * signed session presentation. The
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
 * No PROJECT decision or event is written before (G) and every gate accumulates
 * into locals, so a partially completed recovery is unreachable rather than
 * merely untested. The one deliberate durable write on a refusal path is at (E):
 * a single-use session proof is BURNED by `sessions.authenticate` even when the
 * bindings above it then refuse, because a proof a rejected attempt could hand
 * back unspent would not be single-use. That burn touches the identity
 * aggregate, never the project's lifecycle.
 */

const encoder = new TextEncoder();
export type {
  RecoveryCompletionAccepted,
  RecoveryCompletionOutcome,
} from "./recovery-completion-replay.js";

type ApprovalVerdict =
  | { readonly ok: true; readonly approval: ApprovalDecisionRecord }
  | { readonly ok: false; readonly refusal: RecoveryCompletionRefused };

const approvalInvalid = (reason: string): RecoveryCompletionRefused =>
  recoveryCompletionRefusal({
    code: "RECOVERY_COMPLETION_APPROVAL_INVALID", reason, refusedBy: RECOVERY_COMPLETION_LAYER,
  });

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
function boundApproval(
  approval: ApprovalDecisionRecord,
  found: RecoveryCompletionEvidenceFound,
  grant: RecoveryCompletionAuthorityGrant,
): boolean {
  return approval.actor === grant.principalId
    && approval.actorKind === "HUMAN"
    && approval.truthClass === "HUMAN_APPROVED"
    && approval.riskTier === "R3"
    && approval.decision === "APPROVE"
    && nonEmpty(approval.decisionReason)
    && approval.stepUpAuthRef === grant.stepUpAuthRef
    && approval.applicablePolicyRef === found.evidence.policyRevisionRef
    && approval.exactRevisionHash === found.digest;
}

function verifyApproval(
  request: RecoveryCompleteRequest,
  found: RecoveryCompletionEvidenceFound,
  authority: RecoveryCompletionAuthority,
): ApprovalVerdict {
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
  if (approval.decision !== "APPROVE" || !nonEmpty(approval.decisionReason)) {
    return { ok: false, refusal: approvalInvalid("An R3 completion needs a reasoned APPROVE.") };
  }
  if (approval.exactRevisionHash !== found.digest) {
    return {
      ok: false,
      refusal: recoveryCompletionRefusal({
        code: "RECOVERY_COMPLETION_DIGEST_MISMATCH",
        reason: "The approval is bound to different recovery evidence than the store holds.",
        refusedBy: RECOVERY_COMPLETION_LAYER,
      }),
    };
  }
  if (approval.applicablePolicyRef !== found.evidence.policyRevisionRef) {
    return { ok: false, refusal: approvalInvalid("The approval policy is not current.") };
  }
  const granted = authority.authorize({
    approvalRef: approval.approvalRef,
    authentication: request.authentication,
    commandId: request.commandId,
    decisionReason: approval.decisionReason,
    incarnationRef: found.evidence.incarnationRef,
    keyEpochRef: found.evidence.keyEpochRef,
    policyRevisionRef: found.evidence.policyRevisionRef,
    principalId: request.principalId,
    projectId: request.projectId,
    recoveryDigest: found.digest,
  });
  if (!granted.ok) return { ok: false, refusal: granted };
  if (!boundApproval(approval, found, granted)) {
    return { ok: false, refusal: approvalInvalid("The approval assertions are not authenticated.") };
  }
  return { ok: true, approval };
}

/** (F)+(G) The pure lifecycle authority, then ONE commit carrying its event. */
function commit(
  store: SqliteEventStore,
  request: RecoveryCompleteRequest,
  witness: RecoveryCompletionWitness,
): RecoveryCompletionOutcome {
  let state;
  try {
    state = projectStateOf(store, request.projectId) ?? undefined;
  } catch (error) {
    return storeUnavailable(error);
  }
  const verdict = reduceProject(state, {
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
        eventId: recoveryCompletionEventId(commandId),
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
  return acceptedRecoveryCompletion(response.decision, response.disposition, witness);
}

export function runRecoveryCompleteCommand(
  store: SqliteEventStore,
  input: unknown,
  authority: RecoveryCompletionAuthority,
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
  if (prior !== null) return answerRecoveryCompletionReplay(store, request, prior);

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

  const verified = verifyApproval(request, found, authority);
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
