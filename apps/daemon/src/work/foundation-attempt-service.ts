import { buildInputManifest, createClaudeRuntimePinRequest } from "@moe/runner";
import type { ClaudeBoundLaunchResult, ClaudeLaunchOptions } from "@moe/runner";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { decodeActivationRequestBytes } from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import { commitActivationProviderRun } from "../activation/activation-run-commit.js";
import { launchActivationProviderRun } from "../activation/activation-telemetry-launch.js";
import { createFoundationLauncherAuthority } from "../activation/foundation-launch-authority.js";
import {
  CLAIM_KEYS, DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_RESERVATION_VERSION,
  RUNNER_WORKSPACE_LAYER, admitSingleExecutionNode, decodeFoundationAttemptRequest,
  deriveDispatchAggregateId, encodeFoundationPayload, exactKeys, foundationAttemptRefusal,
  identifyFoundationDispatch, isRecord, launchRequestBody, preActivationBindingMatches,
  refuseLocal, textOf,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound, FoundationAttemptRefused } from "./foundation-attempt-contracts.js";
import { recordAttemptRelease } from "./attempt-release-disposition.js";
import { snapshotFoundationValue } from "./foundation-attempt-codec.js";
import {
  commitFoundationPhase, readDurableFoundationObservation, readFoundationReservationDigest,
  readStoredFoundationAttempt, recordProvenFoundationAttempt, settleFoundationAttempt,
} from "./foundation-attempt-store.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-store.js";
export { readFoundationAttemptRecord } from "./foundation-attempt-store.js";
export type { FoundationAttemptOutcome, FoundationAttemptRecordAnswer } from "./foundation-attempt-store.js";

/** Composition supplies only post-launch capture; callers cannot replace the runtime
 * observer, launcher, physical boundary, or clock. */
export interface FoundationAttemptDeps {
  captureResult(input: Record<string, unknown>): unknown;
  readonly launchOptions?: { readonly platform?: string; readonly signal?: AbortSignal };
  readonly store: SqliteEventStore;
}

const isRefusal = (value: object): value is FoundationAttemptRefused =>
  "ok" in value && (value as { readonly ok: unknown }).ok === false;

/** Read the bound activation from durable history, never from the caller's copy. */
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

/** Snapshot capture answers without awaiting untrusted non-native thenables. */
async function contained(call: () => unknown): Promise<unknown> {
  try {
    const pending = call();
    return snapshotFoundationValue(pending instanceof Promise ? await pending : pending);
  } catch { return null; }
}

/** Preserve the exact runner-bound result/handoff pair; never snapshot or rebuild it. */
async function boundLaunch(
  call: () => Promise<ClaudeBoundLaunchResult>,
): Promise<ClaudeBoundLaunchResult | null> {
  try { return await call(); } catch { return null; }
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

/** Only a proven settle earns the unchanged resumable release reason. */
const SETTLE_REASONS = Object.freeze({
  PROVEN: "WORK_RELEASE_OR_PAUSE", UNPROVEN: "WORK_CANCEL",
} as const);

export function createFoundationAttemptService(deps: FoundationAttemptDeps): {
  dispatch(input: unknown): Promise<FoundationAttemptOutcome>;
} {
  const { store } = deps;

  /** No producer proves the boundary flags or handoff yet, so report them false/null.
   *  The durable effect intent is the only honest release reference. */
  function noteRelease(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    settled: FoundationAttemptOutcome,
  ): FoundationAttemptOutcome {
    recordAttemptRelease(store, bound, record, {
      disposition: null, effectsTerminal: false, handoff: null,
      intentRefs: [record.effectIntent.intentId],
      reason: settled.ok ? SETTLE_REASONS.PROVEN : SETTLE_REASONS.UNPROVEN,
      resourcesTerminal: false, safeBoundaryObserved: false,
    });
    return settled;
  }

  /** Only a proven physical observation reaches result capture. */
  async function capture(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, observation: unknown, registration: unknown,
  ): Promise<FoundationAttemptOutcome> {
    const answer = await contained(() => deps.captureResult({
      attemptId: record.attempt.attemptId, baseIdentity: input["baseIdentity"] as string,
      nodeKey: bound.nodeKey, observation, sessionId: bound.sessionId,
    }));
    return noteRelease(bound, record, recordProvenFoundationAttempt(
      store, bound, record, input, { answer, observation, registration }));
  }

  /** Persist unproven advisory truth under the upstream code/layer. */
  function unproven(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, result: Record<string, unknown> | null,
  ): FoundationAttemptOutcome {
    const code = textOf(result, "code") ?? "FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN";
    const layer = textOf(result, "layer") ?? DAEMON_FOUNDATION_ATTEMPT;
    return noteRelease(bound, record, settleFoundationAttempt(store, bound, record, input, {
      observation: result?.["observation"] ?? null, reasonCode: code, reasonLayer: layer,
      registration: result?.["registration"] ?? null, resultManifest: null,
      truthClass: result?.["truthClass"] === "UNSUPPORTED" ? "UNKNOWN" : "SUSPECT",
    }, foundationAttemptRefusal(code, layer)));
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
    // The runner mints the runtime closure and keeps its own refusal authority.
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
    // Replay adopts durable output or remains in flight; it never launches again.
    if (reserved.disposition === "REPLAYED") {
      const adopted = readStoredFoundationAttempt(store, bound.target);
      return adopted.ok || adopted.code !== "FOUNDATION_ATTEMPT_RECORD_ABSENT" ? adopted
        : refuseLocal("FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS");
    }
    // The only physical boundary, composed beside its persistence configuration.
    const authority = createFoundationLauncherAuthority({
      aggregateId: bound.aggregateId, correlationId: bound.correlationId,
      key: activation.decision.key, projectId: activation.decision.key.projectId, store,
    });
    // Server-owned, every field: the caller identifies no run, epoch or effect.
    const providerCommandId = `${bound.target}:provider-run`;
    const options = narrowLaunchOptions(deps.launchOptions);
    const launched = await boundLaunch(() => launchActivationProviderRun(authority, {
      providerRun: {
        attemptRef: record.attempt.attemptId, effectIntentId: record.effectIntent.intentId,
        epoch: record.lease.epoch, provider: "claude", runRef: bound.target,
      },
      request: launchRequestBody(record, bound, request.launchTemplate, runtime),
      ...(options === undefined ? {} : { options }),
    }));
    const manifest = sealed.manifest as unknown as Record<string, unknown>;
    if (launched === null) return unproven(bound, record, manifest, null);
    // Commit the exact bound pair for the durable lease owner; no daemon clock exists.
    const committed = commitActivationProviderRun(store, {
      clock: { observedEnd: null, observedStart: null },
      correlationId: providerCommandId, decidedAt: activation.decision.decidedAt,
      key: {
        commandId: providerCommandId, principalId: record.lease.ownerSessionRef,
        projectId: activation.decision.key.projectId,
      },
      launch: launched, requestBytes: identity.bytes,
    });
    // Whichever authority refused keeps its own code and layer.
    if (!committed.ok || !launched.ok) {
      return unproven(bound, record, manifest, committed as unknown as Record<string, unknown>);
    }
    // Settlement consumes the launcher's own untouched result.
    const observed = readDurableFoundationObservation(store, bound, record, launched.result);
    if (observed === null) {
      return unproven(bound, record, manifest, launched.result as unknown as Record<string, unknown>);
    }
    return await capture(bound, record, manifest, observed[0], observed[1]);
  }

  return Object.freeze({ dispatch });
}
