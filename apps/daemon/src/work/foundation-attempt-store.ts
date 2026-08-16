import {
  CLAUDE_LAUNCHER_VERSION, WORKSPACE_INPUT_MANIFEST_VERSION, buildResultManifest,
} from "@moe/runner";
import type { WorkspaceInputManifest } from "@moe/runner";
import type { CommandDecisionResponse, SqliteEventStore, StoredEvent } from "@moe/store";

import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { snapshotFoundationRecord } from "../activation/foundation-activation-transition.js";
import type { FoundationTransition } from "../activation/foundation-activation-transition.js";
import {
  CAPTURE_KEYS, DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_DISPATCH_COMMAND_KIND,
  FOUNDATION_DISPATCH_EVENT_TYPES, RUNNER_WORKSPACE_LAYER, attemptRecordBody,
  decodeFoundationPayload, deriveDispatchAggregateId, encodeFoundationPayload, exactKeys,
  foundationAttemptRefusal, refuseLocal, sameBytes, textOf,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptBound, FoundationAttemptRecordParts, FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";

export interface FoundationAttemptRecordAnswer {
  readonly advisoryOnly: true; readonly authority: "ADVISORY_RECORD"; readonly digest: string;
  readonly ok: true; readonly record: Record<string, unknown>;
}
export type FoundationAttemptOutcome = FoundationAttemptRecordAnswer | FoundationAttemptRefused;

const RESULT_KEYS = Object.freeze([
  "kind", "ok", "truthClass", "code", "layer", "consumedGrant", "registration", "observation",
] as const);
const GRANT_KEYS = Object.freeze([
  "grantId", "intentId", "wrapperIdentity", "state", "version",
] as const);
const REGISTRATION_KEYS = Object.freeze([
  "lockIdentity", "wrapperIdentity", "processIdentity", "bootstrapCredentialDigest", "registeredAt",
] as const);
const OBSERVATION_KEYS = Object.freeze([
  "launcherVersion", "effectDigest", "activationDigest", "grantId", "consumedGrantDigest",
  "runtimeBindingDigest", "quotedRuntimeDigest", "freshRuntimeDigest", "pinnedClosureDigest",
  "lockIdentity", "wrapperIdentity", "processIdentity", "registrationDigest", "stdout", "stderr",
  "exit", "startedAt", "completedAt", "truthClass", "reasonCode", "reasonLayer", "observationDigest",
] as const);

function sameActivation(left: ActivationLedgerRecord, right: ActivationLedgerRecord): boolean {
  return left.activationDigest === right.activationDigest
    && left.grant.grantId === right.grant.grantId
    && left.effectIntent.intentId === right.effectIntent.intentId
    && left.attempt.attemptId === right.attempt.attemptId
    && left.grant.wrapperIdentity === right.grant.wrapperIdentity;
}

function sameConsumedGrant(value: Record<string, unknown>, record: ActivationLedgerRecord): boolean {
  return value["grantId"] === record.grant.grantId
    && value["intentId"] === record.grant.intentId
    && value["wrapperIdentity"] === record.grant.wrapperIdentity
    && value["state"] === "CONSUMED" && value["version"] === record.grant.version + 1;
}

function sameRegistration(value: Record<string, unknown>, process: FoundationTransition): boolean {
  return REGISTRATION_KEYS.every((key) => value[key] === process[key]);
}

function sameObservation(
  value: Record<string, unknown>, registration: Record<string, unknown>,
  record: ActivationLedgerRecord,
): boolean {
  return value["launcherVersion"] === CLAUDE_LAUNCHER_VERSION
    && value["truthClass"] === "PROVEN" && value["reasonCode"] === null
    && value["reasonLayer"] === null && value["activationDigest"] === record.activationDigest
    && value["grantId"] === record.grant.grantId
    && value["lockIdentity"] === registration["lockIdentity"]
    && value["wrapperIdentity"] === registration["wrapperIdentity"]
    && value["processIdentity"] === registration["processIdentity"];
}

/** A PROVEN launcher answer is usable only when the same durable aggregate now
 * carries the complete grant -> preflight -> process tail for that identity. */
export function readDurableFoundationObservation(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  value: unknown,
): readonly [unknown, unknown] | null {
  const result = snapshotFoundationRecord(value, RESULT_KEYS);
  if (result === null || result["kind"] !== "OBSERVED" || result["ok"] !== true
    || result["truthClass"] !== "PROVEN" || result["code"] !== null
    || result["layer"] !== null) return null;
  const consumedGrant = snapshotFoundationRecord(result["consumedGrant"], GRANT_KEYS);
  const registration = snapshotFoundationRecord(result["registration"], REGISTRATION_KEYS);
  const observation = snapshotFoundationRecord(result["observation"], OBSERVATION_KEYS);
  if (consumedGrant === null || registration === null || observation === null) return null;
  let events: readonly StoredEvent[];
  try { events = store.readEvents(bound.aggregateId); } catch { return null; }
  const history = readFoundationActivationHistory(bound.aggregateId, events, bound.projectId);
  if (!history.ok || history.history.transitions.length !== 3) return null;
  const durable = history.history.record;
  const [grant, preflight, process] = history.history.transitions;
  if (!sameActivation(durable, record) || grant?.tag !== "GRANT_CONSUMED"
    || preflight?.tag !== "PREFLIGHT_REGISTERED"
    || process?.tag !== "PROCESS_OBSERVED") return null;
  if (preflight.bootstrapCredentialDigest !== process.bootstrapCredentialDigest) return null;
  return sameConsumedGrant(consumedGrant, durable) && sameRegistration(registration, process)
    && sameObservation(observation, registration, durable) ? [observation, registration] : null;
}

export function commitFoundationPhase(
  store: SqliteEventStore, bound: FoundationAttemptBound, tag: "RECORDED" | "RESERVED",
  bytes: Uint8Array, expectedVersion: number, eventId: string,
): CommandDecisionResponse | null {
  const { commandId, principalId, projectId } = bound;
  try {
    return store.commitExpectedVersionDecision({
      commandKind: FOUNDATION_DISPATCH_COMMAND_KIND, committedResultBytes: bytes,
      correlationId: `${bound.correlationId}:${tag}`, decidedAt: new Date().toISOString(),
      events: [{ eventId, eventType: FOUNDATION_DISPATCH_EVENT_TYPES[tag], payload: bytes }],
      expectedVersion, key: { commandId: `${commandId}:${tag}`, principalId, projectId },
      requestBytes: bytes, targetAggregateId: bound.target,
    });
  } catch { return null; }
}

export function readFoundationReservationDigest(
  store: SqliteEventStore, target: string,
): string | null {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(target); } catch { return null; }
  const found = events.filter((event) =>
    event.eventType === FOUNDATION_DISPATCH_EVENT_TYPES.RESERVED);
  if (found.length !== 1) return null;
  const decoded = decodeFoundationPayload(found[0]?.payload);
  return decoded.ok ? textOf(decoded.value, "requestDigest") : null;
}

/** The final answer always comes from re-decoded durable bytes. */
export function readStoredFoundationAttempt(
  store: SqliteEventStore, target: string,
): FoundationAttemptOutcome {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(target); }
  catch { return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS"); }
  const found = events.filter((event) =>
    event.eventType === FOUNDATION_DISPATCH_EVENT_TYPES.RECORDED);
  if (found.length > 1) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
  const event = found[0];
  if (event === undefined) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_ABSENT");
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return decoded;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  }
  return Object.freeze({ advisoryOnly: true as const, authority: "ADVISORY_RECORD" as const,
    digest: again.digest, ok: true as const, record: Object.freeze(decoded.value) });
}

export function readFoundationAttemptRecord(
  store: SqliteEventStore, attemptAggregateId: string,
): FoundationAttemptOutcome {
  return typeof attemptAggregateId === "string" && attemptAggregateId.length > 0
    ? readStoredFoundationAttempt(store, deriveDispatchAggregateId(attemptAggregateId))
    : refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
}

/** The one writer of the single RECORDED event, whatever the outcome: compose ->
 *  encode -> commit at `expectedVersion` 1 under an event id COPIED from the
 *  grant, never minted -> answer from RE-DECODED durable bytes. The copied id is
 *  what makes a reused grant refuse on store-wide event-id uniqueness. */
export function settleFoundationAttempt(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  input: Record<string, unknown>, parts: FoundationAttemptRecordParts,
  refusal: FoundationAttemptRefused | null,
): FoundationAttemptOutcome {
  const encoded = encodeFoundationPayload(attemptRecordBody(bound, record, input, parts));
  if (!encoded.ok) return encoded;
  const written = commitFoundationPhase(
    store, bound, "RECORDED", encoded.bytes, 1, `${record.grant.grantId}:RECORDED`);
  if (written === null || written.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
  }
  const stored = readStoredFoundationAttempt(store, bound.target);
  return !stored.ok ? stored : refusal ?? stored;
}

export interface FoundationAttemptCapture {
  readonly answer: unknown; readonly observation: unknown; readonly registration: unknown;
}

/** Structural only, and deliberately so: this asks whether the record THIS
 *  daemon sealed is even the shape the runner's builder may be handed. Whether
 *  its digest still recomputes is the RUNNER's question and stays the RUNNER's
 *  to answer, so the two refusals never collapse into one code. */
const sealedInputManifest = (value: Record<string, unknown>): boolean =>
  value["manifestVersion"] === WORKSPACE_INPUT_MANIFEST_VERSION
  && typeof value["baseIdentity"] === "string" && typeof value["sha256"] === "string"
  && Array.isArray(value["entries"]);

/**
 * PROVEN launch only: the runner's OWN result-manifest builder, over the input
 * manifest this daemon sealed and the freshly observed workspace answer. The
 * observation and registration are the pair `readDurableFoundationObservation`
 * validated, never a caller's copy.
 *
 * Every refusal here still persists an honest UNKNOWN and refuses with the same
 * pair, so a reserved dispatch never ends with no durable fact at all.
 */
export function recordProvenFoundationAttempt(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  input: Record<string, unknown>, capture: FoundationAttemptCapture,
): FoundationAttemptOutcome {
  const base = {
    observation: capture.observation, registration: capture.registration,
    resultManifest: null, truthClass: "UNKNOWN" as const,
  };
  const advisory = (code: string, layer: string): FoundationAttemptOutcome =>
    settleFoundationAttempt(store, bound, record, input,
      { ...base, reasonCode: code, reasonLayer: layer },
      foundationAttemptRefusal(code, layer));
  const answer = exactKeys(capture.answer, CAPTURE_KEYS);
  if (answer === null) {
    return advisory("FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN", DAEMON_FOUNDATION_ATTEMPT);
  }
  if (!sealedInputManifest(input)) {
    return advisory("FOUNDATION_ATTEMPT_INPUT_MANIFEST_INVALID", DAEMON_FOUNDATION_ATTEMPT);
  }
  const built = buildResultManifest({
    authoredPaths: answer["authoredPaths"] as never,
    inputManifest: input as unknown as WorkspaceInputManifest,
    declaredArtifactRefs: answer["declaredArtifactRefs"] as never,
    resultTreeEntries: answer["resultTreeEntries"] as never,
    scopeObservation: answer["scopeObservation"] as never,
  });
  if (!built.ok) return advisory(built.code, RUNNER_WORKSPACE_LAYER);
  return settleFoundationAttempt(store, bound, record, input, {
    observation: capture.observation, reasonCode: null, reasonLayer: null,
    registration: capture.registration,
    resultManifest: built.manifest as unknown as Record<string, unknown>, truthClass: "PROVEN",
  }, null);
}
