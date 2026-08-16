import { appendFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCRIPT_CRASH, SCRIPT_LIVE, runTombstoneSchedule, runVerifierSchedule } from "./effect-schedule-driver.js";
import { buildBoundaryFacts, buildRuntime, readHeadSha } from "./effect-boundary-facts.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT = "D:/tmp/xh/drill.txt";
const say = (label: string, value: unknown): void => {
  appendFileSync(OUT, `${label} ${JSON.stringify(value, (k, v) => (k === "capturedStdout" ? "<bytes>" : v))}\n`);
};

describe("local drill", () => {
  it("all three", async () => {
    say("TOMBSTONE", runTombstoneSchedule());
    const host = { os: process.platform, arch: process.arch, osVersion: release() };
    const runtime = buildRuntime(host, new Date().toISOString());
    say("RUNTIME", runtime === null ? "NULL" : { t: runtime.truthClass, p: runtime.pinningMethod });
    const base = {
      host, observedAt: new Date().toISOString(), repoRoot: ROOT,
      headSha: readHeadSha(ROOT), trackedPath: "package.json", runtime: runtime!,
    };
    const crash = await runVerifierSchedule(base, SCRIPT_CRASH, false);
    say("CRASH", crash);
    const cancel = await runVerifierSchedule(base, SCRIPT_LIVE, true);
    say("CANCEL", cancel);
    if ("records" in crash && crash.records !== null) {
      const facts = buildBoundaryFacts({
        context: { ...base, records: crash.records }, processExit: crash.processExit,
        cancelRequested: false, capturedStdout: crash.capturedStdout,
      });
      say("FACTS", Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v === null ? null : "present"])));
    }
    expect(true).toBe(true);
  }, 180000);
});
