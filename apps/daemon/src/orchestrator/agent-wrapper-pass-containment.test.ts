/**
 * THE PASS CONTAINS ITS TWO LEDGER READS.
 *
 * `runPass` reads the offer surface and, per step, the provider pause; both walk the decision
 * ledger through `decisionsOf`, which throws DurableStoreError STORE_BUSY by design when another
 * connection commits during the walk three times running. Uncaught, that rejection left
 * runOnce, reached `await wrapper.runOnce()` in the binary's loop, and main's finally tree-killed
 * every live seat (measured 2026-09-13). The arms below drive BOTH the injected throw and the
 * real one: two SqliteEventStore connections on one file, the wrapper's handle enrolled in the
 * ledger memo exactly as agent-wrapper-main.ts enrolls it, the second connection committing
 * before every page the first one reads. Nothing is stubbed to throw in those arms.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { enrollDecisionLedgerMemo } from "../decision-ledger-memo.js";
import type { AffordancePort } from "../http/affordance-contract.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { createProviderPauseGate } from "./agent-provider-pause.js";
import type { ProviderPauseGate } from "./agent-provider-pause.js";
import { staffingSurfaceOf } from "./agent-staffing-surface.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { AgentWrapperConfig } from "./agent-wrapper.js";

const OPERATOR = "wrapper-operator-credential";
// The provider authenticates minted sessions against the real clock.
const NOW = Date.now();
const CHILD_PID = 909_090;
const encoder = new TextEncoder();

const sandboxes: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) {
    try { dispose(); } catch { /* a handle closed by its arm */ }
  }
  for (const sandbox of sandboxes.splice(0)) {
    rmSync(sandbox, { force: true, maxRetries: 5, recursive: true });
  }
});

function harness(projectId: string) {
  const sandbox = mkdtempSync(join(tmpdir(), "moe-wrapper-pass-"));
  sandboxes.push(sandbox);
  const storePath = join(sandbox, "store.db");
  const provider = createStoreDependencies({
    credential: OPERATOR, principalId: "operator-local", projectId, storePath,
  });
  disposers.push(() => { provider.close(); });
  const port = provider.affordances?.();
  if (port === undefined) throw new Error("provider serves no affordances");
  return { deps: provider.provide(), port, projectId, storePath };
}

/** A wrapper over the harness whose spawns are admitted and held open, and counted. */
function wrapperOver(
  h: ReturnType<typeof harness>, overrides: Partial<AgentWrapperConfig>,
): { readonly spawned: string[]; readonly wrapper: ReturnType<typeof createAgentWrapper> } {
  let minted = 0;
  const spawned: string[] = [];
  const wrapper = createAgentWrapper({
    affordances: h.port, claimTtlMs: 60_000, clock: () => NOW, deps: h.deps, maxAgents: 1,
    mintSecret: () => `pass-${String(minted += 1).padStart(4, "0")}${"0".repeat(28)}`,
    operatorCredential: OPERATOR,
    spawnAgent: async (request) => {
      spawned.push(request.workItemId);
      return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
    },
    ...overrides,
  });
  return { spawned, wrapper };
}

/**
 * The wrapper's handle, ENROLLED like the binary's, presented so that the OTHER connection lands
 * a real decision before every page it reads while armed — the shape of the daemon committing
 * on control-room polls while the wrapper walks. The STORE_BUSY is then the memo's own, raised
 * because `PRAGMA data_version` moved under the other connection's commit on all three attempts.
 */
function contendedHandle(storePath: string, projectId: string) {
  const own = SqliteEventStore.openForProject(storePath, projectId);
  const other = SqliteEventStore.openForProject(storePath, projectId);
  disposers.push(() => { other.close(); }, () => { own.close(); });
  let armed = false;
  let commits = 0;
  const commit = (): void => {
    commits += 1;
    const bytes = encoder.encode(`contend-${String(commits)}`);
    const landed = other.commitExpectedVersionDecision({
      commandKind: "test.contend", committedResultBytes: bytes, correlationId: "contend",
      decidedAt: new Date(NOW).toISOString(),
      events: [{ eventId: `contend-${String(commits)}`, eventType: "Contended", payload: bytes }],
      expectedVersion: 0,
      key: { commandId: `cmd-contend-${String(commits)}`, principalId: "contender", projectId },
      requestBytes: bytes, targetAggregateId: `contend-${String(commits)}`,
    });
    if (landed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      throw new Error(landed.decision.resultCode);
    }
  };
  const handle = new Proxy(own, {
    get(target, property, receiver): unknown {
      if (property === "readCommandDecisionsAfter") {
        return (...args: unknown[]): unknown => {
          if (armed) commit();
          return (target.readCommandDecisionsAfter as (...a: unknown[]) => unknown)
            .apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  enrollDecisionLedgerMemo(handle);
  return { arm: (on: boolean): void => { armed = on; }, commits: (): number => commits, handle };
}

describe("the pass contains a surface read that throws", () => {
  it("reports SURFACE_READ_FAILED for the pass and staffs on the next one", async () => {
    const h = harness("proj-pass-surface-throw");
    let throwing = true;
    const flaky: AffordancePort = {
      boundProjectId: h.port.boundProjectId,
      readSurface: () => {
        if (throwing) throw new Error("STORE_BUSY: decision history changed during its read");
        return h.port.readSurface();
      },
    };
    const { spawned, wrapper } = wrapperOver(h, { affordances: flaky });

    // The code every sibling read already answers (agent-authority-cleanup.ts), never a throw.
    await expect(wrapper.runOnce()).resolves.toEqual({
      active: 0, spawned: [], surfaceOutcome: "SURFACE_READ_FAILED",
    });
    expect(spawned).toEqual([]);
    throwing = false;
    // One failed pass poisons nothing: the next read staffs as if the first never happened.
    const next = await wrapper.runOnce();
    expect(next.surfaceOutcome).toBe("SURFACE");
    expect(next.spawned.map((entry) => entry.outcome)).toEqual(["SPAWNED"]);
  });
});

describe("the pass contains a pause read that throws", () => {
  it("skips the step by code with no attempt charged and no spawn, then staffs once readable", async () => {
    const h = harness("proj-pass-pause-throw");
    let throwing = true;
    const gate: ProviderPauseGate = {
      exitObserver: () => () => "FAILED",
      paused: () => {
        if (throwing) throw new Error("STORE_BUSY: decision history changed during its read");
        return null;
      },
    };
    const { spawned, wrapper } = wrapperOver(h, { maxItemAttempts: 1, providerPause: gate });

    const report = await wrapper.runOnce();
    expect(report.surfaceOutcome).toBe("SURFACE");
    // Not a pause: a pause is a fact the ledger answered, and this one could not be read.
    expect(report.paused).toBeUndefined();
    expect(report.spawned.length).toBeGreaterThan(0);
    expect(report.spawned.every((entry) => entry.outcome === "PROVIDER_PAUSE_UNREADABLE"
      && entry.sessionId === null && entry.refusal === null)).toBe(true);
    expect(spawned).toEqual([]);
    throwing = false;
    // maxItemAttempts is 1: had the unreadable pass charged an attempt, this pass would report
    // STAFFING_ATTEMPTS_EXHAUSTED instead of staffing the item.
    const next = await wrapper.runOnce();
    expect(next.spawned.map((entry) => entry.outcome)).toEqual(["SPAWNED"]);
  });
});

describe("the real STORE_BUSY: two connections on one file, the wrapper's handle enrolled", () => {
  it("surface read: resolves SURFACE_READ_FAILED under contention and SURFACE once it lifts", async () => {
    const h = harness("proj-pass-busy-surface");
    const contended = contendedHandle(h.storePath, h.projectId);
    let ids = 0;
    const port = staffingSurfaceOf(createAffordancePort({
      mintId: (kind) => `busy-${kind}-${String(ids += 1)}`, projectId: h.projectId,
      store: contended.handle,
    }));
    const { wrapper } = wrapperOver(h, { affordances: port, maxAgents: 0 });

    // Positive control first: the same enrolled handle, uncontended, reads the surface.
    expect((await wrapper.runOnce()).surfaceOutcome).toBe("SURFACE");
    contended.arm(true);
    const before = contended.commits();
    await expect(wrapper.runOnce()).resolves.toEqual({
      active: 0, spawned: [], surfaceOutcome: "SURFACE_READ_FAILED",
    });
    // The memo's three attempts each saw the other connection commit: the throw was the real one.
    expect(contended.commits() - before).toBeGreaterThanOrEqual(3);
    contended.arm(false);
    expect((await wrapper.runOnce()).surfaceOutcome).toBe("SURFACE");
  });

  it("pause read: skips every step by code under contention and staffs once it lifts", async () => {
    const h = harness("proj-pass-busy-pause");
    const contended = contendedHandle(h.storePath, h.projectId);
    const gate = createProviderPauseGate({
      clock: () => NOW, log: () => undefined, projectId: h.projectId, provider: "claude",
      store: contended.handle,
    });
    // The surface is read over the composition's own handle, which this arm never contends.
    const { spawned, wrapper } = wrapperOver(h, { providerPause: gate });

    contended.arm(true);
    const before = contended.commits();
    const report = await wrapper.runOnce();
    expect(report.surfaceOutcome).toBe("SURFACE");
    expect(report.spawned.length).toBeGreaterThan(0);
    expect(report.spawned.every((entry) => entry.outcome === "PROVIDER_PAUSE_UNREADABLE"))
      .toBe(true);
    expect(spawned).toEqual([]);
    expect(contended.commits() - before).toBeGreaterThanOrEqual(3);
    contended.arm(false);
    const next = await wrapper.runOnce();
    expect(next.spawned.map((entry) => entry.outcome)).toEqual(["SPAWNED"]);
  });
});
