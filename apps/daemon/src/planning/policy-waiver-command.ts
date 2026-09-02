import { identifyReplayRequest } from "@moe/store";
import type { CommandDecisionKey, CommandDecisionRecord, ExpectedVersionDecisionLeg,
  SqliteEventStore } from "@moe/store";

import { humanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import { DAEMON_POLICY_WAIVER, policyWaiverAggregateIdFor, policyWaiverTupleKeyFor,
  snapshotPolicyWaiverFields } from "../bootstrap/policy-waiver-record.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { DurableDecision } from "../http/http-contract.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { jsonBytes } from "../identity/session-authority-decision.js";
import { sessionReplayDigest } from "../identity/session-authority-protocol.js";
import { buildReplayMarkerDecisionLeg, replayAggregateId }
  from "../identity/session-authority-replay-marker.js";
import { buildPolicyWaiverLeg } from "./policy-waiver-leg.js";

/**
 * The typed `SOFT_POLICY_WAIVER` arm of `approval.decide`.
 *
 * Legacy `approval.decide` is reserved for the CONFIGURED operator seat; a soft policy
 * waiver is a different human act with a different authority, so a paired browser HUMAN
 * holding ADMIN may decide one while the legacy graph-approval bytes stay operator-only.
 * The registry branches on the exact nested discriminator BEFORE its operator fence, so
 * the composition root gains only a delegation. Project, principal, decision time, the
 * human-review witness and the one-use step-up reference are all assembled from the
 * AUTHENTICATED request, and the exact-shape decode refuses a payload that so much as
 * NAMES one of them before any store read. Record, fold and expected-version leg come
 * from the landed policy-waiver contract unchanged -- no second canonicaliser, hash or
 * fold, and no separate burn: `burnStepUpAuthRef` commits on its own, which would leave
 * a refused waiver with a spent step-up. The marker travels as a LEG inside the waiver's
 * own decision, so refusal, conflict and replay write neither and no success is reusable.
 */

export const POLICY_WAIVER_DECISION_KIND = "SOFT_POLICY_WAIVER" as const;

export const POLICY_WAIVER_OUTER_KEYS = Object.freeze(["command"] as const);
export const POLICY_WAIVER_GRANT_KEYS = Object.freeze([
  "actionKind", "decisionKind", "decisionReason", "expiresAt",
  "namedObligationId", "operation", "policyRevisionRef", "scope",
] as const);
export const POLICY_WAIVER_REVOKE_KEYS = Object.freeze([
  "actionKind", "decisionKind", "decisionReason",
  "namedObligationId", "operation", "policyRevisionRef", "scope",
] as const);
export const POLICY_WAIVER_OPERATIONS = Object.freeze(["GRANT", "REVOKE"] as const);

/** This branch's OWN refusals. Every other code it can answer with belongs to the landed
 *  contract, the replay ledger or the store, and travels back unrestamped. */
export const POLICY_WAIVER_BRANCH_CODES = Object.freeze([
  "POLICY_WAIVER_PAYLOAD_INVALID", "POLICY_WAIVER_HUMAN_REQUIRED",
  "POLICY_WAIVER_ADMIN_REQUIRED",
] as const);

/** Domain separation for the replay frame. Deliberately NOT the run-scoped
 *  `approval.decide_intent` tag: these are different acts on different aggregates. And an
 *  approval is not a session rotation, so the generation slot sits at the frame's floor. */
const REPLAY_TAG = `approval.decide/${POLICY_WAIVER_DECISION_KIND}` as const;
const NO_GENERATION = 0;
const COMMAND_KIND = REPLAY_TAG;
const ADMIN_CAPABILITY = "project.admin";
const DAY_MS = 86_400_000;

export type PolicyWaiverOperation = (typeof POLICY_WAIVER_OPERATIONS)[number];

export interface PolicyWaiverCommandInput {
  readonly capabilities: readonly string[]; readonly commandId: string;
  readonly correlationId: string; readonly decidedAt: string;
  readonly expectedVersion: number; readonly operatorPrincipalId: string;
  readonly payload: unknown; readonly principalId: string;
  readonly projectId: string; readonly store: SqliteEventStore;
}

type BranchCode = (typeof POLICY_WAIVER_BRANCH_CODES)[number];
type SemanticValue = Parameters<typeof buildPolicyWaiverLeg>[1]["value"];

function refuse(code: BranchCode, detail: string, httpStatus = 422): never {
  throw new DomainRefusal(code, DAEMON_POLICY_WAIVER, detail, httpStatus);
}

/** The registry's routing test. Reads ONE nested field and nothing else, so it can never
 *  claim a legacy payload; a malformed payload that still spells the discriminator IS
 *  claimed, because refusing it is this branch's job, not the operator fence's. */
export function isPolicyWaiverDecideCandidate(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const command = (payload as { command?: unknown }).command;
  return typeof command === "object" && command !== null
    && (command as { decisionKind?: unknown }).decisionKind === POLICY_WAIVER_DECISION_KIND;
}

/** `Date.parse` round-trips only canonical UTC instants, so this is byte equality. */
function canonicalExpiryMs(value: unknown, decidedAtMs: number): number | null {
  if (typeof value !== "string") return null;
  const epochMs = Date.parse(value);
  if (!Number.isSafeInteger(epochMs) || new Date(epochMs).toISOString() !== value) return null;
  return epochMs > decidedAtMs && epochMs <= decidedAtMs + DAY_MS ? epochMs : null;
}

interface DecodedCommand {
  readonly expiresAtEpochMs: number | null; readonly operation: PolicyWaiverOperation;
  readonly raw: Record<string, unknown>;
}

/** Exact outer shape, then the exact inner shape for the operation the command names.
 *  The rosters differ in arity, so a GRANT body wearing `operation: "REVOKE"` is refused
 *  by the key set rather than silently trimmed to fit. */
function decodeCommand(payload: unknown, decidedAtMs: number): DecodedCommand | null {
  const outer = snapshotPolicyWaiverFields(payload, POLICY_WAIVER_OUTER_KEYS);
  if (outer === null) return null;
  const grant = snapshotPolicyWaiverFields(outer["command"], POLICY_WAIVER_GRANT_KEYS);
  const raw = grant ?? snapshotPolicyWaiverFields(outer["command"], POLICY_WAIVER_REVOKE_KEYS);
  if (raw === null || raw["decisionKind"] !== POLICY_WAIVER_DECISION_KIND) return null;
  if (raw["operation"] !== (grant === null ? "REVOKE" : "GRANT")) return null;
  if (grant === null) return { expiresAtEpochMs: null, operation: "REVOKE", raw };
  const expiresAtEpochMs = canonicalExpiryMs(raw["expiresAt"], decidedAtMs);
  return expiresAtEpochMs === null ? null : { expiresAtEpochMs, operation: "GRANT", raw };
}

/** Exactly the landed leg builder's own key roster, with every authority fact taken from
 *  the authenticated request rather than from the payload. */
function semanticValue(
  input: PolicyWaiverCommandInput, decoded: DecodedCommand, stepUpAuthRef: string,
): SemanticValue {
  const value: Record<string, unknown> = {
    actionKind: decoded.raw["actionKind"], approvedAt: input.decidedAt,
    approvedBy: input.principalId, commandId: input.commandId,
    decisionReason: decoded.raw["decisionReason"],
    namedObligationId: decoded.raw["namedObligationId"],
    policyRevisionRef: decoded.raw["policyRevisionRef"], projectId: input.projectId,
    scope: decoded.raw["scope"], stepUpAuthRef,
  };
  if (decoded.expiresAtEpochMs !== null) value["expiresAtEpochMs"] = decoded.expiresAtEpochMs;
  return value as unknown as SemanticValue;
}

/** The one-use step-up reference. PURE: the same authenticated request always derives the
 *  same 64-hex digest, which is what lets the marker leg detect a second use. Every
 *  operand is a server fact -- the witness's transport, plus the landed aggregate and
 *  tuple identities of the waiver decided. `deriveStepUpAuthRef` is deliberately unused:
 *  its nonce is the run-scoped intent tag, which names no waiver at all. */
function stepUpRefFor(input: PolicyWaiverCommandInput, value: SemanticValue): string {
  const identity = value as unknown as Parameters<typeof policyWaiverTupleKeyFor>[0];
  const nonce = `${REPLAY_TAG}/${policyWaiverAggregateIdFor(identity)}`
    + `/${policyWaiverTupleKeyFor(identity)}`;
  // The mint always carries its transport; the optional type belongs to the shared
  // handler context, and these fallbacks restate the mint's own two arguments.
  const { transport } = humanReviewWitness(input.principalId, input.commandId);
  return sessionReplayDigest({
    clientKeyId: transport?.commandId ?? input.commandId,
    generation: NO_GENERATION,
    nonce,
    sessionId: transport?.sessionRef ?? input.principalId,
  });
}

function decisionOf(
  record: CommandDecisionRecord, disposition: "DECIDED" | "REPLAYED",
): DurableDecision {
  return Object.freeze({ commandId: record.key.commandId, disposition,
    effectId: record.decisionId, resultCode: record.resultCode });
}

/** The durable decision this exact command already produced, if any. Answered BEFORE the
 *  fold, so an honest retry whose aggregate has since advanced still replays; the digest
 *  is recomputed from the STORED decision's own fence, so the resubmitted bytes are the
 *  only free variable and a match is byte equality. */
function priorDecision(
  store: SqliteEventStore, key: CommandDecisionKey, requestBytes: Uint8Array,
): DurableDecision | null {
  const existing = store.getCommandDecision(key);
  if (existing === null) return null;
  if (existing.commandKind === COMMAND_KIND
    && existing.effectDisposition === "EFFECTS_COMMITTED"
    && identifyReplayRequest(existing, requestBytes) === existing.replayRequestSha256) {
    return decisionOf(existing, "REPLAYED");
  }
  throw new DomainRefusal("IDEMPOTENCY_CONFLICT", "DURABLE_STORE",
    "same command identity with different request bytes", 409);
}

/** Which leg lost. Both fence on expected version and the store reports ONE
 *  `EXPECTED_VERSION_CONFLICT` for the decision as a whole, so the marker aggregate is
 *  re-read: a marker already present means this step-up was spent, anything else means
 *  the waiver moved under us. Neither wrote -- the commit is one transaction. */
function conflictRefusal(store: SqliteEventStore, stepUpAuthRef: string): never {
  if (store.readEvents(replayAggregateId(stepUpAuthRef)).length > 0) {
    throw new DomainRefusal("SESSION_REPLAYED", "REPLAY",
      "this step-up reference was already spent", 409);
  }
  throw new DomainRefusal("POLICY_WAIVER_EXPECTED_VERSION_CONFLICT", DAEMON_POLICY_WAIVER,
    "the waiver aggregate advanced under this decision", 409);
}

function commit(
  input: PolicyWaiverCommandInput, key: CommandDecisionKey, requestBytes: Uint8Array,
  legs: readonly ExpectedVersionDecisionLeg[], resultFacts: Record<string, unknown>,
  stepUpAuthRef: string,
): DurableDecision {
  // A thrown store fault travels UNRESTAMPED to the decision port's `refusalFor`, which
  // already answers IdempotencyConflictError 409 and every other DurableStoreError 503
  // under DURABLE_STORE. Catching it here would only restate that table, and the first
  // draft of this module restated it WRONG -- flattening the 409 conflict family to 503.
  const response = input.store.commitExpectedVersionDecisionLegs({
    commandKind: COMMAND_KIND, committedResultBytes: jsonBytes(resultFacts),
    correlationId: input.correlationId, decidedAt: input.decidedAt, key, legs, requestBytes,
  });
  if (response.decision.effectDisposition === "EFFECTS_COMMITTED") {
    return decisionOf(response.decision, response.disposition);
  }
  conflictRefusal(input.store, stepUpAuthRef);
}

/** Decides one authenticated `SOFT_POLICY_WAIVER` command, or throws the refusal of
 *  whichever layer answered. The order is load-bearing: shape before authority, authority
 *  before any store read, command identity before the fold, and exactly one commit. */
export function runPolicyWaiverDecideCommand(input: PolicyWaiverCommandInput): DurableDecision {
  const decidedAtMs = Date.parse(input.decidedAt);
  const decoded = Number.isSafeInteger(decidedAtMs)
    ? decodeCommand(input.payload, decidedAtMs) : null;
  if (decoded === null) refuse("POLICY_WAIVER_PAYLOAD_INVALID", "this is not a policy waiver");
  if (!input.capabilities.includes(ADMIN_CAPABILITY)) {
    refuse("POLICY_WAIVER_ADMIN_REQUIRED", "a policy waiver requires project.admin", 403);
  }
  if (input.principalId !== input.operatorPrincipalId
    && !isDurableHumanPrincipal(input.store, input.principalId)) {
    refuse("POLICY_WAIVER_HUMAN_REQUIRED", "a policy waiver requires a human principal", 403);
  }
  const stepUpAuthRef = stepUpRefFor(input, semanticValue(input, decoded, ""));
  const value = semanticValue(input, decoded, stepUpAuthRef);
  const key: CommandDecisionKey = { commandId: input.commandId,
    principalId: input.principalId, projectId: input.projectId };
  const requestBytes = jsonBytes({ ...value, correlationId: input.correlationId,
    expectedVersion: input.expectedVersion, kind: COMMAND_KIND, operation: decoded.operation });
  const replayed = priorDecision(input.store, key, requestBytes);
  if (replayed !== null) return replayed;
  const built = buildPolicyWaiverLeg(input.store,
    { expectedVersion: input.expectedVersion, kind: decoded.operation, value } as
      Parameters<typeof buildPolicyWaiverLeg>[1]);
  if (!built.ok) throw new DomainRefusal(built.code, built.layer, built.code, 409);
  const marker = buildReplayMarkerDecisionLeg({ decidedAt: input.decidedAt,
    principalId: input.principalId, projectId: input.projectId, replayDigest: stepUpAuthRef });
  if (marker === null) {
    throw new DomainRefusal("AUTHENTICATION_FAILED", "REPLAY",
      "the step-up reference is unusable", 422);
  }
  const waiverLeg = built.leg;
  return commit(input, key, requestBytes, [waiverLeg, marker.leg],
    { aggregateId: waiverLeg.aggregateId, eventId: waiverLeg.events[0]?.eventId ?? "",
      operation: decoded.operation, replayDigest: stepUpAuthRef }, stepUpAuthRef);
}
