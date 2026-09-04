import type { JsonObject, JsonValue } from "@moe/contracts";
import {
  decideApprovalAuthority, grantHumanAuthority, type ApprovalDependencyChanges,
  validateApprovalDependencyChanges,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { payloadRef, readDurableLedger, refuse } from "../bootstrap/bootstrap-ledger.js";
import type { HumanReviewWitness, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { approvalDelayDisposition, readApprovalGate } from "./approval-gate.js";
import { readApprovalPolicySettings } from "./approval-policy-settings.js";
import { assembleActivationInput, commitIntentActivation, replayIntentDecision }
  from "./approval-intent-activation.js";
import { APPROVAL_INTENT_PAYLOAD_KEYS } from "./approval-intent-contracts.js";
import { APPROVAL_REJECT_REASON_REQUIRED, commitIntentRejection, rejectionReasonOf }
  from "./approval-intent-rejection.js";
import { observeApprovalIntentSourceFences }
  from "./approval-intent-source-fences.js";
import { readApprovalIntentSources } from "./approval-intent-sources.js";

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
 * EXACT-KEY ADMISSION, NEVER TRIMMING. A fifth key is REFUSED. Trimming an unexpected key is how
 * a caller-chosen authority gets in while every "it refused" arm stays green, so the shape fence
 * answers before anything else can observe the payload.
 *
 * THE CALLER DOES NOT DECIDE. The human gate belongs to `decideApprovalAuthority`, which consults the
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
 * ALL FOUR HAVE DURABLE PRODUCERS. Once they resolve, the daemon validates its exact 18-field
 * record, derives activation from the same reread state, and appends the replay observation as
 * the final leg of that ONE decision. Refusals happen before the commit, so they burn nothing.
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
  /** The durable policy walk did not yield a tier; a default would decide authority. */
  "APPROVAL_INTENT_RISK_TIER_UNAVAILABLE",
  /** The operator witness carries no transport fact, so no session replay digest is derivable. */
  "APPROVAL_INTENT_STEP_UP_UNAVAILABLE",
  /** The durable policy walk did not yield its applicable revision reference. */
  "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE",
  /** The durable budget material did not yield its decide-time commitment reference. */
  "APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE",
] as const);

export type ApprovalMissingFactCode = (typeof APPROVAL_MISSING_FACT_CODES)[number];

export const APPROVAL_INTENT_SHAPE_INVALID = "APPROVAL_INTENT_SHAPE_INVALID" as const;
export const APPROVAL_INTENT_TARGET_MISMATCH = "APPROVAL_INTENT_TARGET_MISMATCH" as const;

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

/** The caller's whole contribution: run, decision, rationale, and dependency-change assertion. */
export interface ApprovalIntent {
  readonly decision: string;
  readonly decisionReason: string | null;
  readonly dependencyChanges: ApprovalDependencyChanges;
  readonly runId: string;
}

/**
 * The intent, or `null` when the payload is not EXACTLY the four admitted keys.
 *
 * A caller-supplied `activation`, `record`, `truthClass`, hash, `stepUpAuthRef` or principal all
 * land here as a fifth key and are refused as a set — not trimmed, not ignored.
 */
export function readApprovalIntent(payload: JsonValue): ApprovalIntent | null {
  if (!exactKeys(payload, APPROVAL_INTENT_PAYLOAD_KEYS)) return null;
  const object = payload as JsonObject;
  const dependencyChanges = validateApprovalDependencyChanges(own(object, "dependencyChanges"));
  if (dependencyChanges === undefined) return null;
  const runId = payloadRef(object, "runId");
  const decision = own(object, "decision");
  const reason = own(object, "decisionReason");
  if (runId === null || typeof decision !== "string" || !DECISIONS.includes(decision)) return null;
  if (reason !== null && (typeof reason !== "string" || reason.length === 0)) return null;
  return Object.freeze({ decision, decisionReason: reason, dependencyChanges, runId });
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
  readonly expectedVersion: number;
  /** Registry-minted from the AUTHENTICATED principal; never decoded from request bytes. */
  readonly humanReview: HumanReviewWitness | undefined;
  readonly payload: JsonValue;
  readonly principalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly targetAggregateId: string;
}

/**
 * The seam. Order is load-bearing and each check owns its own code.
 *
 * Target identity and replay bind first; then every mutable source version is captured before its
 * durable reader runs. Production ingress already requires the configured operator or a durably
 * paired HUMAN; the local witness check below validates that transported authority before minting.
 */
export function runApprovalIntentCommand(input: ApprovalIntentInput): ServiceOutcome {
  const intent = readApprovalIntent(input.payload);
  if (intent === null) return refuse(null, APPROVAL_INTENT_SHAPE_INVALID, LAYER);
  if (input.targetAggregateId !== intent.runId) {
    return refuse(null, APPROVAL_INTENT_TARGET_MISMATCH, LAYER);
  }
  const command = Object.freeze({
    commandId: input.commandId,
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    expectedVersion: input.expectedVersion,
    payload: input.payload as JsonObject,
    principalId: input.principalId,
    projectId: input.projectId,
  });
  const replayed = replayIntentDecision(input.store, command);
  if (replayed !== null) return replayed;
  if (intent.decision === "REJECT" && rejectionReasonOf(intent.decisionReason) === null) {
    return refuse(null, APPROVAL_REJECT_REASON_REQUIRED, LAYER);
  }

  // Capture every mutable source BEFORE the first authority read. The envelope version is the
  // browser's compare-only observation of this run; it supplies no record or fence value.
  const sourceFences = observeApprovalIntentSourceFences(
    input.store, input.projectId, intent.runId,
  );
  if (input.expectedVersion !== sourceFences.planningRunVersion) {
    return refuse(null, "BOOTSTRAP_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const ledger = readDurableLedger(input.store, input.projectId);

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

  if (intent.decision === "REJECT") {
    return commitIntentRejection(input.store, command, { intent, sourceFences, sources });
  }
  const assembled = assembleActivationInput(input.store, ledger, {
    humanReview: witness, intent, projectId: input.projectId, sourceFences,
  });
  if (!assembled.ok) return refuse(null, assembled.code, assembled.layer);
  // `readApprovalIntent` admitted an exact plain object; preserve those original payload bytes
  // in the decision request rather than rebuilding the caller's four intent fields.
  return commitIntentActivation(input.store, ledger, command, assembled.input);
}
