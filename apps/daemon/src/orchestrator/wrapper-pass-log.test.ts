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
});
