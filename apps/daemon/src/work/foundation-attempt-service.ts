/**
 * Durable Claude attempt dispatch: the single-node work path that turns one
 * server-assembled activation into one physical Claude launch and one immutable
 * advisory record.
 *
 * THE ORDER IS THE CONTRACT. Request shape, graph, sealed input tree and the
 * durable binding are decided BEFORE the activation commits; the activation
 * commits BEFORE the dispatch reservation; the reservation commits BEFORE the
 * first physical launch. A caller whose activation commit fails caused no
 * launch, because there was nothing yet to launch from.
 *
 * WHY A SEPARATE RESERVATION. Activation and the launch-authority transitions
 * are both idempotent: two concurrent identical deliveries can BOTH be answered
 * REPLAYED with the same durable bytes, so neither is a single-invocation fence.
 * The expected-version-0 reservation on this service's own aggregate is. Only a
 * FRESH commit may launch; a replayed caller adopts the stored final record or
 * reports the dispatch in progress. A reservation with no final record after a
 * restart is evidence a launch MAY have begun — never permission to start one.
 *
 * NOTHING HERE MANUFACTURES AUTHORITY. Effect, attempt and one-use grant are
 * read back out of the committed activation; the claim is the one the activation
 * admitted; the runtime is observed freshly by the runner; `priorRegistration`
 * is always null, because a persisted PREFLIGHT is a reservation and only a
 * PROCESS_OBSERVED registration is process authority.
 */

import { buildInputManifest, buildResultManifest } from "@moe/runner";
import type { ClaudeLaunchOptions, ClaudeLaunchResult } from "@moe/runner";
import type { CommandDecisionResponse, SqliteEventStore, StoredEvent } from "@moe/store";

import { decodeActivationRequestBytes } from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { createFoundationClaudeLauncher } from "../activation/foundation-launch-authority.js";
import {
  CAPTURE_KEYS, CLAIM_KEYS, DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_DISPATCH_COMMAND_KIND,
  FOUNDATION_DISPATCH_EVENT_TYPES, FOUNDATION_RESERVATION_VERSION, RUNNER_WORKSPACE_LAYER,
  admitSingleExecutionNode, attemptRecordBody, decodeFoundationAttemptRequest,
  decodeFoundationPayload, deriveDispatchAggregateId, encodeFoundationPayload,
  exactKeys, foundationAttemptRefusal, isRecord, launchRequestBody, refuseLocal, sameBytes,
  sha256Hex, textOf,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptBound, FoundationAttemptRecordParts, FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";

export interface FoundationAttemptRecordAnswer {
  readonly advisoryOnly: true; readonly authority: "ADVISORY_RECORD"; readonly digest: string;
  readonly ok: true; readonly record: Record<string, unknown>;
}
export type FoundationAttemptOutcome = FoundationAttemptRecordAnswer | FoundationAttemptRefused;

/** The two boundaries a test may replace — the physical launch and the physical
 *  post-launch workspace observation. Every decision above them stays production. */
export interface FoundationAttemptDeps {
  captureResult(input: Record<string, unknown>): unknown;
  readonly launch?: (value: unknown, options?: ClaudeLaunchOptions) => Promise<ClaudeLaunchResult>;
  readonly launchOptions?: ClaudeLaunchOptions;
  readonly store: SqliteEventStore;
}

const isRefusal = (value: object): value is FoundationAttemptRefused =>
  "ok" in value && (value as { readonly ok: unknown }).ok === false;

/** The activation this dispatch binds to, read back FROM THE STORE — never from
 *  the caller's copy and never from the command result the caller received. */
function durableActivation(
  store: SqliteEventStore, bound: FoundationAttemptBound,
): ActivationLedgerRecord | FoundationAttemptRefused {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(bound.aggregateId);
  } catch {
    return refuseLocal("FOUNDATION_ATTEMPT_ACTIVATION_UNREADABLE");
  }
  const history = readFoundationActivationHistory(bound.aggregateId, events, bound.projectId);
  if (!history.ok) {
    const { result } = history;
    return result.status === "BOUND" ? refuseLocal("FOUNDATION_ATTEMPT_ACTIVATION_UNREADABLE")
      : foundationAttemptRefusal(result.code, result.layer);
  }
  const { record } = history.history;
  return record.lease.ownerSessionRef === bound.sessionId
    && bound.claim["intentId"] === record.effectIntent.intentId
    && bound.claim["wrapperIdentity"] === record.grant.wrapperIdentity
    ? record : refuseLocal("FOUNDATION_ATTEMPT_BINDING_MISMATCH");
}

function commitPhase(
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
  } catch {
    return null;
  }
}

/** The stored final record, re-decoded and byte-checked. A caller's candidate is
 *  never echoed back as though the store had confirmed it. */
function storedRecord(
  store: SqliteEventStore, target: string,
): FoundationAttemptRecordAnswer | FoundationAttemptRefused {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(target);
  } catch {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
  }
  const found = events.filter((e) => e.eventType === FOUNDATION_DISPATCH_EVENT_TYPES.RECORDED);
  if (found.length > 1) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
  const event = found[0];
  if (event === undefined) return refuseLocal("FOUNDATION_ATTEMPT_RECORD_ABSENT");
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return decoded;
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) {
    return refuseLocal("FOUNDATION_ATTEMPT_RECORD_DRIFT");
  }
  return Object.freeze({
    advisoryOnly: true as const, authority: "ADVISORY_RECORD" as const, digest: again.digest,
    ok: true as const, record: Object.freeze(decoded.value),
  });
}

/** Callers name the ACTIVATION aggregate; the dispatch aggregate it derives is
 *  this module's own and is never accepted from outside. */
export function readFoundationAttemptRecord(
  store: SqliteEventStore, attemptAggregateId: string,
): FoundationAttemptRecordAnswer | FoundationAttemptRefused {
  return typeof attemptAggregateId === "string" && attemptAggregateId.length > 0
    ? storedRecord(store, deriveDispatchAggregateId(attemptAggregateId))
    : refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
}

/**
 * Invocation AND interpretation share one containment. A thenable that is not a
 * NATIVE promise is never awaited — awaiting it would hand control to whoever
 * wrote `then`. The launch port must answer with a promise; the capture port may
 * answer synchronously, and a plain record is the only sync answer taken.
 */
async function contained(call: () => unknown, requirePromise: boolean): Promise<unknown> {
  try {
    const pending = call();
    if (pending instanceof Promise) return await pending;
    return requirePromise || !isRecord(pending) ? null : pending;
  } catch {
    return null;
  }
}

export function createFoundationAttemptService(deps: FoundationAttemptDeps): {
  dispatch(input: unknown): Promise<FoundationAttemptOutcome>;
} {
  const { store } = deps;

  function settle(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, parts: FoundationAttemptRecordParts,
    refusal: FoundationAttemptRefused | null,
  ): FoundationAttemptOutcome {
    const encoded = encodeFoundationPayload(attemptRecordBody(bound, record, input, parts));
    if (!encoded.ok) return encoded;
    const written = commitPhase(
      store, bound, "RECORDED", encoded.bytes, 1, `${record.grant.grantId}:RECORDED`);
    if (written === null || written.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
    }
    const stored = storedRecord(store, bound.target);
    return !stored.ok ? stored : refusal ?? stored;
  }

  /** PROVEN launch only: capture, then the runner's own result-manifest builder
   *  over the input manifest THIS service sealed. Nothing else may supply one. */
  async function capture(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, observation: unknown, registration: unknown,
  ): Promise<FoundationAttemptOutcome> {
    const base = { observation, registration, truthClass: "UNKNOWN" as const };
    const answer = exactKeys(await contained(() => deps.captureResult({
      attemptId: record.attempt.attemptId, baseIdentity: input["baseIdentity"] as string,
      nodeKey: bound.nodeKey, observation, sessionId: bound.sessionId,
    }), false), CAPTURE_KEYS);
    if (answer === null) {
      const code = "FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN";
      return settle(bound, record, input, {
        ...base, reasonCode: code, reasonLayer: DAEMON_FOUNDATION_ATTEMPT, resultManifest: null,
      }, refuseLocal(code));
    }
    const built = buildResultManifest({
      authoredPaths: answer["authoredPaths"] as never, inputManifest: input as never,
      declaredArtifactRefs: answer["declaredArtifactRefs"] as never,
      resultTreeEntries: answer["resultTreeEntries"] as never,
      scopeObservation: answer["scopeObservation"] as never,
    });
    if (!built.ok) {
      return settle(bound, record, input, {
        ...base, reasonCode: built.code, reasonLayer: RUNNER_WORKSPACE_LAYER, resultManifest: null,
      }, foundationAttemptRefusal(built.code, RUNNER_WORKSPACE_LAYER));
    }
    return settle(bound, record, input, {
      observation, reasonCode: null, reasonLayer: null, registration,
      resultManifest: built.manifest as unknown as Record<string, unknown>, truthClass: "PROVEN",
    }, null);
  }

  /** Not PROVEN: persist the honest advisory fact under the runner's own code and
   *  layer, then refuse with the same pair. No result manifest is ever built. */
  function unproven(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, result: Record<string, unknown> | null,
  ): FoundationAttemptOutcome {
    const code = textOf(result, "code") ?? "FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN";
    const layer = textOf(result, "layer") ?? DAEMON_FOUNDATION_ATTEMPT;
    return settle(bound, record, input, {
      observation: result?.["observation"] ?? null, reasonCode: code, reasonLayer: layer,
      registration: result?.["registration"] ?? null, resultManifest: null,
      truthClass: result?.["truthClass"] === "UNSUPPORTED" ? "UNKNOWN" : "SUSPECT",
    }, foundationAttemptRefusal(code, layer));
  }

  async function dispatch(input: unknown): Promise<FoundationAttemptOutcome> {
    const decoded = decodeFoundationAttemptRequest(input);
    if (!decoded.ok) return decoded;
    const { request } = decoded;
    const nodeKey = admitSingleExecutionNode(request);
    if (typeof nodeKey !== "string") return nodeKey;
    const sealed = buildInputManifest({
      baseIdentity: request.inputManifest.baseIdentity,
      entries: request.inputManifest.entries as never,
    });
    if (!sealed.ok) return foundationAttemptRefusal(sealed.code, RUNNER_WORKSPACE_LAYER);
    const envelope = decodeActivationRequestBytes(request.activationRequestBytes);
    if (!envelope.ok) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
    const section = envelope.request.payload["activation"];
    const claim = exactKeys(isRecord(section) ? section["claim"] : null, CLAIM_KEYS);
    if (claim === null) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
    const activation = runEffectActivateCommand(store, request.activationRequestBytes);
    if (!activation.ok) return foundationAttemptRefusal(activation.code, activation.refusedBy);
    const { commandId, correlationId, principalId, projectId } = envelope.request;
    const bound: FoundationAttemptBound = Object.freeze({
      aggregateId: request.binding.attemptAggregateId, claim, commandId, correlationId, nodeKey,
      principalId, projectId, sessionId: request.binding.sessionId,
      target: deriveDispatchAggregateId(request.binding.attemptAggregateId),
    });
    const record = durableActivation(store, bound);
    if (isRefusal(record)) return record;
    const reservation = encodeFoundationPayload({
      activationDigest: record.activationDigest, attemptAggregateId: bound.aggregateId,
      attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey,
      recordVersion: FOUNDATION_RESERVATION_VERSION,
      requestDigest: sha256Hex(request.activationRequestBytes), sessionId: bound.sessionId,
    });
    if (!reservation.ok) return reservation;
    const reserved = commitPhase(
      store, bound, "RESERVED", reservation.bytes, 0, `${record.grant.grantId}:RESERVED`);
    if (reserved === null || reserved.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refuseLocal("FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE");
    }
    // A REPLAYED reservation NEVER launches. It adopts the durable final record
    // or says the dispatch is still in flight; a missing record is not an
    // invitation to start a second process.
    if (reserved.disposition === "REPLAYED") {
      const adopted = storedRecord(store, bound.target);
      return adopted.ok || adopted.code !== "FOUNDATION_ATTEMPT_RECORD_ABSENT" ? adopted
        : refuseLocal("FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS");
    }
    const launch = deps.launch ?? createFoundationClaudeLauncher({
      aggregateId: bound.aggregateId, correlationId, key: { commandId, principalId, projectId },
      projectId, store,
    });
    const result = await contained(
      () => launch(launchRequestBody(record, bound, request.launchTemplate), deps.launchOptions),
      true);
    const manifest = sealed.manifest as unknown as Record<string, unknown>;
    if (!isRecord(result)) return unproven(bound, record, manifest, null);
    if (result["kind"] !== "OBSERVED" || result["truthClass"] !== "PROVEN") {
      return unproven(bound, record, manifest, result);
    }
    return await capture(
      bound, record, manifest, result["observation"] ?? null, result["registration"] ?? null);
  }

  return Object.freeze({ dispatch });
}
