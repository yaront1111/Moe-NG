import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { SESSION_AUTHORITY_SCHEMA_VERSION } from "./session-authority-contracts.js";
import {
  buildReplayMarkerDecisionLeg,
  commitAuthorityDecisionLegs,
  observeReplayMarker,
  replayAggregateId,
} from "./session-authority-store.js";
import type { ReplayMarker } from "./session-authority-store.js";

const PROJECT_ID = "project-replay-marker";
const VALID_DIGEST = "ab".repeat(32);
const DECIDED_AT = "2026-08-30T08:00:00.000Z";
const decoder = new TextDecoder("utf-8", { fatal: true });
const directories: string[] = [];
const stores: SqliteEventStore[] = [];
const MALFORMED_DIGESTS: readonly unknown[] = Object.freeze([
  "",
  "ab",
  "gg".repeat(32),
  "AB".repeat(32),
  23,
]);

const RACE_WORKER = String.raw`
const { workerData } = require("node:worker_threads");
const view = new Int32Array(workerData.gate);
let store;
(async () => {
  const storeModule = await import(workerData.storeUrl);
  const authority = await import(workerData.authorityUrl);
  store = storeModule.SqliteEventStore.openForProject(workerData.path, workerData.projectId);
  Atomics.add(view, 1, 1);
  Atomics.notify(view, 1);
  Atomics.wait(view, 0, 0);
  const outcome = authority.observeReplayMarker(store, workerData.marker).outcome;
  Atomics.store(view, 2 + workerData.index, outcome === "FRESH" ? 1 : outcome === "REPLAYED" ? 2 : 3);
})().catch(() => {
  Atomics.store(view, 2 + workerData.index, -1);
  process.exitCode = 1;
}).finally(() => store?.close());
`;

interface Harness {
  readonly path: string;
  store: SqliteEventStore;
  readonly reopen: () => SqliteEventStore;
}

function harness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), "moe-replay-marker-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const state: Harness = {
    path,
    store: SqliteEventStore.openForProject(path, PROJECT_ID),
    reopen: (): SqliteEventStore => {
      state.store.close();
      state.store = SqliteEventStore.openForProject(path, PROJECT_ID);
      stores.push(state.store);
      return state.store;
    },
  };
  stores.push(state.store);
  return state;
}

function marker(replayDigest: unknown = VALID_DIGEST): ReplayMarker {
  return Object.freeze({
    decidedAt: DECIDED_AT,
    principalId: "principal-replay-marker",
    projectId: PROJECT_ID,
    replayDigest,
  }) as ReplayMarker;
}

function decodePayload(payload: Uint8Array): unknown {
  return JSON.parse(decoder.decode(payload)) as unknown;
}

function countLegCommits(store: SqliteEventStore): {
  readonly calls: () => number;
  readonly port: SqliteEventStore;
} {
  let calls = 0;
  const port = new Proxy(store, {
    get: (target, property) => {
      if (property === "commitExpectedVersionDecisionLegs") {
        return (input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0]) => {
          calls += 1;
          return target.commitExpectedVersionDecisionLegs(input);
        };
      }
      if (property === "commitExpectedVersionDecision") return () => { throw new Error("single-decision seam called"); };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { calls: () => calls, port };
}

function workerExit(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`replay race worker exited ${code}`));
    });
  });
}
afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close();
    } catch {
      // Reopen closes the prior handle before registering its replacement.
    }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
  }
});

describe("session-authority replay-marker decision legs", () => {
  it("rejects every malformed digest before any store can be called", () => {
    // The pure builder accepts no store parameter, so zero store calls is structural.
    let swept = 0;
    for (const replayDigest of MALFORMED_DIGESTS) {
      expect.soft(buildReplayMarkerDecisionLeg(marker(replayDigest))).toBeNull();
      swept += 1;
    }
    expect(MALFORMED_DIGESTS.length).toBeGreaterThan(0);
    expect(swept).toBe(MALFORMED_DIGESTS.length);
  });

  it("builds exactly one frozen leg with the unchanged persisted roster", () => {
    const plan = buildReplayMarkerDecisionLeg(marker());
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("valid replay digest was refused");
    expect(plan.leg.events).toHaveLength(1);
    expect(decoder.decode(plan.leg.events[0]!.payload)).toBe(`{"replayDigest":"${VALID_DIGEST}"}`);
    expect({
      ...plan,
      leg: {
        ...plan.leg,
        events: plan.leg.events.map((event) => ({
          ...event,
          payload: decodePayload(event.payload),
        })),
      },
    }).toEqual({
      commandId: `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${VALID_DIGEST}`,
      commandKind: "OBSERVE_REPLAY",
      correlationId: `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay`,
      leg: {
        aggregateId: replayAggregateId(VALID_DIGEST),
        events: [{
          domainSchemaVersion: SESSION_AUTHORITY_SCHEMA_VERSION,
          eventId:
            `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${VALID_DIGEST}` +
            "/SessionAuthorityReplayObserved",
          eventType: "SessionAuthorityReplayObserved",
          payload: { replayDigest: VALID_DIGEST },
        }],
        expectedVersion: 0,
      },
      requestFacts: { kind: "OBSERVE_REPLAY", replayDigest: VALID_DIGEST },
      resultFacts: { observed: true, replayDigest: VALID_DIGEST },
    });
    expect([
      plan, plan.leg, plan.leg.events, plan.leg.events[0],
      plan.requestFacts, plan.resultFacts,
    ].every(Object.isFrozen)).toBe(true);
  });

  it("persists one fresh observation and reports a second observation as replayed", () => {
    const state = harness();
    const replayMarker = marker();
    const counted = countLegCommits(state.store);
    const first = observeReplayMarker(counted.port, replayMarker);
    expect(first).toEqual({
      outcome: "FRESH",
      receipt: {
        aggregateId: replayAggregateId(VALID_DIGEST),
        committedAt: DECIDED_AT,
        currentVersion: 1,
        eventId:
          `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${VALID_DIGEST}` +
          "/SessionAuthorityReplayObserved",
        previousVersion: 0,
        replayDigest: VALID_DIGEST,
      },
    });
    expect(observeReplayMarker(counted.port, replayMarker)).toEqual({ outcome: "REPLAYED" });
    expect(counted.calls()).toBe(2);
    const events = state.store.readEvents(replayAggregateId(VALID_DIGEST));
    expect(events).toHaveLength(1);
    expect(events.map((event) => ({
      domainSchemaVersion: event.domainSchemaVersion,
      eventId: event.eventId,
      eventType: event.eventType,
      payload: decodePayload(event.payload),
    }))).toEqual([{
      domainSchemaVersion: SESSION_AUTHORITY_SCHEMA_VERSION,
      eventId:
        `${SESSION_AUTHORITY_SCHEMA_VERSION}/replay/${VALID_DIGEST}` +
        "/SessionAuthorityReplayObserved",
      eventType: "SessionAuthorityReplayObserved",
      payload: { replayDigest: VALID_DIGEST },
    }]);
  });

  it("reports a durable replay after the store is reopened", () => {
    const state = harness();
    const replayMarker = marker();
    expect(observeReplayMarker(state.store, replayMarker).outcome).toBe("FRESH");
    expect(observeReplayMarker(state.reopen(), replayMarker)).toEqual({ outcome: "REPLAYED" });
    expect(state.store.readEvents(replayAggregateId(VALID_DIGEST))).toHaveLength(1);
  });

  it("fences two concurrent observations to one fresh and one replayed result", async () => {
    const state = harness();
    state.store.close();
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    const view = new Int32Array(gate);
    const common = {
      authorityUrl: new URL("./session-authority-store.js", import.meta.url).href,
      gate,
      marker: marker(),
      path: state.path,
      projectId: PROJECT_ID,
      storeUrl: import.meta.resolve("@moe/store"),
    };
    const workers = [0, 1].map((index) => new Worker(RACE_WORKER, {
      eval: true,
      workerData: { ...common, index },
    }));
    const exits = workers.map(workerExit);
    for (let attempts = 0; Atomics.load(view, 1) < 2; attempts += 1) {
      if (attempts >= 400) {
        await Promise.all(workers.map((worker) => worker.terminate()));
        await Promise.allSettled(exits);
        throw new Error("replay race workers did not become ready");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0, 2);
    for (const exit of await Promise.allSettled(exits)) {
      if (exit.status === "rejected") throw exit.reason;
    }
    expect([Atomics.load(view, 2), Atomics.load(view, 3)].sort()).toEqual([1, 2]);
    state.store = SqliteEventStore.openForProject(state.path, PROJECT_ID);
    stores.push(state.store);
    expect(state.store.readEvents(replayAggregateId(VALID_DIGEST))).toHaveLength(1);
  });

  it("refuses a command id already committed under a different command kind", () => {
    const state = harness();
    const replayMarker = marker();
    const plan = buildReplayMarkerDecisionLeg(replayMarker);
    if (plan === null) throw new Error("valid replay digest was refused");
    const counted = countLegCommits(state.store);
    const foreign = commitAuthorityDecisionLegs(counted.port, {
      commandId: plan.commandId,
      commandKind: "FOREIGN_REPLAY_OBSERVATION",
      correlationId: plan.correlationId,
      decidedAt: DECIDED_AT,
      principalId: replayMarker.principalId,
      projectId: replayMarker.projectId,
      requestFacts: plan.requestFacts,
      resultFacts: plan.resultFacts,
    }, [plan.leg]);
    expect(foreign).toMatchObject({ ok: true, disposition: "DECIDED" });
    expect(commitAuthorityDecisionLegs(counted.port, {
      commandId: plan.commandId,
      commandKind: plan.commandKind,
      correlationId: plan.correlationId,
      decidedAt: replayMarker.decidedAt,
      principalId: replayMarker.principalId,
      projectId: replayMarker.projectId,
      requestFacts: plan.requestFacts,
      resultFacts: plan.resultFacts,
    }, [plan.leg])).toEqual({
      ok: false,
      code: "SESSION_AUTHORITY_COMMAND_CONFLICT",
      layer: "DURABLE_STORE",
    });
    expect(counted.calls()).toBe(1);
    expect(state.store.readEvents(replayAggregateId(VALID_DIGEST))).toHaveLength(1);
  });
});
