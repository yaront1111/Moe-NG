import { describe, expect, it } from "vitest";

import { createSeatLiveness, formatClock, formatDuration } from "./seat-liveness.js";
import type { SeatActivitySample, SeatProbeAnswer } from "./seat-liveness-probe.js";

const T0 = Date.parse("2026-09-18T13:12:04.000Z");

/** A clock and a scripted probe: each `tick()` consumes the next answer; an exhausted script fails. */
function harness(samples: readonly SeatProbeAnswer[], probed = true): {
  readonly advance: (ms: number) => void;
  readonly liveness: ReturnType<typeof createSeatLiveness>;
  readonly probes: number[];
} {
  let now = T0;
  const probes: number[] = [];
  const queue = [...samples];
  const liveness = createSeatLiveness({
    now: () => now,
    pid: 4242,
    probe: probed
      ? (pid) => { probes.push(pid); return queue.shift() ?? { ok: false, reason: "script exhausted" }; }
      : undefined,
  });
  return { advance: (ms) => { now += ms; }, liveness, probes };
}

describe("formatDuration / formatClock", () => {
  it("renders the shapes the kill lines carry", () => {
    expect(formatDuration(7_200_000)).toBe("2h0m");
    expect(formatDuration(1_200_000)).toBe("20m0s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(800)).toBe("800ms");
    expect(formatDuration(3_723_000)).toBe("1h2m");
    expect(formatClock(T0)).toBe("13:12:04Z");
  });
});

describe("createSeatLiveness", () => {
  it("takes the smallest descendant count as the launcher chain and counts tool children above it", () => {
    // win32: cmd.exe -> claude.exe is the chain (2 descendants of the seat pid); a bash tool
    // child makes 3. CPU flat throughout, so the child is the only activity.
    const h = harness([
      { cpuMs: 1_000, descendants: 2 },
      { cpuMs: 1_000, descendants: 3 },
      { cpuMs: 1_000, descendants: 2 },
    ]);
    h.advance(60_000);
    expect(h.liveness.tick()).toEqual({
      detail: "no output; no tool child; cpu baseline taken", probeFailure: undefined, quietMs: 60_000, silentMs: 60_000,
    });
    h.advance(60_000);
    expect(h.liveness.tick()).toEqual({
      detail: "no output; 1 tool child alive; cpu unchanged", probeFailure: undefined, quietMs: 120_000, silentMs: 0,
    });
    expect(h.liveness.lastActivity()).toBe("1 tool child alive at 13:14:04Z");
    h.advance(60_000);
    expect(h.liveness.tick()).toMatchObject({ detail: "no output; no tool child; cpu unchanged", silentMs: 60_000 });
    expect(h.liveness.stillness()).toBe("no output, no tool child, cpu unchanged since 13:14:04Z");
    expect(h.probes).toEqual([4242, 4242, 4242]);
  });

  it("calls CPU growth at or above the floor activity, and growth below it unchanged", () => {
    const h = harness([
      { cpuMs: 1_000, descendants: 2 },
      { cpuMs: 1_249, descendants: 2 },
      { cpuMs: 2_549, descendants: 2 },
    ]);
    h.liveness.tick();
    h.advance(60_000);
    expect(h.liveness.tick()).toMatchObject({ detail: "no output; no tool child; cpu unchanged", silentMs: 60_000 });
    h.advance(60_000);
    expect(h.liveness.tick()).toMatchObject({ detail: "no output; no tool child; cpu +1.3s", silentMs: 0 });
    expect(h.liveness.lastActivity()).toBe("cpu +1.3s at 13:14:04Z");
  });

  it("treats output as activity the moment it lands, and reports the bytes on the next tick", () => {
    const h = harness([{ cpuMs: 0, descendants: 2 }, { cpuMs: 0, descendants: 2 }]);
    h.liveness.tick();
    h.advance(30_000);
    h.liveness.noteOutput(120);
    h.advance(30_000);
    expect(h.liveness.tick()).toEqual({
      detail: "output 120 bytes; no tool child; cpu unchanged", probeFailure: undefined, quietMs: 30_000, silentMs: 30_000,
    });
    expect(h.liveness.lastActivity()).toBe("output 120 bytes at 13:12:34Z");
  });

  it("says so when there is no probe, and judges on output alone", () => {
    const h = harness([], false);
    h.advance(60_000);
    expect(h.liveness.tick()).toEqual({
      detail: "no output; no activity probe", probeFailure: undefined, quietMs: 60_000, silentMs: 60_000,
    });
    expect(h.liveness.stillness()).toBe("no output, no activity probe since 13:12:04Z");
    expect(h.probes).toEqual([]);
  });

  it("carries the probe's own reason when it fails or throws, and grants no liveness for it", () => {
    let now = T0;
    let throwing = false;
    const liveness = createSeatLiveness({
      now: () => now, pid: 4242,
      probe: () => {
        if (throwing) throw new Error("powershell exploded");
        return { ok: false, reason: "powershell.exe timed out after 30000ms (SIGTERM)" };
      },
    });
    now += 60_000;
    // The reason a probe gave is the reason the notice carries — not a generic "answered nothing".
    expect(liveness.tick()).toEqual({
      detail: "no output; tree unobserved: powershell.exe timed out after 30000ms (SIGTERM)",
      probeFailure: "powershell.exe timed out after 30000ms (SIGTERM)", quietMs: 60_000, silentMs: 60_000,
    });
    expect(liveness.stillness())
      .toBe("no output, tree unobserved: powershell.exe timed out after 30000ms (SIGTERM) since 13:12:04Z");
    throwing = true;
    now += 60_000;
    // A THROWING probe is a failed probe whose reason is the thrown message.
    expect(liveness.tick()).toMatchObject({
      detail: "no output; tree unobserved: probe threw: powershell exploded",
      probeFailure: "probe threw: powershell exploded", silentMs: 120_000,
    });
    // FAIL-CLOSED: two failed ticks moved the last activity nowhere.
    expect(liveness.lastActivity()).toBe("seat start at 13:12:04Z");
  });

  it("awaits an asynchronous probe and rebases CPU when a process leaves the tree", async () => {
    let now = T0;
    const samples: SeatActivitySample[] = [
      { cpuMs: 5_000, descendants: 3 }, { cpuMs: 2_000, descendants: 2 },
    ];
    const liveness = createSeatLiveness({
      now: () => now, pid: 4242, probe: async () => samples.shift() ?? { ok: false, reason: "script exhausted" },
    });
    const first = liveness.tick();
    expect(first).toBeInstanceOf(Promise);
    await expect(first).resolves.toMatchObject({ detail: "no output; no tool child; cpu baseline taken" });
    now += 60_000;
    await expect(liveness.tick()).resolves.toMatchObject({
      detail: "no output; no tool child; cpu rebased (a process left the tree)", silentMs: 0,
    });
    const rejecting = createSeatLiveness({
      now: () => now, pid: 4242, probe: async () => { throw new Error("ps died"); },
    });
    await expect(rejecting.tick()).resolves.toMatchObject({
      detail: "no output; tree unobserved: probe threw: ps died", probeFailure: "probe threw: ps died",
    });
  });

  it("does not probe a seat without a pid", () => {
    let probes = 0;
    const liveness = createSeatLiveness({
      now: () => T0, pid: undefined, probe: () => { probes += 1; return { ok: false, reason: "never asked" }; },
    });
    expect(liveness.tick()).toMatchObject({ detail: "no output; no activity probe" });
    expect(probes).toBe(0);
  });
});
