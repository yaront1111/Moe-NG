import { CLAUDE_LAUNCHER_VERSION } from "@moe/runner";
import type { CommandDecisionResponse, SqliteEventStore, StoredEvent } from "@moe/store";

import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { snapshotFoundationRecord } from "../activation/foundation-activation-transition.js";
import type { FoundationTransition } from "../activation/foundation-activation-transition.js";
import {
  FOUNDATION_DISPATCH_COMMAND_KIND, FOUNDATION_DISPATCH_EVENT_TYPES,
  decodeFoundationPayload, deriveDispatchAggregateId, encodeFoundationPayload,
  refuseLocal, sameBytes, textOf,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptBound, FoundationAttemptRefused,
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
