import type { JsonObject, JsonValue } from "@moe/contracts";
import { decideApprovalAuthority, grantHumanAuthority } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { payloadRef, refuse } from "../bootstrap/bootstrap-ledger.js";
import type { HumanReviewWitness, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { approvalDelayDisposition, readApprovalGate } from "./approval-gate.js";
import { readApprovalPolicySettings } from "./approval-policy-settings.js";
import { APPROVAL_INTENT_PAYLOAD_KEYS } from "./approval-intent-contracts.js";
import { readApprovalIntentSources } from "./approval-intent-sources.js";
import { readApprovalRecordFacts } from "./approval-record-facts.js";
import { deriveStepUpAuthRef } from "./approval-step-up.js";

export { readApprovalIntentSources } from "./approval-intent-sources.js";
export type {
  ApprovalIntentRefused, ApprovalIntentSourceResult, ApprovalIntentSources,
} from "./approval-intent-sources.js";

/**
 * `approval.decide_intent` — the DAEMON-OWNED approval seam (task-6646f888).
 *
 * WHAT IT REPLACES AND WHY. The shipped `approval.decide` path reads the ACTIVATION WITNESS and
 * the APPROVAL RECORD off the caller's payload (`daemon-command-graph-approve.ts:94-98`,
 * `planning-services.ts:230-234`), so the caller authors the very bytes that assert a human
 * approved: `truthClass: "HUMAN_APPROVED"`, the risk tier, the step-up reference, every hash.
 * The PRINCIPAL is honest — the grant is minted server-side from a `HumanReviewWitness` — but the
 * RECORD is caller-shaped, and task rail 1 says human authority is not delegable. Here the caller
 * supplies INTENT ONLY and the daemon derives the rest from durable state and the session.
 *
 * EXACT-KEY ADMISSION, NEVER TRIMMING. A fourth key is REFUSED. Trimming an unexpected key is how
 * a caller-chosen authority gets in while every "it refused" arm stays green, so the shape fence
 * answers before anything else can observe the payload.
 *
 * NOTHING HERE DECIDES. The human gate belongs to `decideApprovalAuthority`, which consults the
 * per-unit gate FIRST by construction (`approval-policy.ts:127-137`) and returns
 * `checkHumanAuthority`'s refusal verbatim; the policy belongs to the daemon's own settings; WHICH
 * run was approved belongs to `verifyApprovedRunBinding`. `checkHumanAuthority` is never called
 * directly — it is deliberately unpublished from the core barrel (`packages/core/src/index.ts:239`)
 * and core declares a single `exports` subpath, so a deep import fails TS6059.
 *
 * IT REFUSES RATHER THAN DEFAULTS. Four of the eighteen fields `validateApprovalRecord` demands
 * are named by `APPROVAL_MISSING_FACT_CODES`, each with its own code naming exactly one fact. A
 * defaulted `riskTier` in particular would silently decide an authority question —
 * `approval-invalidation.ts:73` special-cases R3 — so absence and a value are kept as different
 * answers.
 *
 * ALL FOUR NOW HAVE DURABLE PRODUCERS: policyRef (task-ba102165), stepUpAuthRef (task-3b61860f),
 * budgetRef (task-be80cb74) and riskTier (task-f42d5165, from the run's own `PolicyEvaluated`).
 * The roster codes therefore fire only for a run whose producer has not answered, and a run that
 * finalized with a classified tier reaches the end of the walk with every fact established.
 * `APPROVAL_INTENT_RECORD_UNMINTED` is what answers there — the record composition itself is
 * task-6093483c, which needs authority decisions this seam cannot make for it.
 */

/**
 * This module's OWN layer. Deliberately NOT spelled `*_LAYER`: `tests/security/boundary-roster.security.ts`
 * scans production sources for column-zero exported `*_LAYER(S)` constants and makes each owe a
 * hostile BEFORE/AFTER/RACE trio. The same discipline `resource-reconcile-command.ts:50` follows.
 */
const LAYER = "DAEMON_APPROVAL_INTENT" as const;

export type ApprovalIntentLayer = typeof LAYER;

export {
  APPROVAL_DECIDE_INTENT_COMMAND_KIND, APPROVAL_INTENT_PAYLOAD_KEYS,
} from "./approval-intent-contracts.js";

/**
 * One code per record fact this seam cannot derive from durable state or the authenticated
 * session. Each names exactly ONE fact so an operator reads which producer is missing, and each
 * is what task-ba102165 flips from refusing to succeeding.
 */
export const APPROVAL_MISSING_FACT_CODES = Object.freeze([
  /** No pre-approval durable tier producer exists; a default would decide an authority question. */
  "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE",
  /** The operator witness carries no transport fact, so no session replay digest is derivable. */
  "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
  /** The only durable policy-revision reader is private to `recovery-completion-evidence.ts`. */
  "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE",
  /** The budget root digest is minted at ACTIVATION, downstream of the record it would sign. */
  "APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE",
] as const);

export type ApprovalMissingFactCode = (typeof APPROVAL_MISSING_FACT_CODES)[number];

export const APPROVAL_INTENT_SHAPE_INVALID = "APPROVAL_INTENT_SHAPE_INVALID" as const;

const DECISIONS: readonly string[] = Object.freeze(["APPROVE", "REJECT"]);

/** A plain own-property read: no getter runs and a hostile prototype contributes nothing. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    ? descriptor.value
    : undefined;
}

/** Exactly these keys and no others, counted over own keys so a prototype cannot hide one. */
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Reflect.ownKeys(value).length === keys.length
      && keys.every((key) => own(value, key) !== undefined || key in value);
  } catch {
    return false;
  }
}

/** The caller's whole contribution: which run, which way, and why. */
export interface ApprovalIntent {
  readonly decision: string;
  readonly decisionReason: string | null;
  readonly runId: string;
}

/**
 * The intent, or `null` when the payload is not EXACTLY the three admitted keys.
 *
 * A caller-supplied `activation`, `record`, `truthClass`, hash, `stepUpAuthRef` or principal all
 * land here as a fourth key and are refused as a set — not trimmed, not ignored.
 */
export function readApprovalIntent(payload: JsonValue): ApprovalIntent | null {
  if (!exactKeys(payload, APPROVAL_INTENT_PAYLOAD_KEYS)) return null;
  const object = payload as JsonObject;
  const runId = payloadRef(object, "runId");
  const decision = own(object, "decision");
  const reason = own(object, "decisionReason");
  if (runId === null || typeof decision !== "string" || !DECISIONS.includes(decision)) return null;
  if (reason !== null && (typeof reason !== "string" || reason.length === 0)) return null;
  return Object.freeze({ decision, decisionReason: reason, runId });
}

/**
 * The operator's own dispatch IS the human review the policy waits for — the SAME composition
 * `daemon-command-graph-approve.ts:68-79` and `planning-services.ts:190-202` already perform,
 * reused rather than reimplemented. A second human-authority path would be a competing authority.
 */
function operatorReviewAuthority(
  witness: HumanReviewWitness, runId: string, decidedAt: string,
  policy: ReturnType<typeof readApprovalPolicySettings>,
): ReturnType<typeof decideApprovalAuthority> {
  const granted = grantHumanAuthority(
    { gateId: `approval-review:${runId}`, grant: null, workRef: runId },
    { kind: "HUMAN", principalId: witness.principalId },
    Date.parse(decidedAt),
  );
  if (!granted.ok) return granted;
  return decideApprovalAuthority({ gate: granted.gate, policy });
}

export interface ApprovalIntentInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  /** Registry-minted from the AUTHENTICATED principal; never decoded from request bytes. */
  readonly humanReview: HumanReviewWitness | undefined;
  readonly payload: JsonValue;
  readonly principalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/**
 * The seam. Order is load-bearing and each check owns its own code.
 *
 * The human fence sits AHEAD of the fact derivation deliberately: a non-operator must be told that
 * a human must review this, not which durable producer is missing. Reversing the two would leak
 * the journey's internal state to a session with no authority to ask about it.
 */
export function runApprovalIntentCommand(input: ApprovalIntentInput): ServiceOutcome {
  const intent = readApprovalIntent(input.payload);
  if (intent === null) return refuse(null, APPROVAL_INTENT_SHAPE_INVALID, LAYER);

  // WHICH run, verified against durable state — the prerequisite, lifecycle and seal checks all
  // answer here under their own layers' codes, forwarded rather than restated.
  const sources = readApprovalIntentSources(input.store, input.projectId, intent.runId);
  if (!sources.ok) return refuse(null, sources.code, sources.layer);

  // THIS SEAM MINTS A `HUMAN_APPROVED` RECORD, so it REQUIRES the server-assembled witness and
  // refuses without one — including under a PROCEED_WITHOUT_HUMAN policy, which would otherwise
  // let an unwitnessed dispatch mint a human's approval. The tuple is the existing vocabulary's
  // (`approval-policy.ts:111`), forwarded rather than restated.
  const witness = input.humanReview;
  if (witness === undefined || witness.principalId !== input.principalId) {
    return refuse(null, "APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY");
  }
  const policy = readApprovalPolicySettings(process.env);
  const gate = readApprovalGate(sources.runRecord, intent.runId).gate;
  const decided = decideApprovalAuthority({ gate, policy });
  const authority = !decided.ok && decided.code === "APPROVAL_HUMAN_REVIEW_REQUIRED"
    && decided.layer === "APPROVAL_POLICY"
    ? operatorReviewAuthority(witness, intent.runId, input.decidedAt, policy)
    : decided;
  if (!authority.ok) return refuse(null, authority.code, authority.layer);
  // REFUSES rather than clamps: above 2**31-1 a timer would clamp the most conservative
  // configuration a board can write into an immediate proceed.
  if (approvalDelayDisposition(authority.delayMs) !== "IMMEDIATE") {
    return refuse(null, "APPROVAL_HUMAN_REVIEW_REQUIRED", "APPROVAL_POLICY");
  }

  // THE COMPOSITION SITE. Every fact above is derived; the rest come from the durable facts
  // reader, which refuses under the FIRST roster fact it cannot establish rather than
  // defaulting one or reading it off the caller. The code and layer this seam answers with are
  // unchanged: the reader names the fact, this seam keeps owning the refusal.
  //
  // The step-up reference is derived HERE rather than in the reader because it is a fact about
  // the AUTHENTICATED TRANSPORT, which only the composition-root witness carries; the reader is
  // read-only over durable state and its request vocabulary stays run identity only. Derivation
  // is PURE — it writes nothing — so a request that goes on to be refused leaves no trace.
  const stepUp = deriveStepUpAuthRef(input.humanReview, intent.runId);
  const facts = readApprovalRecordFacts(
    input.store,
    { projectId: input.projectId, runId: intent.runId },
    stepUp.ok ? { stepUpAuthRef: stepUp.stepUpAuthRef } : undefined,
  );
  // Absence is NOT special-cased here. `deriveStepUpAuthRef` refuses with THIS seam's own roster
  // code under THIS seam's layer, so the walk answering `APPROVAL_INTENT_STEP_UP_UNAVAILABLE`
  // and the derivation refusing it are the same tuple — and letting the walk answer keeps the
  // ROSTER's order in charge of which producer an operator is sent to.
  if (!facts.ok) return refuse(null, facts.missing, LAYER);

  // THE RECORD IS NOT MINTED YET, AND THIS RETURN IS WHY NOTHING BELOW IT RUNS. task-f42d5165
  // landed the tier's durable producer, making `facts.ok` reachable for the first time. The
  // burn below is correct only as the last act before a record exists; with no record it would
  // consume the one-shot reference and then refuse one line later, bricking every retry —
  // exactly what that line's own comment predicted. The code is deliberately NOT one of
  // `APPROVAL_MISSING_FACT_CODES`: every roster fact IS established here, so naming one would
  // report a producer missing that this seam just read.
  //
  // THE BURN THAT USED TO SIT HERE IS GONE, and its absence is the safe state rather than a
  // loss. `burnStepUpAuthRef` is correct only as the last act BEFORE a record exists; with no
  // record it could only consume the one-shot reference on a request that then refuses. It was
  // never reachable once this guard existed, and TypeScript will not typecheck an unreachable
  // tail (`facts` narrows to the incomplete arm there), so keeping it parked was not an option.
  // It is preserved in git history and `approval-step-up.ts` still owns and tests it.
  //
  // TO THE ROW THAT MINTS THE RECORD (task-6093483c): delete this return and restore the burn
  // immediately before the mint, so the reference is consumed only when a record follows it.
  // `approval-intent.test.ts`'s "burns NOTHING when the approval refuses" arm is the guard on
  // that ordering and reds if the burn is placed above a path that can still refuse.
  return refuse(null, "APPROVAL_INTENT_RECORD_UNMINTED", LAYER);
}
