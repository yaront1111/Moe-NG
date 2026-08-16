// TEMPORARY DIAGNOSTIC PROBE - not evidence, deleted before commit.
import { appendFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectDoctorVersionReport } from "@moe/daemon";
import {
  PLATFORM_BOUNDARIES,
  classifyLinuxBoundary,
  observeLinuxPlatform,
  type PlatformHostIdentity,
} from "@moe/runner";
import { describe, it } from "vitest";

import { buildBoundaryFacts, buildRuntime, readHeadSha } from "./effect-boundary-facts.js";
import { SCRIPT_LIVE, runVerifierSchedule, runTombstoneSchedule } from "./effect-schedule-activation.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LOG = (...parts: unknown[]): void => {
  appendFileSync("probe-out.txt", `${parts.map((p) => String(p)).join(" ")}\n`);
};

describe("probe", () => {
  it("tombstone schedule", () => {
    const out = runTombstoneSchedule();
    LOG("TOMB_OK=", !("ok" in out && out.ok === false), JSON.stringify(out).slice(0, 400));
  });

  it("verifier cancellation schedule + linux classification", async () => {
    const report = await collectDoctorVersionReport();
    LOG("DOCTOR=", JSON.stringify(report.observed.platform), JSON.stringify(report.observed.arch));
    const host: PlatformHostIdentity = { os: "linux", arch: "x64", osVersion: release() };
    const observedAt = new Date().toISOString();
    const runtime = buildRuntime(host, observedAt);
    LOG("RUNTIME_NULL=", runtime === null, runtime?.truthClass, runtime?.pinningMethod);
    if (runtime === null) return;
    const headSha = readHeadSha(REPO_ROOT);
    const base = { host, observedAt, repoRoot: REPO_ROOT, headSha, trackedPath: "package.json", runtime };
    const outcome = await runVerifierSchedule(base, SCRIPT_LIVE, true);
    if ("ok" in outcome && outcome.ok === false) {
      LOG("VERIFIER_REFUSED=", JSON.stringify(outcome));
      return;
    }
    const settled = outcome as Exclude<typeof outcome, { ok: false }>;
    LOG("VERIFIER_OK refusal=", settled.refusal, "launches=", settled.launches, "pid=", settled.launchedPid);
    const facts = buildBoundaryFacts({
      context: { ...base, records: settled.records! },
      processExit: settled.processExit,
      cancelRequested: settled.cancelRequested,
      capturedStdout: settled.capturedStdout,
    });
    for (const boundary of PLATFORM_BOUNDARIES) {
      const fact = facts[boundary];
      const envelope =
        fact === undefined || fact === null ? null : { host, observedAt, truthClass: "PROVEN", fact };
      const single = classifyLinuxBoundary(boundary, envelope, { host, asOf: observedAt, maxFactAgeMs: 600_000 });
      LOG(
        "CLASSIFY",
        boundary,
        JSON.stringify({
          t: (single as { truthClass?: string }).truthClass,
          f: (single as { failure?: unknown }).failure,
        }).slice(0, 300),
      );
    }
    const envelopes = Object.fromEntries(
      PLATFORM_BOUNDARIES.map((boundary) => {
        const fact = facts[boundary];
        return [
          boundary,
          fact === undefined || fact === null ? null : { host, observedAt, truthClass: "PROVEN", fact },
        ];
      }),
    );
    const batch = observeLinuxPlatform({ host, asOf: observedAt, maxFactAgeMs: 600_000, facts: envelopes });
    LOG("BATCH=", JSON.stringify(batch.verdicts.map((v) => ({ b: v.boundary, t: v.truthClass }))));
  }, 120_000);
});
