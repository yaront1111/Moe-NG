/**
 * macOS host effect conformance.
 *
 * This file is thin ON PURPOSE. Every judgement is made by the production
 * platform, activation, cancellation, crash and doctor surfaces reached through
 * the `@moe/runner` and `@moe/daemon` bare roots; what lives here is the
 * hand-written expectation those surfaces are held to.
 *
 * AUTHORITY: only a real macOS host can make this file say anything about
 * macOS. Run anywhere else it asserts the refusal instead — a wrong host is
 * `CROSS_HOST_HOST_MISMATCH` at `CROSS_HOST_COLLECTOR` with no schedule run and
 * no receipt emitted. It is never SKIPPED, because a skipped case reads as
 * "nothing was wrong" in exactly the place where "we were not on the host" is
 * the fact worth recording.
 */

import { PLATFORM_BOUNDARIES } from "@moe/runner";
import { describe, expect, it } from "vitest";

import {
  CROSS_HOST_SCHEDULES,
  crossHostCaseUniverse,
  describeRun,
  executingHostSlot,
  runHostSchedules,
  writeRawSchedule,
} from "../cross-host/effect-schedule-driver.js";

/** The slot and refusing platform layer this file speaks for, and only this one. */
const SLOT = "darwin";
const PLATFORM_LAYER = "PLATFORM_MACOS";

/** Hand-written here, independent of the producer; asserted against production. */
const EXPECTED_BOUNDARIES = Object.freeze([
  "PROVIDER_LAUNCH", "GIT_WORKSPACE", "PATH_SYMLINK", "LOCK",
  "SIGNAL_CANCELLATION", "RUNTIME_CLOSURE", "CRASH_RECOVERY",
] as const);

const EXPECTED_SCHEDULES = Object.freeze([
  "CRASH_BEFORE_ACTIVATION", "CRASH_AFTER_ACTIVATION", "CANCELLATION",
] as const);

const SLOW = 300_000;

describe("macOS effect conformance over every frozen platform boundary", () => {
  it("pins the 7x3 case universe as exactly 21 unique cases", () => {
    expect([...PLATFORM_BOUNDARIES]).toEqual([...EXPECTED_BOUNDARIES]);
    expect([...CROSS_HOST_SCHEDULES]).toEqual([...EXPECTED_SCHEDULES]);

    const universe = crossHostCaseUniverse();
    expect(universe).toHaveLength(EXPECTED_BOUNDARIES.length * EXPECTED_SCHEDULES.length);
    expect(universe).toHaveLength(21);
    expect(new Set(universe.map((entry) => `${entry.boundary}/${entry.schedule}`)).size).toBe(21);
  });

  it(
    "runs every schedule against the production surface, or refuses off-host",
    async () => {
      const host = await executingHostSlot();
      const run = await runHostSchedules(SLOT);
      // Printed before any assertion so a red CI leg carries the outcome that
      // produced it. A gate whose refusal cannot be read is not verifiable.
      process.stdout.write(`hostScheduleOutcome=${JSON.stringify(describeRun(host, run))}\n`);

      if (host !== SLOT) {
        // Not a skip: the off-host outcome is itself the asserted fact.
        expect(run.ok).toBe(false);
        if (run.ok) {
          throw new Error("a non-darwin host must not produce a macOS schedule run");
        }
        expect(run.code).toBe("CROSS_HOST_HOST_MISMATCH");
        expect(run.layer).toBe("CROSS_HOST_COLLECTOR");
        expect(run.hostSlot).toBe(SLOT);
        return;
      }

      if (!run.ok) {
        throw new Error(`on-host schedule run refused: ${run.code} at ${run.layer}: ${run.message}`);
      }
      expect(run.hostSlot).toBe(SLOT);
      expect(run.doctor.os).toBe(SLOT);
      expect(run.kernel.release.length).toBeGreaterThan(0);
      expect(run.runtime.truthClass).toBe("PROVEN");
      expect(run.runtime.pinningMethod).not.toBe("UNSUPPORTED");

      expect(run.cases).toHaveLength(21);
      expect(run.launchCount).toBeGreaterThan(0);
      expect(run.tombstonedLaunchCount).toBe(0);

      let inspected = 0;
      for (const record of run.cases) {
        expect(EXPECTED_BOUNDARIES).toContain(record.boundary);
        expect(EXPECTED_SCHEDULES).toContain(record.schedule);
        if (record.schedule === "CRASH_BEFORE_ACTIVATION") {
          expect(record.truthClass).toBe("UNKNOWN");
          expect(record.code).toBe("PLATFORM_FACT_ABSENT");
          expect(record.layer).toBe(PLATFORM_LAYER);
          expect(record.launchedPid).toBeNull();
        } else {
          expect(record.truthClass).toBe("PROVEN");
          expect(record.code).toBeNull();
          expect(record.layer).toBeNull();
          expect(record.launchedPid).toBeGreaterThan(0);
        }
        inspected += 1;
      }
      // The sweep above must have produced cases; zero would pass vacuously.
      expect(inspected).toBe(21);

      await writeRawSchedule(run);
    },
    SLOW,
  );
});
