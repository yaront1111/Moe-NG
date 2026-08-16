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
  classifyLinuxBoundary,
  classifyMacosBoundary,
  observeLinuxPlatform,
  observeMacosPlatform,
  type PlatformHostIdentity,
} from "@moe/runner";

import { buildBoundaryFacts, buildRuntime, readHeadSha, type FactContext } from "./effect-boundary-facts.js";
import {
  CANCELLATION_REFUSAL,
  CRASH_REFUSAL,
  SCRIPT_CRASH,
  SCRIPT_LIVE,
  runTombstoneSchedule,
  runVerifierSchedule,
  type ScheduleOutcome,
} from "./effect-schedule-activation.js";
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
const MAX_FACT_AGE_MS = 600_000;

function collectorRefusal(
  code: Parameters<typeof crossHostFailure>[0], slot: CrossHostSlot | null, message: string,
): CrossHostFailure {
  return crossHostFailure(code, "CROSS_HOST_COLLECTOR", slot, message);
}

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
        : schedule === "CANCELLATION"
          ? await runVerifierSchedule(base, SCRIPT_LIVE, true, CANCELLATION_REFUSAL)
          : await runVerifierSchedule(base, SCRIPT_CRASH, false, CRASH_REFUSAL);
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

/**
 * A readable summary of whatever the schedule produced, refusal included.
 *
 * Diagnostic only — it asserts nothing and grants nothing. It exists because a
 * host leg that refuses in CI is otherwise a bare exit code: the caller can see
 * that the gate failed and not what the production surfaces actually said.
 */
export function describeRun(
  observedHost: string,
  run: HostScheduleRun | CrossHostFailure,
): Readonly<Record<string, unknown>> {
  if (run.ok !== true) {
    return { observedHost, ok: false, code: run.code, layer: run.layer, hostSlot: run.hostSlot, message: run.message };
  }
  return {
    observedHost, ok: true, hostSlot: run.hostSlot, doctor: run.doctor, kernel: run.kernel,
    runtime: run.runtime, launchCount: run.launchCount, tombstonedLaunchCount: run.tombstonedLaunchCount,
    cases: run.cases.map((c) => `${c.boundary}/${c.schedule}=${c.truthClass}:${c.code ?? "-"}:${c.layer ?? "-"}:pid${c.launchedPid ?? "-"}`),
  };
}

/**
 * Raw evidence only, and only into a directory the caller explicitly requested.
 *
 * The executed count is printed unconditionally: a CI leg that exits 0 having
 * run nothing is the failure this line exists to make visible.
 */
export async function writeRawSchedule(run: HostScheduleRun): Promise<void> {
  process.stdout.write(`executedCaseCount=${run.cases.length}
`);
  const target = process.env["MOE_CROSS_HOST_RAW"];
  if (target === undefined || target.length === 0) {
    return;
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `schedule-${run.hostSlot}.json`), JSON.stringify(run, null, 1));
  await Promise.resolve();
}
