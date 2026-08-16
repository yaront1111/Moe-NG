/** Durable single-node dispatch. Binding -> activation -> reservation -> launch -> advisory. */

import {
  buildInputManifest, buildResultManifest, createClaudeRuntimePinRequest,
} from "@moe/runner";
import type { ClaudeLaunchOptions } from "@moe/runner";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { decodeActivationRequestBytes } from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { createFoundationClaudeLauncher } from "../activation/foundation-launch-authority.js";
import {
  CAPTURE_KEYS, CLAIM_KEYS, DAEMON_FOUNDATION_ATTEMPT,
  FOUNDATION_RESERVATION_VERSION, RUNNER_WORKSPACE_LAYER,
  admitSingleExecutionNode, attemptRecordBody, decodeFoundationAttemptRequest,
  deriveDispatchAggregateId, encodeFoundationPayload,
  exactKeys, foundationAttemptRefusal, identifyFoundationDispatch, isRecord,
  launchRequestBody, preActivationBindingMatches, refuseLocal, textOf,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptBound, FoundationAttemptRecordParts, FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";
import { snapshotFoundationValue } from "./foundation-attempt-codec.js";
import {
  commitFoundationPhase, readDurableFoundationObservation,
  readFoundationReservationDigest, readStoredFoundationAttempt,
} from "./foundation-attempt-store.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-store.js";
export { readFoundationAttemptRecord } from "./foundation-attempt-store.js";
export type {
  FoundationAttemptOutcome, FoundationAttemptRecordAnswer,
} from "./foundation-attempt-store.js";

/** Only post-launch workspace observation is supplied by composition. The runtime
 * filesystem, host observer and clock are NOT dependencies: @moe/runner mints them
 * from the request's three plain data fields, so no caller — test or transport —
 * can hand pinning a runtime nobody observed. The shipped launcher and its
 * physical boundary are not replaceable through this service either. */
export interface FoundationAttemptDeps {
  captureResult(input: Record<string, unknown>): unknown;
  readonly launchOptions?: { readonly platform?: string; readonly signal?: AbortSignal };
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

/**
 * Invocation AND interpretation share one containment. A thenable that is not a
 * NATIVE promise is never awaited — awaiting it would hand control to whoever
 * wrote `then`. The launch port must answer with a promise; the capture port may
 * answer synchronously, and a plain record is the only sync answer taken.
 */
async function contained(call: () => unknown, requirePromise: boolean): Promise<unknown> {
  try {
    const pending = call();
    if (pending instanceof Promise) return snapshotFoundationValue(await pending);
    return requirePromise ? null : snapshotFoundationValue(pending);
  } catch { return null; }
}

function narrowLaunchOptions(
  options: FoundationAttemptDeps["launchOptions"],
): ClaudeLaunchOptions | undefined {
  if (options === undefined) return undefined;
  return Object.freeze({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
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
    const written = commitFoundationPhase(
      store, bound, "RECORDED", encoded.bytes, 1, `${record.grant.grantId}:RECORDED`);
    if (written === null || written.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return refuseLocal("FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS");
    }
    const stored = readStoredFoundationAttempt(store, bound.target);
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
    // The runner mints the runtime closure from the request's three data fields
    // and keeps its OWN refusal code and RUNTIME layer. Nothing is written yet.
    const runtime = createClaudeRuntimePinRequest(request.launchTemplate.runtime);
    if ("ok" in runtime) return foundationAttemptRefusal(runtime.code, runtime.layer);
    const envelope = decodeActivationRequestBytes(request.activationRequestBytes);
    if (!envelope.ok) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
    const section = envelope.request.payload["activation"];
    const claim = exactKeys(isRecord(section) ? section["claim"] : null, CLAIM_KEYS);
    if (claim === null) return refuseLocal("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
    if (preActivationBindingMatches(request, envelope.request.payload) !== true) {
      return refuseLocal("FOUNDATION_ATTEMPT_BINDING_MISMATCH");
    }
    const identity = identifyFoundationDispatch(
      request, sealed.manifest as unknown as Record<string, unknown>);
    if (!identity.ok) return identity;
    const target = deriveDispatchAggregateId(request.binding.attemptAggregateId);
    const priorDigest = readFoundationReservationDigest(store, target);
    if (priorDigest !== null && priorDigest !== identity.digest) {
      return refuseLocal("FOUNDATION_ATTEMPT_REPLAY_MISMATCH");
    }
    const activation = runEffectActivateCommand(store, request.activationRequestBytes);
    if (!activation.ok) return foundationAttemptRefusal(activation.code, activation.refusedBy);
    const { commandId, correlationId, principalId, projectId } = envelope.request;
    const bound: FoundationAttemptBound = Object.freeze({
      aggregateId: request.binding.attemptAggregateId, claim, commandId, correlationId, nodeKey,
      principalId, projectId, sessionId: request.binding.sessionId,
      target,
    });
    const record = durableActivation(store, bound);
    if (isRefusal(record)) return record;
    const reservation = encodeFoundationPayload({
      activationDigest: record.activationDigest, attemptAggregateId: bound.aggregateId,
      attemptId: record.attempt.attemptId, grantId: record.grant.grantId, nodeKey,
      recordVersion: FOUNDATION_RESERVATION_VERSION,
      requestDigest: identity.digest, sessionId: bound.sessionId,
    });
    if (!reservation.ok) return reservation;
    const reserved = commitFoundationPhase(
      store, bound, "RESERVED", reservation.bytes, 0, `${record.grant.grantId}:RESERVED`);
    if (reserved === null || reserved.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      const committedDigest = readFoundationReservationDigest(store, bound.target);
      if (committedDigest !== null && committedDigest !== identity.digest) {
        return refuseLocal("FOUNDATION_ATTEMPT_REPLAY_MISMATCH");
      }
      return refuseLocal("FOUNDATION_ATTEMPT_RESERVATION_UNAVAILABLE");
    }
    // A REPLAYED reservation NEVER launches. It adopts the durable final record
    // or says the dispatch is still in flight; a missing record is not an
    // invitation to start a second process.
    if (reserved.disposition === "REPLAYED") {
      const adopted = readStoredFoundationAttempt(store, bound.target);
      return adopted.ok || adopted.code !== "FOUNDATION_ATTEMPT_RECORD_ABSENT" ? adopted
        : refuseLocal("FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS");
    }
    const launch = createFoundationClaudeLauncher({
      aggregateId: bound.aggregateId, correlationId, key: { commandId, principalId, projectId },
      projectId, store,
    });
    const result = await contained(
      () => launch(launchRequestBody(record, bound, request.launchTemplate, runtime),
        narrowLaunchOptions(deps.launchOptions)),
      true);
    const manifest = sealed.manifest as unknown as Record<string, unknown>;
    if (!isRecord(result)) return unproven(bound, record, manifest, null);
    const observed = readDurableFoundationObservation(store, bound, record, result);
    if (observed === null) return unproven(bound, record, manifest, result);
    return await capture(bound, record, manifest, observed[0], observed[1]);
  }

  return Object.freeze({ dispatch });
}
