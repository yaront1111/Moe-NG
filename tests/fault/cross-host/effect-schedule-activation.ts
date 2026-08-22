/**
 * One activation and one real child process per schedule.
 *
 * Split out of the driver so each file stays inside the per-file line cap. Every
 * decision below belongs to production — `activateEffect`, `applyEffectTombstone`
 * and `runVerifierProcess` — and this module only supplies well-formed inputs,
 * counts what physically launched, and reports what those surfaces answered.
 */

import {
  SUPERVISOR_EFFECT_PROTOCOL_VERSION,
  activateEffect,
  applyEffectTombstone,
  buildInputManifest,
  buildVerificationRecipe,
  createNodeProcessLauncher,
  runVerifierProcess,
  type ActivationGrant,
  type AttemptSlice,
  type ClaudeProcessExit,
  type EffectIntent,
  type ProcessLauncher,
} from "@moe/runner";

import { type ActivationRecords, type FactContext } from "./effect-boundary-facts.js";
import { crossHostFailure, type CrossHostFailure, type CrossHostSlot } from "./effect-evidence-contract.js";

const AT = "2026-08-08T00:00:00.000Z";
const DIGEST = Object.freeze({
  input: "a1".repeat(32), runtime: "b2".repeat(32),
  authority: "d4".repeat(32), witness: "29".repeat(32),
  /** Well-formed and bound to nothing: no activation ever derived this id. */
  forgedGrant: "ef".repeat(32),
});

function collectorRefusal(
  code: Parameters<typeof crossHostFailure>[0], slot: CrossHostSlot | null, message: string,
): CrossHostFailure {
  return crossHostFailure(code, "CROSS_HOST_COLLECTOR", slot, message);
}

/** Unique per case: the verifier run registry is process-global and one-use. */
let seedCounter = 0;
const nextSeed = (): string => `${process.pid}-${(seedCounter += 1)}`;

function activationRecordSet(seed: string): { request: Record<string, unknown>; lease: unknown } {
  const lease = {
    leaseId: `lease-${seed}`, kind: "ASSIGNMENT", ownerSessionRef: `session-${seed}`,
    leaseToken: `token-secret-${seed}`, epoch: 7, state: "ACTIVE",
    serverWallDeadline: 1_700_000_090, bootId: `boot-${seed}`, monotonicObservation: 4_242,
    authorityHashRef: DIGEST.authority, version: 3,
  };
  const intentId = `intent-${seed}`;
  return {
    lease,
    request: {
      intent: {
        protocolVersion: SUPERVISOR_EFFECT_PROTOCOL_VERSION, intentId, aggregateId: `aggregate-${seed}`,
        expectedGraphEpoch: 11, leaseBinding: lease, inputBinding: DIGEST.input,
        predecessorCursor: "cursor-42", desiredState: "RUNNING", idempotencyKey: `idem-${seed}`,
        runtimeObservationDigest: DIGEST.runtime, state: "ARMED", version: 5,
      },
      attempt: {
        attemptId: `attempt-${seed}`, aggregateId: `aggregate-${seed}`, intentId,
        state: "LAUNCH_REQUESTED", version: 2,
      },
      claim: {
        claimId: `claim-${seed}`, intentId, wrapperIdentity: `wrapper-${seed}`,
        lockIdentity: `lock-${seed}`, claimedAt: AT,
      },
      tombstone: null,
      leaseProof: {
        leaseToken: lease.leaseToken, epoch: lease.epoch, authorityHashRef: lease.authorityHashRef,
        ownerSessionRef: lease.ownerSessionRef, expectedVersion: lease.version,
      },
      wrapperIdentity: `wrapper-${seed}`, lockIdentity: `lock-${seed}`, observedGraphEpoch: 11,
      desiredState: "RUNNING",
      dependencyWitnesses: [
        { witnessId: `witness-${seed}`, expectedDigest: DIGEST.witness, observedDigest: DIGEST.witness },
      ],
      observedRuntimeDigest: DIGEST.runtime,
    },
  };
}

/** Counts every physical launch, so "nothing started" is measured, not assumed. */
function countingLauncher(inner: ProcessLauncher, onPid: (pid: number | null) => void) {
  let launches = 0;
  return {
    launches: () => launches,
    launcher: {
      launch: (spec: Parameters<ProcessLauncher["launch"]>[0]) => {
        launches += 1;
        const started = inner.launch(spec);
        onPid(started.pid);
        return started;
      },
    } satisfies ProcessLauncher,
  };
}

export interface ScheduleOutcome {
  readonly launches: number;
  readonly launchedPid: number | null;
  readonly processExit: ClaudeProcessExit;
  readonly cancelRequested: boolean;
  readonly capturedStdout: Uint8Array;
  readonly records: ActivationRecords | null;
  readonly refusal: string;
}

/**
 * The exact production refusal each schedule is defined by. A schedule that
 * ends in some other refusal did not run the effect it names, so it is refused
 * rather than recorded: "the child did not survive" is not the same fact as
 * "the child was SIGKILLed" or "the wrapper cancelled it".
 */
export const CRASH_REFUSAL = "VERIFIER_PROCESS_EXIT_AMBIGUOUS/CAPTURE";
export const CANCELLATION_REFUSAL = "VERIFIER_PROCESS_CANCELLED/CAPTURE";

const RECIPE_OR_MANIFEST_REFUSED = "the verification recipe or manifest was refused";

/** The two sealed inputs every launch below is gated on. Neither is judged here. */
function launchInputs(context: Omit<FactContext, "records">, seed: string, script: string) {
  const recipe = buildVerificationRecipe({
    argv: [process.execPath, "-e", script], declaredInputs: [], declaredOutputPaths: [],
    verifierIdentity: { verifierId: `verifier-${seed}`, verifierVersion: "1.0.0", capabilitySchemaDigest: "ab".repeat(32) },
  });
  const manifest = buildInputManifest({ baseIdentity: context.headSha, entries: [] });
  return recipe.ok === true && manifest.ok === true
    ? { recipe: recipe.recipe, inputManifest: manifest.manifest }
    : null;
}

export async function runVerifierSchedule(
  context: Omit<FactContext, "records">,
  script: string,
  cancel: boolean,
  expectedRefusal: string,
): Promise<ScheduleOutcome | CrossHostFailure> {
  const seed = nextSeed();
  const { request, lease } = activationRecordSet(seed);
  const activated = activateEffect(request);
  if (activated.kind !== "ACTIVATED") {
    return collectorRefusal("CROSS_HOST_SCHEDULE_INCOMPLETE", null, `activation refused: ${activated.failure.code}`);
  }
  const inputs = launchInputs(context, seed, script);
  if (inputs === null) {
    return collectorRefusal("CROSS_HOST_SCHEDULE_INCOMPLETE", null, RECIPE_OR_MANIFEST_REFUSED);
  }
  const controller = new AbortController();
  let pid: number | null = null;
  const counted = countingLauncher(createNodeProcessLauncher(), (started) => {
    pid = started;
    if (cancel) {
      setTimeout(() => controller.abort(), 250).unref();
    }
  });
  const result = await runVerifierProcess({
    ...inputs, candidateBaseIdentity: context.headSha,
    activation: { intent: activated.commit.intent, attempt: activated.commit.attempt, grant: activated.commit.grant },
    wrapperIdentity: `wrapper-${seed}`, candidateRoot: context.repoRoot, runtimeObservation: context.runtime,
    outputs: [], launcher: counted.launcher,
    clock: { now: () => new Date().toISOString(), monotonicMs: () => Math.round(performance.now()) },
    baseEnvironment: process.env, signal: cancel ? controller.signal : undefined,
  });
  if (result.ok || result.source !== "PROCESS") {
    return collectorRefusal(
      "CROSS_HOST_SCHEDULE_INCOMPLETE", null,
      result.ok ? "the child was expected to die, not to complete" : `foreign refusal ${result.failure.code}`,
    );
  }
  const observedRefusal = `${result.failure.code}/${result.failure.layer}`;
  if (observedRefusal !== expectedRefusal) {
    return collectorRefusal(
      "CROSS_HOST_SCHEDULE_INCOMPLETE", null,
      `the verifier refused ${observedRefusal}, not the scheduled ${expectedRefusal}`,
    );
  }
  const capture = result.capture;
  const signal = capture?.signal ?? null;
  const exitCode = capture?.exitCode ?? null;
  return {
    launches: counted.launches(), launchedPid: pid,
    processExit: signal !== null
      ? { kind: "SIGNALLED", signal }
      : exitCode !== null ? { kind: "EXITED", code: exitCode } : { kind: "UNOBSERVED" },
    cancelRequested: cancel, capturedStdout: capture?.stdout.bytes ?? new Uint8Array(),
    records: {
      intent: activated.commit.intent, attempt: activated.commit.attempt, claim: request["claim"],
      grant: activated.commit.grant, lease,
      advancedAuthority: {
        leaseToken: `token-secret-next-${seed}`, epoch: 8, authorityHashRef: DIGEST.authority,
        ownerSessionRef: `session-${seed}`, expectedVersion: 3,
      },
      registration: {
        lockIdentity: `lock-${seed}`, wrapperIdentity: `wrapper-${seed}`, processIdentity: `process-${seed}`,
        bootstrapCredentialDigest: "aa".repeat(32), registeredAt: AT,
      },
      effectRef: `intent-${seed}`,
    },
    refusal: `${result.failure.code}/${result.failure.layer}`,
  };
}

/**
 * The refusal the launch gate owes a wrapper that ignored the tombstone.
 *
 * Nothing after a tombstoned activation is activated: no grant was minted, so
 * the only grant such a wrapper can present is one it made up. The supervisor
 * must answer the whole record set at its own layer; any other answer means the
 * probe below measured some earlier gate instead of the one it names, and a
 * launch count of zero would then say nothing about the activation invariant.
 */
const UNACTIVATED_REFUSAL = "ACTIVATION_COMMIT_INCOHERENT/ACTIVATION";
const SCRIPT_NOOP = "process.exit(0);";

/**
 * Carries the refused activation's own records into the REAL launch gate.
 *
 * This is what makes "nothing started" a measurement rather than a literal: a
 * counting launcher wrapping the real node launcher is handed to production, and
 * the count and pid returned are whatever that attempt physically produced. The
 * grant id is fabricated because no real one exists; that is the probe, not a
 * shortcut. A grant left absent would stop at kernel shape validation and never
 * reach the commit-coherence invariant that keeps an unactivated effect off the
 * host.
 */
async function measureUnactivatedLaunch(
  context: Omit<FactContext, "records">, seed: string, request: Record<string, unknown>,
): Promise<{ readonly launches: number; readonly pid: number | null } | CrossHostFailure> {
  const inputs = launchInputs(context, seed, SCRIPT_NOOP);
  if (inputs === null) {
    return collectorRefusal("CROSS_HOST_SCHEDULE_INCOMPLETE", null, RECIPE_OR_MANIFEST_REFUSED);
  }
  let pid: number | null = null;
  const counted = countingLauncher(createNodeProcessLauncher(), (started) => {
    pid = started;
  });
  const result = await runVerifierProcess({
    ...inputs, candidateBaseIdentity: context.headSha,
    activation: {
      intent: request["intent"] as EffectIntent,
      attempt: request["attempt"] as AttemptSlice,
      grant: {
        grantId: DIGEST.forgedGrant, intentId: `intent-${seed}`,
        wrapperIdentity: `wrapper-${seed}`, state: "UNUSED", version: 0,
      } satisfies ActivationGrant,
    },
    wrapperIdentity: `wrapper-${seed}`, candidateRoot: context.repoRoot,
    runtimeObservation: context.runtime, outputs: [], launcher: counted.launcher,
    clock: { now: () => new Date().toISOString(), monotonicMs: () => Math.round(performance.now()) },
    baseEnvironment: process.env,
  });
  const answered = result.ok || result.source !== "SUPERVISOR"
    ? null
    : `${result.failure.code}/${result.failure.layer}`;
  if (answered !== UNACTIVATED_REFUSAL) {
    return collectorRefusal(
      "CROSS_HOST_SCHEDULE_INCOMPLETE", null,
      `an unactivated launch was answered ${answered ?? "outside the supervisor"} after ${counted.launches()} launch(es)`,
    );
  }
  return { launches: counted.launches(), pid };
}

/**
 * The pre-activation schedule: a tombstone dominates, so nothing may start.
 *
 * "Nothing started" is measured, not declared. The activation refusal below is
 * the schedule's defining fact; the launch counted afterwards is the evidence
 * that the refusal actually kept a child off this host, which a returned zero
 * could never be.
 */
export async function runTombstoneSchedule(
  context: Omit<FactContext, "records">,
): Promise<ScheduleOutcome | CrossHostFailure> {
  const seed = nextSeed();
  const { request } = activationRecordSet(seed);
  const tombstone = { intentId: `intent-${seed}`, reason: "GOAL_CANCEL", terminalizedAt: AT };
  const lifecycle = applyEffectTombstone(request["intent"], tombstone);
  if (lifecycle.kind === "REFUSED") {
    return collectorRefusal("CROSS_HOST_SCHEDULE_INCOMPLETE", null, "the tombstone did not dominate the armed intent");
  }
  const activated = activateEffect({ ...request, tombstone });
  const failure = activated.kind === "ACTIVATED" ? null : activated.failure;
  const leg = (failure as { readonly detail?: { readonly leg?: unknown } } | null)?.detail?.leg;
  if (failure === null || failure.code !== "EFFECT_TOMBSTONED" || failure.layer !== "ACTIVATION" || leg !== "tombstoneWitness") {
    return collectorRefusal(
      "CROSS_HOST_SCHEDULE_INCOMPLETE", null,
      "a tombstoned activation did not refuse as EFFECT_TOMBSTONED/ACTIVATION at the tombstoneWitness leg",
    );
  }
  const measured = await measureUnactivatedLaunch(context, seed, request);
  if ("ok" in measured) {
    return measured;
  }
  return {
    launches: measured.launches, launchedPid: measured.pid,
    processExit: { kind: "UNOBSERVED" }, cancelRequested: false,
    capturedStdout: new Uint8Array(), records: null, refusal: "EFFECT_TOMBSTONED/ACTIVATION",
  };
}

export const SCRIPT_CRASH = "process.stdout.write('started');process.kill(process.pid,'SIGKILL');setInterval(()=>{},1000);";
export const SCRIPT_LIVE = "process.stdout.write('started');setInterval(()=>{},1000);";

