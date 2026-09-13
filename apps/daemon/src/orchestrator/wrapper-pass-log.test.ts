import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { RunOnceReport, SpawnReport } from "./agent-spawn-contract.js";
import { createPassLogger } from "./wrapper-pass-log.js";

/**
 * The lines the binary prints per pass, held against a collecting sink. The reports are
 * hand-built in the contract's own shape: the logger reads nothing but the report.
 */
const entry = (workItemId: string, outcome: string): SpawnReport => ({
  kind: workItemId.split("@")[0] ?? "", outcome, refusal: null, sessionId: null, workItemId,
});
const pass = (spawned: readonly SpawnReport[], active = spawned.length): RunOnceReport =>
  ({ active, spawned, surfaceOutcome: "SURFACE" });
const PAUSED: RunOnceReport = {
  active: 0,
  paused: { provider: "codex", resetAt: "2026-09-13T13:00:00.000Z", since: "2026-09-13T12:00:00.000Z" },
  spawned: [],
  surfaceOutcome: "PROVIDER_PAUSED",
};

function logger(): { readonly lines: string[]; readonly log: (report: RunOnceReport) => void } {
  const lines: string[] = [];
  return { lines, log: createPassLogger((line) => { lines.push(line); }) };
}

describe("createPassLogger", () => {
  it("prints one line per staffed entry and names the refusing layer when a start was refused", () => {
    const { lines, log } = logger();
    log(pass([
      entry("policy.validate@proj", "SPAWNED"),
      {
        ...entry("node.deliver@node-1", "SPAWN_ARGUMENT_UNQUOTABLE"),
        refusal: { code: "SPAWN_ARGUMENT_UNQUOTABLE", layer: "agent-spawn-invocation", ok: false },
      },
    ]));
    expect(lines).toEqual([
      "[wrapper] policy.validate@proj: SPAWNED\n",
      "[wrapper] node.deliver@node-1: SPAWN_ARGUMENT_UNQUOTABLE (agent-spawn-invocation)\n",
    ]);
  });

  it("prints the idle line once per distinct idle state, and again after activity", () => {
    const { lines, log } = logger();
    log(pass([], 0));
    log(pass([], 0));
    log(pass([], 1));
    log(pass([entry("policy.validate@proj", "SPAWNED")]));
    log(pass([], 1));
    expect(lines).toEqual([
      "[wrapper] nothing to staff (surface SURFACE, active 0)\n",
      "[wrapper] nothing to staff (surface SURFACE, active 1)\n",
      "[wrapper] policy.validate@proj: SPAWNED\n",
      "[wrapper] nothing to staff (surface SURFACE, active 1)\n",
    ]);
  });

  it("says which provider is paused and until when, once per distinct pause", () => {
    const { lines, log } = logger();
    log(PAUSED);
    log(PAUSED);
    expect(lines).toEqual([
      "[wrapper] provider paused: codex until 2026-09-13T13:00:00.000Z (active 0)\n",
    ]);
  });

  /**
   * THE EXHAUSTED STATE IS A STEADY STATE, NOT ACTIVITY. `runPass` reports every exhausted
   * READY item on every pass (an honest per-pass observation five tests pin), and the loop
   * runs every `intervalMs` (15 s default) for as long as the item sits READY. Printed as an
   * entry, that is one identical line per exhausted item per interval into a wrapper.log with
   * no rotation, and the once-per-distinct-state dedupe never engages because the pass was
   * "not idle". The state is said once per distinct exhausted set, like the idle line.
   */
  const EXHAUSTED = "STAFFING_ATTEMPTS_EXHAUSTED";

  it("states an exhausted item once per distinct exhausted set, not once per pass", () => {
    const { lines, log } = logger();
    log(pass([entry("policy.install@proj", EXHAUSTED)], 0));
    log(pass([entry("policy.install@proj", EXHAUSTED)], 0));
    log(pass([entry("policy.install@proj", EXHAUSTED)], 0));
    expect(lines).toEqual([
      "[wrapper] staffing exhausted: policy.install@proj (STAFFING_ATTEMPTS_EXHAUSTED, active 0)\n",
    ]);
    // A second item joining is a new state, named in sorted order; the set shrinking is another.
    log(pass([entry("project.register@proj", EXHAUSTED), entry("policy.install@proj", EXHAUSTED)], 0));
    log(pass([entry("project.register@proj", EXHAUSTED), entry("policy.install@proj", EXHAUSTED)], 0));
    log(pass([entry("project.register@proj", EXHAUSTED)], 0));
    // The item leaving READY re-arms it; the pass is then plain idle, a distinct state again.
    log(pass([], 0));
    log(pass([], 0));
    expect(lines.slice(1)).toEqual([
      "[wrapper] staffing exhausted: policy.install@proj, project.register@proj (STAFFING_ATTEMPTS_EXHAUSTED, active 0)\n",
      "[wrapper] staffing exhausted: project.register@proj (STAFFING_ATTEMPTS_EXHAUSTED, active 0)\n",
      "[wrapper] nothing to staff (surface SURFACE, active 0)\n",
    ]);
  });

  it("prints activity beside an exhausted item every time, while the exhausted state prints once", () => {
    const { lines, log } = logger();
    log(pass([entry("policy.validate@proj", "SPAWNED"), entry("policy.install@proj", EXHAUSTED)], 1));
    log(pass([entry("policy.install@proj", EXHAUSTED)], 1));
    log(pass([entry("policy.validate@proj", "SPAWNED"), entry("policy.install@proj", EXHAUSTED)], 1));
    expect(lines).toEqual([
      "[wrapper] policy.validate@proj: SPAWNED\n",
      "[wrapper] staffing exhausted: policy.install@proj (STAFFING_ATTEMPTS_EXHAUSTED, active 1)\n",
      "[wrapper] policy.validate@proj: SPAWNED\n",
    ]);
  });

  it("mirrors the outcome literal runPass mints, so the dedupe cannot drift from the producer", () => {
    // The producer keeps its literal (agent-wrapper.ts, runPass); this pins the mirror.
    const producer = readFileSync(new URL("./agent-wrapper.ts", import.meta.url), "utf8");
    expect(producer).toContain(`uncoded(step.kind, "${EXHAUSTED}", null, workItemId)`);
    expect(readFileSync(new URL("./wrapper-pass-log.ts", import.meta.url), "utf8"))
      .toContain(`"${EXHAUSTED}"`);
  });
});
