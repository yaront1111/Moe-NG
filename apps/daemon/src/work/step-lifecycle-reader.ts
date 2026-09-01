import type { StoredEvent } from "@moe/store";

import {
  decodeFoundationPayload, encodeFoundationPayload, exactKeys, sameBytes,
} from "./foundation-attempt-codec.js";
import {
  DAEMON_STEP_LIFECYCLE, STEP_RECORD_BODY_KEYS, STEP_RECORD_VERSION,
  deriveAttemptStepAggregateId, deriveStepRef, isStepLifecycleEventType,
} from "./step-lifecycle-contracts.js";
import type {
  AttemptStepRecord, StartedStep, StepLifecycleCode,
} from "./step-lifecycle-contracts.js";

/**
 * The strict CURRENT reader for the durable per-attempt step record.
 *
 * THE READER NEVER RECONSTRUCTS. Every disagreement returns authority "NONE" with
 * an exact code and this layer's name, and no branch answers from the fields that
 * happened to parse. That matters more here than for a journal: `checkpointRef` is
 * the producer of `nextSafeAction`, a field @moe/scheduler's `ReleaseHandoff`
 * requires before it will finish a lease as RELEASED
 * (packages/scheduler/src/authority/lease-drain.ts:49,168). An unverifiable step
 * record must never become a handoff input.
 *
 * THE ROSTER IS RE-DERIVED, NOT TRUSTED. Each started step's `stepRef` is recomputed
 * through the production `deriveStepRef` over the SERVER's activation digest and the
 * step's position in the durable roster, and its recorded `ordinal` must equal that
 * position. A body whose ordinals were rewritten — or whose refs were minted by
 * anything but this daemon — is therefore unusable rather than merely wrong, which
 * is what makes "ordering is server-established" a property of the READ and not only
 * of the write.
 *
 * DRIFT AND MALFORMED ARE DIFFERENT REPAIRS. DRIFT means the latest row's BYTES are
 * no longer the canonical encoding of their own content: the durable record drifted
 * under a reader that never wrote it. MALFORMED means the row sequence or the body's
 * CONTENT disagrees with the contract. One says repair the store, the other says the
 * record is wrong.
 */

/** The exact store surface this reader needs. Every commit method is absent BY
 *  CONSTRUCTION: a reader that cannot name a write cannot perform one. */
export interface StepEventSource {
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface AttemptStepAnswer extends AttemptStepRecord {
  readonly authority: "DURABLE_STEP_RECORD";
  readonly ok: true;
}

export interface AttemptStepRefused {
  readonly authority: "NONE";
  readonly code: StepLifecycleCode;
  readonly layer: typeof DAEMON_STEP_LIFECYCLE;
  readonly ok: false;
}

export type AttemptStepResult = AttemptStepAnswer | AttemptStepRefused;

const refuse = (code: StepLifecycleCode): AttemptStepRefused => Object.freeze({
  authority: "NONE" as const, code, layer: DAEMON_STEP_LIFECYCLE, ok: false as const,
});

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const STARTED_STEP_KEYS = Object.freeze(["label", "ordinal", "stepRef"] as const);

/**
 * Zero rows is ABSENT and a throw is UNREADABLE: they demand opposite repairs, so
 * they never collapse into one code. A sequence hole or a foreign event type is
 * MALFORMED while two rows claiming one sequence is AMBIGUOUS, for the same reason.
 */
function currentEvent(
  store: StepEventSource, aggregateId: string,
): readonly StoredEvent[] | AttemptStepRefused {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(aggregateId); }
  catch { return refuse("STEP_RECORD_UNREADABLE"); }
  if (events.length === 0) return refuse("STEP_RECORD_ABSENT");
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.aggregateSequence)) return refuse("STEP_RECORD_AMBIGUOUS");
    seen.add(event.aggregateSequence);
  }
  for (const [index, event] of events.entries()) {
    if (!isStepLifecycleEventType(event.eventType) || event.aggregateSequence !== index + 1) {
      return refuse("STEP_RECORD_MALFORMED");
    }
  }
  return events;
}

/**
 * The started roster, re-derived rather than believed. `ordinal` must equal the
 * position and `stepRef` must equal what `deriveStepRef` mints for that position,
 * so no caller-chosen ordering can survive a read even if a writer admitted one.
 */
function verifiedRoster(
  value: unknown, activationDigest: string,
): readonly StartedStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: StartedStep[] = [];
  for (const [index, item] of value.entries()) {
    const step = exactKeys(item, STARTED_STEP_KEYS);
    if (step === null || !text(step["label"]) || step["ordinal"] !== index
      || step["stepRef"] !== deriveStepRef(activationDigest, index)) {
      return null;
    }
    steps.push(Object.freeze({
      label: step["label"], ordinal: index, stepRef: step["stepRef"] as string,
    }));
  }
  return Object.freeze(steps);
}

/** Completed steps must be started steps, and no step completes twice. */
function verifiedCompleted(value: unknown, started: ReadonlySet<string>): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (!text(item) || !started.has(item) || seen.has(item)) return null;
    seen.add(item);
  }
  return Object.freeze([...value] as string[]);
}

/** Decode, RE-ENCODE and byte-compare: a row whose keys were stored out of canonical
 *  order decodes cleanly and only fails the byte compare. */
function canonicalBody(event: StoredEvent): Record<string, unknown> | null {
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return null;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) return null;
  return decoded.value;
}

/**
 * The attempt-bound step record as the STORE holds it. `expectedProjectId` is checked
 * against the body's own recorded project, so a row read out of a store bound to
 * another project can never be handed on as this project's authority.
 */
export function readCurrentAttemptStepRecord(
  store: StepEventSource, activationDigest: string, expectedProjectId: string,
): AttemptStepResult {
  if (!text(activationDigest) || !text(expectedProjectId)) {
    return refuse("STEP_RECORD_UNREADABLE");
  }
  const aggregateId = deriveAttemptStepAggregateId(activationDigest);
  const events = currentEvent(store, aggregateId);
  if (!Array.isArray(events)) return events as AttemptStepRefused;
  // LATEST WINS: every command persists the WHOLE folded record, so the head row is
  // the record and the tail is history.
  const body = canonicalBody(events[events.length - 1] as StoredEvent);
  if (body === null) return refuse("STEP_RECORD_DRIFT");
  const record = exactKeys(body, STEP_RECORD_BODY_KEYS);
  if (record === null || record["recordVersion"] !== STEP_RECORD_VERSION
    || record["truthClass"] !== "DAEMON_VERIFIED"
    || record["activationDigest"] !== activationDigest
    || !text(record["attemptRef"]) || !text(record["effectId"]) || !text(record["leaseRef"])
    || !text(record["sessionId"])) {
    return refuse("STEP_RECORD_MALFORMED");
  }
  const startedSteps = verifiedRoster(record["startedSteps"], activationDigest);
  if (startedSteps === null) return refuse("STEP_RECORD_MALFORMED");
  const refs = new Set(startedSteps.map((step) => step.stepRef));
  const completedSteps = verifiedCompleted(record["completedSteps"], refs);
  const checkpointRef = record["checkpointRef"];
  if (completedSteps === null
    || !(checkpointRef === null || (text(checkpointRef) && refs.has(checkpointRef)))) {
    return refuse("STEP_RECORD_MALFORMED");
  }
  if (record["projectId"] !== expectedProjectId) return refuse("STEP_PROJECT_MISMATCH");
  // AGGREGATE-SCOPED HORIZON, re-read here beside the decode. A GLOBAL horizon check
  // would move on any unrelated write and refuse nearly every read on a busy daemon;
  // this one moves only if THIS record moved.
  let after: readonly StoredEvent[];
  try { after = store.readEvents(aggregateId); }
  catch { return refuse("STEP_RECORD_UNREADABLE"); }
  if (after.length !== events.length) return refuse("STEP_RECORD_HORIZON_MOVED");
  return Object.freeze({
    activationDigest, attemptRef: record["attemptRef"],
    authority: "DURABLE_STEP_RECORD" as const, checkpointRef, completedSteps,
    effectId: record["effectId"], leaseRef: record["leaseRef"], ok: true as const,
    sessionId: record["sessionId"], startedSteps,
  });
}
