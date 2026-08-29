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
  CLAIM_KEYS, FOUNDATION_RESERVATION_VERSION,
  RUNNER_WORKSPACE_LAYER, admitSingleExecutionNode, decodeFoundationAttemptRequest,
  deriveDispatchAggregateId, encodeFoundationPayload, exactKeys, foundationAttemptRefusal,
  identifyFoundationDispatch, isRecord, launchRequestBody, preActivationBindingMatches,
  refuseLocal,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound, FoundationAttemptRefused } from "./foundation-attempt-contracts.js";
import { applyProviderUsageToBudget } from "../budget/budget-settlement-application.js";
import { recordAttemptRelease } from "./attempt-release-disposition.js";
import type { FoundationCaptureLifecycle, PreparedCapture } from "./foundation-capture-lifecycle.js";
import { recordTerminalEffect } from "./effect-terminal-ledger.js";
import { snapshotFoundationValue } from "./foundation-attempt-codec.js";
import type { FoundationContextSealPort } from "./foundation-context-record.js";
import {
  commitFoundationPhase, readDurableFoundationObservation, readFoundationReservationDigest,
  readStoredFoundationAttempt, recordProvenFoundationAttempt,
} from "./foundation-attempt-store.js";
import type { FoundationAttemptOutcome } from "./foundation-attempt-store.js";
import { settleUnprovenFoundationAttempt } from "./foundation-attempt-unproven-settlement.js";
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
/** Only a proven settle earns the unchanged resumable release reason. */
const SETTLE_REASONS = Object.freeze({
  PROVEN: "WORK_RELEASE_OR_PAUSE", UNPROVEN: "WORK_CANCEL",
} as const);

export function createFoundationAttemptService(deps: FoundationAttemptDeps): {
  dispatch(input: unknown): Promise<FoundationAttemptOutcome>;
} {
  const { store } = deps;

  /** NONE of the four settle facts is ours to report any more, so none is here:
   *  `safeBoundaryObserved` comes from the durable provider-run record
   *  (task-ded026d6), the terminality pair from the terminal ledger and the
   *  resource authority (task-6d400781), and the nine-key scheduler `handoff` is
   *  now SERVER-BUILT from durable Foundation facts (task-a20e8ef6). A request
   *  carrying any of the four is refused, not obeyed — including one that merely
   *  spells `handoff`, which is why the key is absent here rather than null. */
  function noteRelease(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    settled: FoundationAttemptOutcome, reason = settled.ok
      ? SETTLE_REASONS.PROVEN
      : SETTLE_REASONS.UNPROVEN,
  ): FoundationAttemptOutcome {
    recordAttemptRelease(store, bound, record, {
      disposition: null,
      intentRefs: [record.effectIntent.intentId],
      reason,
    });
    return settled;
  }

  /** Only a proven physical observation reaches result capture. The captureRef
   *  travels here lexically, from the preparation this very dispatch made, and so
   *  does `decidedAt`: it is the ACTIVATION's own decided-at, the single durable
   *  stamp this dispatch was decided under. No daemon clock exists to read one
   *  from, and a stamp invented here would be a durable audit field asserting a
   *  time nothing observed. */
  async function capture(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, observation: unknown, registration: unknown,
    prepared: PreparedCapture, decidedAt: string,
  ): Promise<FoundationAttemptOutcome> {
    const answer = await contained(() => deps.captureResult({
      attemptId: record.attempt.attemptId, baseIdentity: input["baseIdentity"] as string,
      captureRef: prepared.captureRef, nodeKey: bound.nodeKey, observation,
      // THE PROOF TRAVELS LEXICALLY TOO, and it has to: it is not a field of the
      // durable record, re-deriving one after a launch refuses a tree the attempt
      // legitimately changed, and `sealPrelaunchProof` is withheld from
      // `@moe/runner` so no consumer may mint one. Like `captureRef` it comes from
      // the preparation THIS dispatch made, never from anything a caller sent.
      proof: prepared.proof, sessionId: bound.sessionId,
    }));
    // THE AUTHORITY'S SEALED INPUT, not the caller's proposal. `input` here is
    // `buildInputManifest` over the entries the REQUEST proposed, and a request
    // may lawfully propose a subset — `entriesAgree` checks each proposed entry
    // against the hydrated bytes and admits a partial (even empty) list. Sealing
    // the result against that subset makes the proposal decide which paths are
    // attributable: every honestly captured in-scope path the caller did not
    // name comes back RUNNER_WORKSPACE_PATH_UNDECLARED. Measured, not feared —
    // that is exactly how the first real producer answer refused. The workspace
    // the answer describes was hydrated from the AUTHORITATIVE declared scope,
    // so that is the input it must be sealed against.
    // THE DURABLE TERMINAL, derived by the runner from already-committed evidence and recorded
    // BEFORE the advisory release, which now DERIVES its terminality from this very ledger —
    // load-bearing order, not incidental. Refusals are still not consumed: no terminal proven
    // must not stop an attempt that ran, and the release says so by draining, not releasing.
    const terminal = recordTerminalEffect(store, {
      attemptRef: record.attempt.attemptId, projectId: bound.projectId,
    });
    // THE BUDGET SETTLES ONLY AFTER THE TERMINAL IS DURABLE, AND ON ITS OWN DECISION.
    //
    // `recordTerminalEffect` refuses EFFECT_TERMINAL_EVIDENCE_ABSENT unless the provider run is
    // already committed for this attempt, so gating on its ok is what makes telemetry durability
    // a PRECONDITION of settlement rather than a coincidence: wired any earlier, every settlement
    // would read UNKNOWN forever while its own UNKNOWN arm passed.
    //
    // It rides a SEPARATE decision rather than a leg of the terminal's: that path commits a
    // single-target decision, and converting it to the legs API would change a landed replay
    // identity on a surface this change does not own. A settlement refusal is ADVISORY here for
    // the same reason the terminal's own refusal is — an attempt that ran is not unmade by a
    // ledger that could not be read, and the refusal carries its own code and layer for a reader.
    //
    // THE DECISION KEY IS THE DURABLE TRUTH, NOT A CONVENIENCE. `decidedAt` is written straight
    // onto the durable decision as its own `decidedAt` (and onto the rejection audit as
    // `committedAt`), and `principalId` is a third of `budgetDecisionKey` — together they are the
    // row a recovery reads to answer WHO decided this settlement and WHEN.
    // Both therefore come from durable facts this dispatch already holds: the activation's own
    // decided-at, and the lease owner session the provider-run commit below is keyed by too.
    // Neither is a daemon clock reading and neither is the project — a project decides nothing.
    if (terminal.ok) {
      applyProviderUsageToBudget(store, {
        attemptRef: record.attempt.attemptId,
        context: {
          commandId: `settle-${record.attempt.attemptId}`,
          correlationId: `budget-settlement-${record.attempt.attemptId}`,
          decidedAt, principalId: record.lease.ownerSessionRef,
        },
        projectId: bound.projectId,
      });
    }
    const settled = noteRelease(bound, record, recordProvenFoundationAttempt(
      store, bound, record, prepared.inputManifest as unknown as Record<string, unknown>,
      { answer, observation, registration }));
    // ONLY a proven durable result may release its tree. An unproven or uncertain
    // settlement retains the bytes: they are the only evidence of what ran.
    if (settled.ok) {
      deps.lifecycle.releaseWorktree({
        assignment: prepared.assignment, callerIntent: "ATTEMPT_TERMINAL",
      });
    }
    return settled;
  }

  /** Persist unproven advisory truth under the upstream code/layer. */
  function unproven(
    bound: FoundationAttemptBound, record: ActivationLedgerRecord,
    input: Record<string, unknown>, result: Record<string, unknown> | null,
  ): FoundationAttemptOutcome {
    return settleUnprovenFoundationAttempt(
      store, bound, record, input, result,
      // NO REASON OVERRIDE HERE, and the omission is load-bearing. `noteRelease` already
      // defaults to SETTLE_REASONS.UNPROVEN for a non-ok settle, and this path is always
      // non-ok. Passing SETTLE_REASONS.PROVEN instead would FABRICATE AN AUTHORITY TOKEN:
      // `expansion-release-authority.ts` reads this very row through `readAttemptRelease`,
      // and its `releaseUnsafe` admits a release only when `reason`,
      // `disposition.strongestReason` and `disposition.resumable` all equal
      // WORK_RELEASE_OR_PAUSE — so an attempt refusing FOUNDATION_ATTEMPT_LAUNCH_UNKNOWN
      // would clear a gate built to refuse it, durably and at expectedVersion 0.
      // Nor is the override defensible as DRAIN avoidance: `lease-drain` computes
      // `settled = safeBoundaryObserved && effectsTerminal && resourcesTerminal`, in which
      // `reason` is not a term, so WORK_CANCEL cannot force DRAINING on a settled
      // boundary. The rule at SETTLE_REASONS holds unqualified: only a proven settle
      // earns the resumable release reason.
      (settled) => noteRelease(bound, record, settled),
    );
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
