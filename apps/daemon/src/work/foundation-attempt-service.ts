import { buildInputManifest, createClaudeRuntimePinRequest } from "@moe/runner";
import type { ClaudeBoundLaunchResult, ClaudeLaunchOptions } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import { decodeActivationRequestBytes } from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { commitActivationProviderRun } from "../activation/activation-run-commit.js";
import { launchActivationProviderRun } from "../activation/activation-telemetry-launch.js";
import { createFoundationLauncherAuthority } from "../activation/foundation-launch-authority.js";
import {
  CLAIM_KEYS, FOUNDATION_RESERVATION_VERSION,
  RUNNER_WORKSPACE_LAYER, admitSingleExecutionNode, decodeFoundationAttemptRequest,
  deriveDispatchAggregateId, encodeFoundationPayload, exactKeys, foundationAttemptRefusal,
  identifyFoundationDispatch, isRecord, launchRequestBody, preActivationBindingMatches,
  refuseLocal,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound, FoundationAttemptRefused } from "./foundation-attempt-contracts.js";
import type { FoundationCaptureLifecycle } from "./foundation-capture-lifecycle.js";
import type { FoundationContextSealPort } from "./foundation-context-record.js";
import {
  commitFoundationPhase, readDurableFoundationObservation, readFoundationReservationDigest,
  readStoredFoundationAttempt,
} from "./foundation-attempt-store.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-store.js";
import {
  createFoundationAttemptSettlement, durableActivation,
} from "./foundation-attempt-settlement.js";
export { readFoundationAttemptRecord } from "./foundation-attempt-store.js";
export type { FoundationAttemptOutcome, FoundationAttemptRecordAnswer } from "./foundation-attempt-store.js";

/**
 * Composition supplies post-launch capture and the prepare-before-launch
 * workspace lifecycle; callers cannot replace the runtime observer, launcher,
 * physical boundary, or clock.
 *
 * `lifecycle` is REQUIRED rather than optional on purpose: an omitted workspace
 * authority would let a dispatch launch into whatever directory a caller named,
 * and "the port was not wired" is a mistake a type can make unrepresentable
 * instead of a runtime branch nobody exercises.
 */
export interface FoundationAttemptDeps {
  captureResult(input: Record<string, unknown>): unknown;
  /**
   * The pre-launch context seal, REQUIRED for the same reason `lifecycle` is: an omitted
   * context authority would let a provider run with nothing durably recorded about the context
   * it ran on, and "the port was not wired" is a mistake a type can make unrepresentable
   * instead of a runtime branch nobody exercises. A daemon that cannot compose a real one
   * passes `unconfiguredFoundationContextSealPort()`, which refuses every seal.
   */
  readonly context: FoundationContextSealPort;
  readonly launchOptions?: { readonly platform?: string; readonly signal?: AbortSignal };
  readonly lifecycle: FoundationCaptureLifecycle;
  readonly store: SqliteEventStore;
}

const isRefusal = (value: object): value is FoundationAttemptRefused =>
  "ok" in value && (value as { readonly ok: unknown }).ok === false;

/** Preserve the exact runner-bound result/handoff pair; never snapshot or rebuild it. */
async function boundLaunch(call: () => Promise<ClaudeBoundLaunchResult>): Promise<ClaudeBoundLaunchResult | null> {
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

export function createFoundationAttemptService(deps: FoundationAttemptDeps): {
  dispatch(input: unknown): Promise<FoundationAttemptOutcome>;
} {
  const { store } = deps;

  // `noteRelease` is deliberately NOT destructured: it is settlement-internal,
  // reached only through `capture` and `unproven`. It stays on the factory's
  // frozen surface, and binding it here would be an unused local (TS6133).
  const { capture, unproven } = createFoundationAttemptSettlement(deps);

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
    // DOOR 1: the key validated at `admitSingleExecutionNode` above, handed over as a
    // daemon-internal argument. The derivation re-verifies it against the durable graph rather
    // than trusting it — this caller is inside the trust boundary, its input is not.
    const activation = runEffectActivateCommand(
      store, request.activationRequestBytes, nodeKey);
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
    const manifest = sealed.manifest as unknown as Record<string, unknown>;
    // PREPARE-BEFORE-LAUNCH. After replay discrimination and before any physical
    // boundary exists: the workspace this attempt will run in is resolved,
    // materialized, hydrated and durably sealed, or the attempt refuses here.
    const prepared = await deps.lifecycle.prepareCapture({
      attemptAggregateId: bound.aggregateId, attemptId: record.attempt.attemptId,
      nodeKey: bound.nodeKey, projectId: bound.projectId,
      proposedBaseIdentity: request.inputManifest.baseIdentity,
      proposedCwd: request.launchTemplate.cwd,
      proposedEntries: request.inputManifest.entries,
      requestDigest: identity.digest, reservationDigest: reservation.digest,
      sessionId: bound.sessionId,
    });
    if (!prepared.ok) {
      return unproven(bound, record, manifest, prepared as unknown as Record<string, unknown>);
    }
    // THE DURABLE CONTEXT DECISION, AND IT COMMITS FIRST.
    //
    // Ordering here is a SAFETY property, not bookkeeping. There is no compensating path once a
    // provider has run: a context record written afterwards could only describe what someone
    // believes happened. So the manifest is rendered, digested and durably sealed HERE - before
    // the launcher authority exists, before any process opens - or this attempt refuses and
    // nothing launches.
    //
    // It sits AFTER `prepareCapture` because the selection reads that preparation's own durable
    // capture context, and the digest must cover the bytes an actually-prepared attempt would
    // deliver. Nothing about argv, a ref or a re-render reaches the seal: the port is handed the
    // four-key identity and the activation's own decided-at, and every other fact it uses is
    // read from the server's durable world.
    const context = deps.context.sealFoundationContext({
      attemptRef: record.attempt.attemptId, nodeKey: bound.nodeKey,
      projectId: bound.projectId, sessionId: bound.sessionId,
    }, activation.decision.decidedAt);
    if (!context.ok) {
      // The seal's own code and layer, unrestamped, exactly as a preparation refusal travels.
      return unproven(bound, record, manifest, context as unknown as Record<string, unknown>);
    }
    const launchBody = launchRequestBody(record, bound, context, {
      bootstrapCredentialDigest: request.launchTemplate.bootstrapCredentialDigest,
      cwd: prepared.assignment.realWorktreePath }, runtime);
    if (isRefusal(launchBody)) return unproven(bound, record, manifest,
      launchBody as unknown as Record<string, unknown>);
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
      // THE ASSIGNMENT IS THE ROOT. `launchTemplate.cwd` reached the preparation
      // as a proposal and could only have refused there; it never selects.
      request: launchBody,
      ...(options === undefined ? {} : { options }),
    }));
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
    return await capture(
      bound, record, manifest, observed[0], observed[1], prepared,
      activation.decision.decidedAt);
  }

  return Object.freeze({ dispatch });
}
