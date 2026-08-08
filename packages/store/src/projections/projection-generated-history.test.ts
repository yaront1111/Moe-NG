import { describe, expect, it } from "vitest";

import { canonicalProjectionState } from "../outbox-relay/outbox-relay-digests.js";
import { MAX_EVENTS_PER_COMMIT } from "../store-contracts.js";
import type { ProjectionReducer, ProjectionState } from "./projection-fold.js";
import {
  DRILL_ORIGIN_DIGEST, DRILL_ORIGIN_STATE, DRILL_PROJECTION, DRILL_REDUCERS, DRILL_UPCASTER,
  PLAIN_EVENT, UPCAST_EVENT, boundedInteger, countRows, mulberry32, readDurableProjection,
  relayHistory, withDrillDatabase, withDrillDirectory, withDrillStore,
} from "./projection-drill-test-helpers.js";
import type { DrillCommit, DrillEvent } from "./projection-drill-test-helpers.js";
import { rebuildProjection } from "./projection-rebuild.js";
import type { ProjectionRebuilt } from "./projection-rebuild.js";

/**
 * DoD 2 over randomized histories. Seeds are a fixed literal array and the PRNG is seeded
 * mulberry32, so every case is reproducible from its seed alone — there is no clock and no
 * `Math.random` anywhere in this file. The sweep asserts its own shape as well as its
 * subject: a run that generated zero cases, or committed fewer events than it generated,
 * fails rather than passing silently.
 */

const SEEDS = Object.freeze([1, 7, 13, 42, 101, 2_027, 31_337, 65_521]);
const UPCAST_SHARE = 0.4;

interface SweepCase {
  readonly committed: number;
  readonly durableDigest: string | null;
  readonly durablePosition: bigint;
  readonly generated: number;
  readonly incrementalDigest: string;
  readonly rebuildCheckpoint: bigint;
  readonly rebuildDigest: string;
  readonly seed: number;
  readonly upcastEvents: number;
}

interface GeneratedHistory {
  readonly commits: readonly DrillCommit[];
  readonly events: number;
  readonly upcastEvents: number;
}

function generateHistory(seed: number): GeneratedHistory {
  const next = mulberry32(seed);
  const aggregates = boundedInteger(next, 1, 4);
  const commitCount = boundedInteger(next, 1, 9);
  const commits: DrillCommit[] = [];
  let events = 0;
  let upcastEvents = 0;
  for (let index = 0; index < commitCount; index += 1) {
    const drafts: DrillEvent[] = [];
    for (let slot = 0, span = boundedInteger(next, 1, 4); slot < span; slot += 1) {
      const upcast = next() < UPCAST_SHARE;
      upcastEvents += upcast ? 1 : 0;
      events += 1;
      drafts.push({
        eventId: `evt-${seed}-${index}-${slot}`,
        eventType: upcast ? UPCAST_EVENT : PLAIN_EVENT,
        payload: `p-${seed}-${index}-${slot}-${"x".repeat(boundedInteger(next, 0, 12))}`,
      });
    }
    commits.push({
      aggregateId: `goal-${boundedInteger(next, 1, aggregates)}`,
      commandId: `cmd-${seed}-${index}`, events: Object.freeze(drafts),
      messageId: `msg-${seed}-${index}`,
    });
  }
  return Object.freeze({ commits: Object.freeze(commits), events, upcastEvents });
}

function rebuild(
  path: string, reducers: Readonly<Record<string, ProjectionReducer>> = DRILL_REDUCERS,
  state: ProjectionState = DRILL_ORIGIN_STATE,
): ProjectionRebuilt {
  const result = withDrillStore(path, (store) => withDrillDatabase(path, (database) =>
    rebuildProjection(database, {
      name: DRILL_PROJECTION, pageLimit: 100, reducers, source: store, state,
      upcaster: DRILL_UPCASTER,
    })));
  if (result.outcome !== "REBUILT") {
    throw new Error(`expected a completed rebuild, got ${result.code} at ${result.layer}`);
  }
  return result;
}

/** Relays the history, rebuilds it, and reports every quantity the sweep compares — including
 *  how much it generated, so a generator that quietly produced nothing cannot read as a pass. */
function sweepSeed(seed: number): SweepCase {
  const history = generateHistory(seed);
  let record!: SweepCase;
  withDrillDirectory((path) => {
    const incremental = withDrillStore(path, (store) => relayHistory(store, history.commits));
    const rebuilt = rebuild(path);
    expect(rebuilt.state, `seed ${seed} state`).toStrictEqual(incremental.state);
    const durable = withDrillDatabase(path, (database) => ({
      events: countRows(database, "domain_events"),
      projection: readDurableProjection(database),
    }));
    record = {
      committed: durable.events, durableDigest: durable.projection?.digest ?? null,
      durablePosition: durable.projection?.position ?? -1n, generated: history.events,
      incrementalDigest: incremental.digest, rebuildCheckpoint: rebuilt.checkpoint.globalPosition,
      rebuildDigest: rebuilt.stateDigest, seed, upcastEvents: history.upcastEvents,
    };
  });
  return record;
}

describe("generated history rebuild", () => {
  it("rebuilds every seeded history to its incrementally-relayed digest", () => {
    const cases = SEEDS.map((seed) => sweepSeed(seed));

    expect(cases.length).toBe(SEEDS.length);
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      const at = `seed ${item.seed}`;
      expect(item.generated, `${at} generated`).toBeGreaterThan(0);
      expect(item.committed, `${at} committed`).toBe(item.generated);
      expect(item.rebuildDigest, `${at} digest`).toBe(item.incrementalDigest);
      expect(item.durableDigest, `${at} durable digest`).toBe(item.rebuildDigest);
      expect(item.durablePosition, `${at} durable position`).toBe(item.rebuildCheckpoint);
      expect(item.rebuildCheckpoint, `${at} checkpoint`).toBe(BigInt(item.committed));
    }
    // A sweep whose every case folded to the same state would compare digests that agree for
    // the wrong reason, and a sweep that never routed an event through the upcaster would
    // leave the upcast hop untested.
    expect(new Set(cases.map((item) => item.rebuildDigest)).size).toBeGreaterThan(1);
    expect(cases.reduce((total, item) => total + item.upcastEvents, 0)).toBeGreaterThan(0);
  });

  it("rebuilds an empty ledger to the origin digest", () => {
    withDrillDirectory((path) => {
      withDrillStore(path, () => undefined);

      const rebuilt = rebuild(path);

      expect(rebuilt.checkpoint.globalPosition).toBe(0n);
      expect(rebuilt.stateDigest).toBe(DRILL_ORIGIN_DIGEST);
      expect(withDrillDatabase(path, (database) => countRows(database, "domain_events"))).toBe(0);
    });
  });

  it("rebuilds a single-event ledger", () => {
    withDrillDirectory((path) => {
      const history: readonly DrillCommit[] = [{
        aggregateId: "goal-solo", commandId: "cmd-solo",
        events: [{ eventId: "evt-solo", eventType: UPCAST_EVENT, payload: "solo" }],
        messageId: "msg-solo",
      }];
      const incremental = withDrillStore(path, (store) => relayHistory(store, history));

      const rebuilt = rebuild(path);

      expect(rebuilt.checkpoint.globalPosition).toBe(1n);
      expect(rebuilt.stateDigest).toBe(incremental.digest);
      expect(rebuilt.state["names"]).toStrictEqual(["up:solo"]);
    });
  });

  it("rebuilds one commit carrying the maximum event count across several pages", () => {
    withDrillDirectory((path) => {
      const events = Array.from({ length: MAX_EVENTS_PER_COMMIT }, (_unused, index) => ({
        eventId: `evt-max-${index}`,
        eventType: index % 3 === 0 ? UPCAST_EVENT : PLAIN_EVENT,
        payload: `max-${index}`,
      }));
      const incremental = withDrillStore(path, (store) => relayHistory(store, [{
        aggregateId: "goal-max", commandId: "cmd-max", events, messageId: "msg-max",
      }]));

      const rebuilt = rebuild(path);

      expect(rebuilt.checkpoint.globalPosition).toBe(BigInt(MAX_EVENTS_PER_COMMIT));
      expect(rebuilt.pages).toBe(3);
      expect(rebuilt.stateDigest).toBe(incremental.digest);
      expect(rebuilt.state).toStrictEqual(incremental.state);
      expect(rebuilt.state["count"]).toBe(MAX_EVENTS_PER_COMMIT);
    });
  });
});

/** `-0`, NaN, +/-Infinity, bigints, nesting, and two key insertion orders for the same
 *  content: values a naive canonicalizer either collapses or reorders. */
const EXOTIC_REDUCERS: Readonly<Record<string, ProjectionReducer>> = Object.freeze({
  [PLAIN_EVENT]: (state, event) => {
    const index = state["count"] as number;
    const nested = index % 2 === 0
      ? { alpha: index, beta: { delta: [1n, -2n, 9_007_199_254_740_993n], gamma: -0 } }
      : { beta: { gamma: -0, delta: [1n, -2n, 9_007_199_254_740_993n] }, alpha: index };
    return {
      ...state, count: index + 1, last: event.eventId, nested,
      ratios: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0],
      total: BigInt(index) * 1_000_000_000_000_000_000n,
    };
  },
  [UPCAST_EVENT]: (state, event) => ({ ...state, last: event.eventId }),
});

describe("canonicalization under a rebuild", () => {
  it("rebuilds a history whose state carries -0, NaN, Infinity, bigints and nesting", () => {
    withDrillDirectory((path) => {
      const commits: readonly DrillCommit[] = Array.from({ length: 6 }, (_unused, index) => ({
        aggregateId: `goal-${index % 2}`, commandId: `cmd-exotic-${index}`,
        events: [{
          eventId: `evt-exotic-${index}`, eventType: PLAIN_EVENT, payload: `exotic-${index}`,
        }],
        messageId: `msg-exotic-${index}`,
      }));
      const incremental = withDrillStore(path, (store) =>
        relayHistory(store, commits, { reducers: EXOTIC_REDUCERS }));

      const rebuilt = rebuild(path, EXOTIC_REDUCERS);

      expect(rebuilt.stateDigest).toBe(incremental.digest);
      expect(rebuilt.state).toStrictEqual(incremental.state);
      const ratios = rebuilt.state["ratios"] as readonly number[];
      expect(Number.isNaN(ratios[0])).toBe(true);
      expect(Object.is(ratios[3], -0)).toBe(true);
      expect(Object.is(ratios[4], 0)).toBe(true);
      expect(rebuilt.state["total"]).toBe(5_000_000_000_000_000_000n);
      expect(withDrillDatabase(path, (database) => readDurableProjection(database)?.digest))
        .toBe(rebuilt.stateDigest);
    });
  });

  it("gives the same digest to the same content under two key insertion orders", () => {
    const ordered = canonicalProjectionState({ alpha: 1, beta: { gamma: -0, delta: [1n] } });
    const shuffled = canonicalProjectionState({ beta: { delta: [1n], gamma: -0 }, alpha: 1 });
    const collapsed = canonicalProjectionState({ alpha: 1, beta: { gamma: 0, delta: [1n] } });

    expect(ordered?.digest).toBe(shuffled?.digest);
    // ...and does NOT collapse -0 onto 0, or the equality above would prove nothing.
    expect(collapsed?.digest).not.toBe(ordered?.digest);
  });
});
