import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  RUNTIME_AGGREGATES,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_LIFECYCLES,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_QUERY_KINDS,
  RUNTIME_TELEMETRY_KINDS,
  buildNextAllowedCommands,
  freshRuntimeResult,
  historicalRuntimeResult,
} from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";

const SOURCE = Object.freeze({ aggregate: "GOAL", state: "EXECUTION_ENABLED" });

function entry(commandKind: string, commandId: string): Record<string, unknown> {
  return {
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId,
    commandKind,
    expectedVersion: 7,
    inputSchemaVersion: `${commandKind}/1`,
    targetAggregateId: "goal-1",
  };
}

function kinds(list: readonly NextAllowedCommand[]): readonly string[] {
  return list.map((item) => `${item.commandKind}:${item.commandId}`);
}

describe("runtime vocabulary is closed and disjoint", () => {
  it("pins the selected schema literals", () => {
    expect(RUNTIME_COMMAND_ENVELOPE_VERSION).toBe("moe-runtime-command/1");
    expect(RUNTIME_QUERY_ENVELOPE_VERSION).toBe("moe-runtime-query/1");
    expect(RUNTIME_ERROR_REGISTRY_VERSION).toBe("moe-runtime-error-registry/1");
  });

  it("keeps queries, commands, and telemetry disjoint and frozen", () => {
    const commands = new Set<string>(RUNTIME_COMMAND_KINDS);
    expect(RUNTIME_QUERY_KINDS).toEqual([
      "budget.get", "dependency.explain", "doctor.get", "events.read", "events.wait",
      "evidence.get", "frontier.get", "goal.get", "goal.list", "graph.get", "graph.preview",
      "project.get", "quarantine.get", "reconciliation.get", "scheduler.readiness_explain",
      "work.get_context",
    ]);
    expect(RUNTIME_TELEMETRY_KINDS).toEqual(["presence.ping"]);
    for (const kind of [...RUNTIME_QUERY_KINDS, ...RUNTIME_TELEMETRY_KINDS]) {
      expect(commands.has(kind)).toBe(false);
    }
    expect(commands.size).toBe(RUNTIME_COMMAND_KINDS.length);
    expect(RUNTIME_COMMAND_KINDS).toContain("plan.propose");
    expect(RUNTIME_COMMAND_KINDS).toContain("graph.prepare_supersession");
    for (const tuple of [RUNTIME_COMMAND_KINDS, RUNTIME_QUERY_KINDS, RUNTIME_AGGREGATES]) {
      expect(Object.isFrozen(tuple)).toBe(true);
    }
  });

  it("closes every lifecycle tuple named by the design", () => {
    for (const aggregate of RUNTIME_AGGREGATES) {
      const states = RUNTIME_LIFECYCLES[aggregate];
      expect(Object.isFrozen(states)).toBe(true);
      expect(states.length).toBeGreaterThan(0);
      expect(new Set<string>(states).size).toBe(states.length);
    }
    expect(RUNTIME_LIFECYCLES.GOAL).toEqual([
      "DRAFT", "EXECUTION_ENABLED", "CLOSING", "COMPLETED", "CANCELLED",
    ]);
    expect(RUNTIME_LIFECYCLES.PROJECT).toEqual([
      "BOOTSTRAPPING", "READY", "DEGRADED", "QUIESCED",
    ]);
    expect(RUNTIME_LIFECYCLES.LEASE).toEqual([
      "ACTIVE", "SUSPECT", "DRAINING", "RELEASED", "REVOKED",
    ]);
    expect(RUNTIME_LIFECYCLES.CUTOVER).toContain("ACTIVATE_APPROVED");
    expect(RUNTIME_LIFECYCLES.PLANNING_RUN).toContain("SUBMISSION_DRAINING");
    expect(RUNTIME_LIFECYCLES.TRUTH_CLASS).toContain("UNKNOWN");
  });
});

describe("nextAllowedCommands grants no unknown authority", () => {
  it("sorts by commandKind then commandId and deeply freezes", () => {
    const built = buildNextAllowedCommands(SOURCE, [
      entry("work.claim", "b"), entry("goal.pause", "z"), entry("goal.pause", "a"),
    ]);
    expect(kinds(built)).toEqual(["goal.pause:a", "goal.pause:z", "work.claim:b"]);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built[0])).toBe(true);
    expect(built[0]?.commandEnvelopeVersion).toBe(RUNTIME_COMMAND_ENVELOPE_VERSION);
  });

  it("carries optional lease and revision bindings only when fully formed", () => {
    const lease = {
      attemptBindingVersion: 2, authorityHash: "b".repeat(64), epoch: 4, graphEpoch: 3,
      leaseToken: "lease-1",
    };
    const full = { ...entry("work.claim", "a"), graphRevisionHash: "c".repeat(64), leaseAuthority: lease };
    const built = buildNextAllowedCommands(SOURCE, [full]);
    expect(built[0]?.leaseAuthority).toEqual(lease);
    expect(Object.isFrozen(built[0]?.leaseAuthority)).toBe(true);
    const partial = { ...entry("work.claim", "a"), leaseAuthority: { leaseToken: "lease-1" } };
    expect(buildNextAllowedCommands(SOURCE, [partial])).toEqual([]);
  });

  it("refuses duplicates, non-commands, and malformed entries without partial authority", () => {
    const duplicate = [entry("goal.pause", "a"), entry("goal.cancel", "a")];
    expect(buildNextAllowedCommands(SOURCE, duplicate)).toEqual([]);
    for (const bad of ["graph.preview", "events.wait", "goal.get", "presence.ping", "nope", ""]) {
      expect(buildNextAllowedCommands(SOURCE, [entry("goal.pause", "a"), entry(bad, "b")]))
        .toEqual([]);
    }
    for (const patch of [
      { expectedVersion: -1 }, { expectedVersion: 1.5 }, { expectedVersion: "7" },
      { commandId: "" }, { extra: 1 }, { inputSchemaVersion: 1 },
      { commandEnvelopeVersion: "moe-runtime-command/2" }, { targetAggregateId: "" },
    ]) {
      expect(buildNextAllowedCommands(SOURCE, [{ ...entry("goal.pause", "a"), ...patch }]))
        .toEqual([]);
    }
    expect(buildNextAllowedCommands(SOURCE, "not-an-array")).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(buildNextAllowedCommands(SOURCE, [null])).toEqual([]);
  });

  it("returns the shared frozen empty set for any unknown lifecycle source", () => {
    for (const source of [
      { aggregate: "GOAL", state: "NOT_A_STATE" }, { aggregate: "NOPE", state: "DRAFT" },
      { aggregate: "GOAL", state: "EXECUTION_ENABLED", extra: 1 },
      null, undefined, "GOAL", { aggregate: "GOAL" },
    ]) {
      expect(buildNextAllowedCommands(source, [entry("goal.pause", "a")]))
        .toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    }
    expect(Object.isFrozen(EMPTY_NEXT_ALLOWED_COMMANDS)).toBe(true);
    expect(EMPTY_NEXT_ALLOWED_COMMANDS).toEqual([]);
  });

  it("fails closed on revoked proxies instead of throwing", () => {
    const source = Proxy.revocable({}, {});
    const entries = Proxy.revocable([], {});
    const item = Proxy.revocable({}, {});
    source.revoke();
    entries.revoke();
    item.revoke();
    const known = { aggregate: "GOAL", state: "DRAFT" };
    expect(() => buildNextAllowedCommands(source.proxy, [])).not.toThrow();
    expect(buildNextAllowedCommands(source.proxy, [])).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(buildNextAllowedCommands(known, entries.proxy)).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(buildNextAllowedCommands(known, [item.proxy])).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
  });

  it("omits affordances from historical results and flags refresh", () => {
    const fresh = freshRuntimeResult(SOURCE, [entry("goal.pause", "a")]);
    expect(fresh).toMatchObject({ historical: false, requiresAffordanceRefresh: false });
    expect(kinds(fresh.nextAllowedCommands)).toEqual(["goal.pause:a"]);
    expect(Object.isFrozen(fresh)).toBe(true);
    const replay = historicalRuntimeResult();
    expect(replay).toMatchObject({ historical: true, requiresAffordanceRefresh: true });
    expect(replay.nextAllowedCommands).toBe(EMPTY_NEXT_ALLOWED_COMMANDS);
    expect(Object.isFrozen(replay)).toBe(true);
  });
});

it("loads the runtime contracts in Node's strip-types runtime", async () => {
  const payload = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(new URL("./runtime-entrypoint-smoke-worker.mjs", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`runtime smoke worker exited with ${code}`));
    });
  });

  expect(payload).toEqual({
    affordanceKinds: ["goal.pause"],
    commandEnvelopeVersion: "moe-runtime-command/1",
    outcome: "IMPORTED",
    queryOk: true,
    unknownErrorCode: "UNKNOWN_ERROR",
    unknownSourceIsEmpty: true,
  });
});
