import { IdempotencyConflictError } from "@moe/store";
import type { CommandDecisionRecord, SqliteEventStore, StoredEvent } from "@moe/store";

import {
  readCurrentEffectSessionBinding, readFoundationActivationHistory,
} from "../activation/activation-ledger-reader.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import { decodeStepRequest } from "./step-lifecycle-codec.js";
import type { StepLifecycleRequest } from "./step-lifecycle-codec.js";
import {
  STEP_CHECKPOINT_COMMAND_KIND, STEP_LIFECYCLE_EVENT_TYPES, STEP_RECORD_VERSION,
  STEP_START_COMMAND_KIND, deriveAttemptStepAggregateId, deriveStepRef, stepRefusal,
} from "./step-lifecycle-contracts.js";
import type {
  AttemptStepRecord, StepLifecycleOutcome, StepLifecycleRefused,
} from "./step-lifecycle-contracts.js";
import { readCurrentAttemptStepRecord } from "./step-lifecycle-reader.js";

/**
 * The one writer for the durable per-attempt step record: the seam that makes a
 * BETWEEN-STEP BOUNDARY a durable fact instead of an unobservable one.
 *
 * A CALLER IDENTIFIES AN ATTEMPT; IT NEVER SUPPLIES AUTHORITY. Each payload admits
 * exactly three keys, so project, session, lease, truth class, ordering index,
 * completed state and any whole-roster replacement have NO wire channel and are
 * refused STRUCTURALLY by the seam's allow-list at stage PAYLOAD_SHAPE. Everything
 * persisted here is re-derived from committed evidence:
 *   - `readCurrentEffectSessionBinding` IS the attempt/session/lease fence: intent
 *     ACTIVE, attempt RUNNING, lease parsed, ACTIVE, equal to the intent's own lease
 *     binding and not past its wall deadline, activation commit coherent. Its
 *     refusals keep ITS code and ITS layer — a stale lease must stay distinguishable
 *     from an absent attempt, and restamping destroys that.
 *   - the step aggregate is derived from the BINDING's activationDigest, so no caller
 *     can name a step stream into being; `attemptAggregateId` only LOCATES the
 *     activation record and the digest equality forbids pointing at another attempt.
 *
 * SERVER-ESTABLISHED ORDERING. `step.start` mints both the step identity and its
 * ordinal from the DURABLE APPEND COUNT — the number of steps already in the folded
 * roster — and never from anything the caller sent. `label` is opaque descriptive
 * text contributing nothing to identity or order.
 *
 * SERVER-VERIFIED CLAIMS. `truthClass` is written as the literal "DAEMON_VERIFIED"
 * here and is never read from a payload, and completed state is derived from the
 * durable fold: a reporter naming a step this attempt never started is refused
 * STEP_NOT_STARTED rather than believed.
 *
 * APPEND-ONLY. Each command commits ONE new event carrying the WHOLE folded record
 * at the current tail; no branch rewrites a prior row. A byte-identical replay
 * returns the store's REPLAYED without a second row; the same identity with
 * different bytes raises the store's own conflict, rethrown so the seam reports it
 * under DURABLE_STORE.
 */

const EMPTY_ROSTER = Object.freeze({
  checkpointRef: null, completedSteps: Object.freeze([]), startedSteps: Object.freeze([]),
}) as Pick<AttemptStepRecord, "checkpointRef" | "completedSteps" | "startedSteps">;

interface AttemptFacts {
  readonly attemptRef: string; readonly leaseRef: string;
}

/** The caller's aggregate id LOCATES; these three equalities AUTHORISE. A record that
 *  disagrees with the binding on any of them is evidence about a DIFFERENT attempt,
 *  and no field of it may reach durable bytes. */
function agreeingAttempt(
  store: SqliteEventStore, request: StepLifecycleRequest, activationDigest: string,
  sessionId: string,
): AttemptFacts | StepLifecycleRefused {
  const mismatch = stepRefusal("STEP_BINDING_MISMATCH", undefined, request.kind);
  let events: readonly StoredEvent[];
  try { events = store.readEvents(request.attemptAggregateId); } catch { return mismatch; }
  const history = readFoundationActivationHistory(
    request.attemptAggregateId, events, request.projectId);
  if (!history.ok) return mismatch;
  const { record } = history.history;
  if (record.activationDigest !== activationDigest
    || record.effectIntent.intentId !== request.effectId
    || record.lease.ownerSessionRef !== sessionId) {
    return mismatch;
  }
  return Object.freeze({ attemptRef: record.attempt.attemptId, leaseRef: record.lease.leaseId });
}

const isRefusal = (value: unknown): value is StepLifecycleRefused =>
  typeof value === "object" && value !== null && "ok" in value && !(value as { ok: unknown }).ok;

type Roster = Pick<AttemptStepRecord, "checkpointRef" | "completedSteps" | "startedSteps">;

/**
 * The next roster, folded onto the durable one. ORDERING IS THE APPEND COUNT: the new
 * step's ordinal is `startedSteps.length` and its ref is minted from it, so a caller
 * cannot express an ordering even if a future payload key tried to carry one.
 */
export function applyStepTransition(
  request: StepLifecycleRequest, prior: Roster, activationDigest: string,
): Roster | StepLifecycleRefused {
  if (request.kind === STEP_START_COMMAND_KIND) {
    const ordinal = prior.startedSteps.length;
    return Object.freeze({
      ...prior,
      startedSteps: Object.freeze([...prior.startedSteps, Object.freeze({
        label: request.label, ordinal, stepRef: deriveStepRef(activationDigest, ordinal),
      })]),
    });
  }
  const roster = new Set(prior.startedSteps.map((step) => step.stepRef));
  if (request.kind === STEP_CHECKPOINT_COMMAND_KIND) {
    // DoD 4, AND task rail 2. The ref must ALREADY be in the durable roster, so this
    // field structurally cannot name a step that does not exist — and a COMMAND KIND
    // such as `work.resume` is not a step identity and is refused by this same guard.
    // The consumer (task-d9842aae) parses this as the handoff's `nextSafeAction`; a
    // fixture literal or a project-wide affordance standing in for it is exactly the
    // substitution that blocked it.
    return roster.has(request.nextSafeActionRef)
      ? Object.freeze({ ...prior, checkpointRef: request.nextSafeActionRef })
      : stepRefusal("STEP_CHECKPOINT_TARGET_UNKNOWN", undefined, request.kind);
  }
  if (!roster.has(request.stepRef)) {
    return stepRefusal("STEP_NOT_STARTED", undefined, request.kind);
  }
  if (prior.completedSteps.includes(request.stepRef)) {
    return stepRefusal("STEP_ALREADY_FINISHED", undefined, request.kind);
  }
  return Object.freeze({
    ...prior, completedSteps: Object.freeze([...prior.completedSteps, request.stepRef]),
  });
}

/**
 * Decode -> bind -> agree -> fold onto the durable record -> commit ONE event. Every
 * stage keeps the refusing layer's own code, and no branch answers from the value
 * just written.
 */
export function runStepLifecycleCommand(
  store: SqliteEventStore, input: unknown,
): StepLifecycleOutcome {
  // Guarded HERE as well as in the codec, so `input` is provably the request bytes by
  // the time `commitStep` hashes them for the store's identity. The codec's own check
  // would make that a cast across a module boundary, which a later edit could silently
  // drop while every test stayed green.
  if (!(input instanceof Uint8Array)) return stepRefusal("STEP_REQUEST_MALFORMED");
  const request = decodeStepRequest(input);
  if (isRefusal(request)) return request;
  const binding = readCurrentEffectSessionBinding(
    store, request.projectId, request.effectId, request.principalId,
    Date.parse(request.decidedAt));
  if (binding.status !== "BOUND") {
    return stepRefusal(binding.code, binding.layer, request.kind);
  }
  // The BINDING's OWN values: it answers `effectId` as the COMMITTED intentId and
  // uses the caller's string for equality only, so no caller-supplied string reaches
  // the durable body at all.
  const { activationDigest, effectId, sessionId } = binding;
  const facts = agreeingAttempt(store, request, activationDigest, sessionId);
  if (isRefusal(facts)) return facts;
  // ABSENT is the empty roster HERE and only here — the first step on an attempt that
  // has none. Every other refusal propagates unchanged, because an unreadable history
  // must never be folded onto as if it were empty.
  const current = readCurrentAttemptStepRecord(store, activationDigest, request.projectId);
  if (!current.ok && current.code !== "STEP_RECORD_ABSENT") {
    return stepRefusal(current.code, current.layer, request.kind);
  }
  const next = applyStepTransition(request, current.ok ? current : EMPTY_ROSTER,
    activationDigest);
  if (isRefusal(next)) return next;
  const encoded = encodeFoundationPayload({
    activationDigest, attemptRef: facts.attemptRef, checkpointRef: next.checkpointRef,
    completedSteps: next.completedSteps, effectId, leaseRef: facts.leaseRef,
    projectId: request.projectId, recordVersion: STEP_RECORD_VERSION, sessionId,
    startedSteps: next.startedSteps, truthClass: "DAEMON_VERIFIED",
  });
  if (!encoded.ok) return stepRefusal("STEP_RECORD_MALFORMED", undefined, request.kind);
  return commitStep(store, request, activationDigest, encoded.bytes, input);
}

function commitStep(
  store: SqliteEventStore, request: StepLifecycleRequest, activationDigest: string,
  payload: Uint8Array, requestBytes: Uint8Array,
): StepLifecycleOutcome {
  const unavailable = stepRefusal("STEP_COMMIT_UNAVAILABLE", undefined, request.kind);
  const targetAggregateId = deriveAttemptStepAggregateId(activationDigest);
  const { commandId, correlationId, decidedAt, kind, principalId, projectId } = request;
  const eventType = STEP_LIFECYCLE_EVENT_TYPES[kind];
  const key = { commandId, principalId, projectId };
  let existing: readonly StoredEvent[];
  let prior: CommandDecisionRecord | null;
  try {
    existing = store.readEvents(targetAggregateId);
    prior = store.getCommandDecision(key);
  } catch { return unavailable; }
  // THE REPLAY'S expectedVersion IS THE ORIGINAL'S, NOT TODAY'S TAIL.
  // `identifyExpectedVersionRequest` hashes expectedVersion alongside the request
  // bytes (packages/store/src/store-digests.ts:92), so re-deriving it from a tail this
  // very command already moved would make a byte-identical retry hash DIFFERENTLY and
  // come back as an idempotency conflict instead of a replay. Reusing the recorded
  // value keeps the STORE the sole authority on identity.
  const expectedVersion = prior === null ? existing.length : prior.expectedVersion;
  try {
    const written = store.commitExpectedVersionDecision({
      commandKind: kind, committedResultBytes: payload, correlationId, decidedAt,
      events: [{ eventId: `${commandId}:${eventType}`, eventType, payload }],
      // APPEND-ONLY: the tail as it stands now, so a racing second command on this
      // attempt loses its version check rather than both landing.
      expectedVersion,
      key, requestBytes, targetAggregateId,
    });
    if (written.decision.effectDisposition !== "EFFECTS_COMMITTED") return unavailable;
    return Object.freeze({
      advisoryOnly: false as const, authority: "DURABLE_DECISION" as const,
      decision: written.decision, disposition: written.disposition, kind, ok: true as const,
    });
  } catch (error) {
    // The store's idempotency conflict keeps its OWN code and DURABLE_STORE layer:
    // flattening it into a step code would hide that one command identity carried two
    // different sets of bytes.
    if (error instanceof IdempotencyConflictError) throw error;
    return unavailable;
  }
}
