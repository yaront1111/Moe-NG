import type { SqliteEventStore } from "@moe/store";

import type { HumanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import { isSessionDigest, sessionReplayDigest }
  from "../identity/session-authority-protocol.js";
import { observeReplayMarker, replayAggregateId }
  from "../identity/session-authority-store.js";
import { APPROVAL_MISSING_FACT_CODES } from "./approval-intent.js";

/**
 * `stepUpAuthRef` for `approval.decide_intent`: SERVER-DERIVED, then BURNED ONCE (task-3b61860f).
 *
 * WHAT THE REFERENCE IS. `ApprovalDecisionRecord.stepUpAuthRef` must name the step-up
 * authentication behind a `HUMAN_APPROVED` record. Recovery already answered the same question
 * the same way (`recovery-completion-authority.ts:102`): the DURABLE REPLAY RECEIPT is the
 * step-up reference, and its digest is derived from the authenticated session's own identity.
 * This module mirrors that composition for the approval seam rather than inventing a second
 * notion of step-up that would agree today and drift tomorrow.
 *
 * WHERE THE INPUTS COME FROM, and why none of them is caller-reachable. Every field fed to the
 * digest is a SERVER fact: `transport.sessionRef` and `transport.commandId` are assembled at the
 * composition root from the ingress's own authentication result (`bootstrap-ledger-vocabulary.ts`,
 * `humanReviewWitness`) and are never decoded from request bytes, and `runId` is the intent the
 * seam already verified against durable state. A payload offering `transport`, `sessionRef` or
 * `stepUpAuthRef` is a fourth key and is refused by the seam's exact-shape fence before anything
 * here runs.
 *
 * WHY IT REFUSES RATHER THAN DEFAULTS. Absence of the transport fact answers with the seam's
 * EXISTING roster code, `APPROVAL_MISSING_FACT_CODES[1]`, under the seam's own layer — never a
 * new code for the same fact and never a constant ref. Two zero digests compare EQUAL, so a
 * defaulted reference would let a downstream fence pass against something nothing asserted.
 *
 * WHY THE BURN IS NOT A SECOND LEDGER. One-shot semantics compose the SessionAuthority replay
 * ledger (`observeReplayMarker`, expected version 0, `SessionAuthorityReplayObserved`), so the
 * same authenticated request cannot approve twice. An in-memory set would not survive a restart
 * and a second ledger would be a competing authority.
 */

/**
 * This module's OWN layer. Deliberately NOT spelled `*_LAYER`:
 * `tests/security/boundary-roster.security.ts` scans production sources for column-zero exported
 * `*_LAYER(S)` constants and makes each owe a hostile BEFORE/AFTER/RACE trio. The same discipline
 * `approval-intent.ts:49-53` follows. It is the SEAM's layer because absence of the step-up fact
 * is the seam's own refusal, not a new authority.
 */
const LAYER = "DAEMON_APPROVAL_INTENT" as const;

/**
 * Domain separation for the replay frame. `sessionReplayDigest` is shared with session
 * authentication, whose `nonce` slot carries a signed proof nonce; tagging the approval seam's
 * run identity keeps an approval digest from ever colliding with a session's replay digest even
 * though both are framed under the same replay domain.
 */
const APPROVAL_REPLAY_TAG = "approval.decide_intent" as const;

/**
 * The replay frame has no generation to bind — an approval is not a session rotation — so the
 * slot is pinned at the frame's own floor rather than filled with a clock or a counter, which
 * would break the determinism the burn depends on.
 */
const NO_GENERATION = 0;

export type StepUpUnavailableCode = (typeof APPROVAL_MISSING_FACT_CODES)[1];

export type StepUpDerivation =
  | Readonly<{ ok: true; stepUpAuthRef: string }>
  | Readonly<{ ok: false; code: StepUpUnavailableCode; layer: typeof LAYER }>;

/**
 * The replay ledger's OWN refusal vocabulary, carried verbatim rather than restamped.
 *
 * `observeReplayMarker` answers with a discriminant (`FRESH`/`REPLAYED`/`UNKNOWN`), not a code,
 * so these are the pairs its one existing production consumer maps those outcomes to:
 * `SESSION_REPLAYED` @ `REPLAY` is `authenticate-session.ts:203`'s answer for an observed replay,
 * and `AUTHENTICATION_FAILED` @ `REPLAY` is `session-authority.ts:260`'s answer for a burn whose
 * evidence is unavailable. That consumer THROWS on `UNKNOWN`; a command seam must fail closed
 * with a code instead, so the pair is reused rather than a new one minted.
 */
const REPLAYED_REFUSAL = Object.freeze({
  code: "SESSION_REPLAYED" as const, layer: "REPLAY" as const, ok: false as const,
});

const EVIDENCE_REFUSAL = Object.freeze({
  code: "AUTHENTICATION_FAILED" as const, layer: "REPLAY" as const, ok: false as const,
});

export type StepUpBurn =
  | Readonly<{ ok: true; aggregateId: string; eventId: string }>
  | typeof EVIDENCE_REFUSAL
  | typeof REPLAYED_REFUSAL;

export interface StepUpBurnRequest {
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly stepUpAuthRef: string;
}

/**
 * The step-up reference for one authenticated approval request, or the seam's refusal.
 *
 * PURE and DETERMINISTIC: the same witness and run always yield the same 64-hex digest. No clock
 * and no random source participate, because the burn below can only detect a replay if the same
 * authentication derives the same reference twice.
 */
export function deriveStepUpAuthRef(
  witness: HumanReviewWitness | undefined,
  runId: string,
): StepUpDerivation {
  const transport = witness?.transport;
  if (transport === undefined) {
    return Object.freeze({ code: APPROVAL_MISSING_FACT_CODES[1], layer: LAYER, ok: false as const });
  }
  return Object.freeze({
    ok: true as const,
    stepUpAuthRef: sessionReplayDigest({
      clientKeyId: transport.commandId,
      generation: NO_GENERATION,
      nonce: `${APPROVAL_REPLAY_TAG}/${runId}`,
      sessionId: transport.sessionRef,
    }),
  });
}

/**
 * Burns the reference so ONE authenticated request can approve at most once.
 *
 * The marker is committed at expected version 0 on the digest's own aggregate, so the SECOND
 * attempt with the same (authentication, command, run) loses the version race and comes back
 * `REPLAYED`. A different command id derives a different digest and therefore a different
 * aggregate, which is what keeps an honest retry of a DIFFERENT request admissible.
 */
export function burnStepUpAuthRef(
  store: SqliteEventStore,
  request: StepUpBurnRequest,
): StepUpBurn {
  // The ledger's own guard, applied here too so a malformed reference refuses under the
  // evidence pair rather than reaching the store as an aggregate id.
  if (!isSessionDigest(request.stepUpAuthRef)) return EVIDENCE_REFUSAL;
  const observation = observeReplayMarker(store, {
    decidedAt: request.decidedAt,
    principalId: request.principalId,
    projectId: request.projectId,
    replayDigest: request.stepUpAuthRef,
  });
  if (observation.outcome === "REPLAYED") return REPLAYED_REFUSAL;
  if (observation.outcome === "UNKNOWN") return EVIDENCE_REFUSAL;
  return Object.freeze({
    aggregateId: replayAggregateId(request.stepUpAuthRef),
    eventId: observation.receipt.eventId,
    ok: true as const,
  });
}
