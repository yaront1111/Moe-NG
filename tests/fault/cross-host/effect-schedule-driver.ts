/**
 * The shared real-host schedule driver.
 *
 * Runs the 7x3 case universe as REAL effects on the machine executing it: real
 * activations, real `process.execPath` children, a real SIGKILL, a real
 * cancellation abort. The executing host is derived from the production doctor
 * collector plus `os.release()` — never from a CI matrix variable, an artifact
 * name or a caller's claim — so a wrong host refuses at
 * `CROSS_HOST_COLLECTOR` and emits nothing.
 *
 * Every verdict comes from production: `activateEffect`, `applyEffectTombstone`,
 * `runVerifierProcess`, and the OS boundary classifier and whole-platform
 * observer for the slot. This module composes them and records what they said.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectDoctorVersionReport } from "@moe/daemon";
import {
  PLATFORM_BOUNDARIES,
  SUPERVISOR_EFFECT_PROTOCOL_VERSION,
  activateEffect,
  applyEffectTombstone,
  buildInputManifest,
  buildVerificationRecipe,
  classifyLinuxBoundary,
  classifyMacosBoundary,
  createNodeProcessLauncher,
  observeLinuxPlatform,
  observeMacosPlatform,
  runVerifierProcess,
  type ClaudeProcessExit,
  type PlatformHostIdentity,
  type ProcessLauncher,
} from "@moe/runner";

import {
  buildBoundaryFacts,
  buildRuntime,
  readHeadSha,
  type ActivationRecords,
  type FactContext,
} from "./effect-boundary-facts.js";
import {
  canonicalDigest,
  crossHostFailure,
  isCrossHostSlot,
  type CrossHostFailure,
  type CrossHostSlot,
} from "./effect-evidence-contract.js";

export const CROSS_HOST_SCHEDULES = Object.freeze(
  ["CRASH_BEFORE_ACTIVATION", "CRASH_AFTER_ACTIVATION", "CANCELLATION"] as const,
);
export type CrossHostSchedule = (typeof CROSS_HOST_SCHEDULES)[number];

export interface CrossHostCase {
  readonly boundary: string;
  readonly schedule: CrossHostSchedule;
}

export function crossHostCaseUniverse(): readonly CrossHostCase[] {
  return CROSS_HOST_SCHEDULES.flatMap((schedule) =>
    PLATFORM_BOUNDARIES.map((boundary) => ({ boundary, schedule })),
  );
}

export interface RawCase {
  readonly boundary: string;
  readonly schedule: CrossHostSchedule;
  readonly truthClass: string;
  readonly code: string | null;
  readonly layer: string | null;
  readonly launchedPid: number | null;
  readonly elapsedMs: number;
}

export interface HostScheduleRun {
  readonly ok: true;
  readonly hostSlot: CrossHostSlot;
  readonly doctor: {
    readonly os: string; readonly arch: string; readonly nodeVersion: string;
    readonly pnpmVersion: string; readonly reportDigest: string;
  };
  readonly kernel: { readonly release: string };
  readonly runtime: {
    readonly closureKind: string; readonly pinningMethod: string;
    readonly observationDigest: string; readonly truthClass: string;
  };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly launchCount: number;
  readonly tombstonedLaunchCount: number;
  readonly cases: readonly RawCase[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRACKED_PATH = "package.json";
const AT = "2026-08-08T00:00:00.000Z";
const MAX_FACT_AGE_MS = 600_000;
const DIGEST = Object.freeze({
  input: "a1".repeat(32), runtime: "b2".repeat(32),
  authority: "d4".repeat(32), witness: "29".repeat(32),
});

function collectorRefusal(code: Parameters<typeof crossHostFailure>[0], slot: CrossHostSlot | null, message: string) {
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

export async function runVerifierSchedule(
  context: Omit<FactContext, "records">,
  script: string,
  cancel: boolean,
): Promise<ScheduleOutcome | CrossHostFailure> {
  const seed = nextSeed();
  const { request, lease } = activationRecordSet(seed);
  const activated = activateEffect(request);
  if (activated.kind !== "ACTIVATED") {
    return collectorRefusal("CROSS_HOST_SCHEDULE_INCOMPLETE", null, `activation refused: ${activated.failure.code}`);
  }
  const recipe = buildVerificationRecipe({
    argv: [process.execPath, "-e", script], declaredInputs: [], declaredOutputPaths: [],
    verifierIdentity: { verifierId: `verifier-${seed}`, verifierVersion: "1.0.0", capabilitySchemaDigest: "ab".repeat(32) },
  });
  const manifest = buildInputManifest({ baseIdentity: context.headSha, entries: [] });
  if (recipe.ok !== true || manifest.ok !== true) {
    return collectorRefusal("CROSS_HOST_SCHEDULE_INCOMPLETE", null, "the verification recipe or manifest was refused");
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
    recipe: recipe.recipe, inputManifest: manifest.manifest, candidateBaseIdentity: context.headSha,
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
      registration: {
        lockIdentity: `lock-${seed}`, wrapperIdentity: `wrapper-${seed}`, processIdentity: `process-${seed}`,
        bootstrapCredentialDigest: "aa".repeat(32), registeredAt: AT,
      },
      effectRef: `intent-${seed}`,
    },
    refusal: `${result.failure.code}/${result.failure.layer}`,
  };
}

/** The pre-activation schedule: a tombstone dominates, so nothing may start. */
export function runTombstoneSchedule(): ScheduleOutcome | CrossHostFailure {
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
  return {
    launches: 0, launchedPid: null, processExit: { kind: "UNOBSERVED" }, cancelRequested: false,
    capturedStdout: new Uint8Array(), records: null, refusal: "EFFECT_TOMBSTONED/ACTIVATION",
  };
}

export const SCRIPT_CRASH = "process.stdout.write('started');process.kill(process.pid,'SIGKILL');setInterval(()=>{},1000);";
export const SCRIPT_LIVE = "process.stdout.write('started');setInterval(()=>{},1000);";

export async function executingHostSlot(): Promise<string> {
  const report = await collectDoctorVersionReport();
  return report.observed.platform.known ? report.observed.platform.value : "";
}

function verdictCases(
  slot: CrossHostSlot, host: PlatformHostIdentity, observedAt: string,
  schedule: CrossHostSchedule, facts: Readonly<Record<string, unknown>>,
  outcome: ScheduleOutcome, elapsedMs: number,
): readonly RawCase[] | CrossHostFailure {
  const classify = slot === "linux" ? classifyLinuxBoundary : classifyMacosBoundary;
  const observe = slot === "linux" ? observeLinuxPlatform : observeMacosPlatform;
  const envelope = (boundary: string): unknown => {
    const fact = facts[boundary];
    return fact === undefined || fact === null ? null : { host, observedAt, truthClass: "PROVEN", fact };
  };
  const envelopes = Object.fromEntries(PLATFORM_BOUNDARIES.map((b) => [b, envelope(b)]));
  const batch = observe({ host, asOf: observedAt, maxFactAgeMs: MAX_FACT_AGE_MS, facts: envelopes });
  const cases: RawCase[] = [];
  for (const boundary of PLATFORM_BOUNDARIES) {
    const single = classify(boundary, envelope(boundary), { host, asOf: observedAt, maxFactAgeMs: MAX_FACT_AGE_MS });
    const batched = batch.verdicts.find((verdict) => verdict.boundary === boundary);
    if (!("truthClass" in single) || batched === undefined || batched.truthClass !== single.truthClass) {
      return collectorRefusal(
        "CROSS_HOST_SCHEDULE_INCOMPLETE", slot,
        `the per-boundary classifier and the whole-platform observer disagree on ${boundary}`,
      );
    }
    cases.push({
      boundary, schedule, truthClass: single.truthClass,
      code: single.failure?.code ?? null, layer: single.failure?.layer ?? null,
      launchedPid: outcome.launchedPid, elapsedMs,
    });
  }
  return cases;
}

export async function runHostSchedules(slot: CrossHostSlot): Promise<HostScheduleRun | CrossHostFailure> {
  const startedAt = new Date().toISOString();
  const report = await collectDoctorVersionReport();
  const observedOs = report.observed.platform.known ? report.observed.platform.value : null;
  if (!isCrossHostSlot(observedOs) || observedOs !== slot) {
    return collectorRefusal(
      "CROSS_HOST_HOST_MISMATCH", slot,
      `the executing host reports ${String(observedOs)}, which cannot prove anything about ${slot}`,
    );
  }
  const arch = report.observed.arch.known ? report.observed.arch.value : "";
  const host: PlatformHostIdentity = { os: slot, arch, osVersion: release() };
  const runtime = buildRuntime(host, startedAt);
  if (runtime === null || !arch) {
    return collectorRefusal("CROSS_HOST_RUNTIME_UNVERIFIABLE", slot, "the runtime closure could not be observed");
  }
  const headSha = readHeadSha(REPO_ROOT);
  const base: Omit<FactContext, "records"> = {
    host, observedAt: startedAt, repoRoot: REPO_ROOT, headSha, trackedPath: TRACKED_PATH, runtime,
  };
  const cases: RawCase[] = [];
  let launchCount = 0;
  let tombstonedLaunchCount = 0;
  for (const schedule of CROSS_HOST_SCHEDULES) {
    const began = Date.now();
    const outcome =
      schedule === "CRASH_BEFORE_ACTIVATION"
        ? runTombstoneSchedule()
        : await runVerifierSchedule(base, schedule === "CANCELLATION" ? SCRIPT_LIVE : SCRIPT_CRASH, schedule === "CANCELLATION");
    if ("ok" in outcome && outcome.ok === false) {
      return outcome;
    }
    const settled = outcome as ScheduleOutcome;
    launchCount += settled.launches;
    if (schedule === "CRASH_BEFORE_ACTIVATION") {
      tombstonedLaunchCount += settled.launches;
    }
    const facts =
      settled.records === null
        ? Object.freeze(Object.fromEntries(PLATFORM_BOUNDARIES.map((b) => [b, null])))
        : buildBoundaryFacts({
            context: { ...base, records: settled.records },
            processExit: settled.processExit, cancelRequested: settled.cancelRequested,
            capturedStdout: settled.capturedStdout,
          });
    const built = verdictCases(slot, host, startedAt, schedule, facts, settled, Date.now() - began);
    if ("ok" in built && built.ok === false) {
      return built;
    }
    cases.push(...(built as readonly RawCase[]));
  }
  return {
    ok: true, hostSlot: slot,
    doctor: {
      os: slot, arch, nodeVersion: report.observed.node.known ? report.observed.node.value : "",
      pnpmVersion: report.observed.pnpm.known ? report.observed.pnpm.value : "",
      reportDigest: canonicalDigest(report),
    },
    kernel: { release: release() },
    runtime: {
      closureKind: runtime.resolvedRuntimeClosure[0]?.kind ?? "", pinningMethod: runtime.pinningMethod,
      observationDigest: runtime.observationDigest, truthClass: runtime.truthClass,
    },
    startedAt, completedAt: new Date().toISOString(), launchCount, tombstonedLaunchCount, cases,
  };
}

/** Raw evidence only, and only into a directory the caller explicitly requested. */
export async function writeRawSchedule(run: HostScheduleRun): Promise<void> {
  const target = process.env["MOE_CROSS_HOST_RAW"];
  if (target === undefined || target.length === 0) {
    return;
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `schedule-${run.hostSlot}.json`), JSON.stringify(run, null, 1));
  await Promise.resolve();
}
