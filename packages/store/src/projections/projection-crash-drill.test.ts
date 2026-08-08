import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { relayMessage } from "../outbox-relay/transactional-outbox-relay.js";
import { DurableStoreError } from "../store-contracts.js";
import { SqliteEventStore } from "../sqlite-event-store.js";
import {
  CRASH_AGGREGATE, DRILL_ORIGIN_STATE, DRILL_PROJECTION, DRILL_REDUCERS, DRILL_UPCASTER,
  PLAIN_EVENT, countRows, crashCommit, drillCommitInput, drillRelayRequest, ledgerEnd,
  readDurableProjection, relayHistory, withDrillDatabase, withDrillDirectory, withDrillStore,
} from "./projection-drill-test-helpers.js";
import type { DrillCommit, DurableProjection } from "./projection-drill-test-helpers.js";
import { rebuildProjection } from "./projection-rebuild.js";
import type {
  ProjectionLedgerSource, ProjectionRebuildResult, ProjectionRebuilt,
} from "./projection-rebuild.js";

/**
 * DoD 1: SIGKILL at every transaction boundary leaves no partial state. The child dies inside
 * an open transaction, so only WAL recovery decides what survived — a RAISE(ABORT) trigger
 * would only prove the rollback path. Exit status is asserted as "non-zero" and never by
 * signal name: a SIGKILL child reports code 1 / signal null on Windows and code null /
 * SIGKILL on POSIX.
 */

const WORKER = fileURLToPath(new URL("./projection-crash-worker.mjs", import.meta.url));
const MATRIX_SEED = 1;
/** Seeds chosen so the fuzz tick target spans all three relayed transactions (4, 8 and 12
 *  ticks in), not just the first one a low target would always hit. */
const FUZZ_SEEDS = Object.freeze([7, 12, 6, 1, 30, 4]);

interface BoundaryCase {
  /** Relay deliveries that must have survived the kill; the rest of the matrix is derived. */
  readonly deliveries: number;
  readonly name: string;
}

/** The literal boundary list step 1 enumerated. The matrix asserts its own length against it,
 *  so a run that silently degenerated to zero spawns fails instead of passing. */
const BOUNDARIES: readonly BoundaryCase[] = Object.freeze([
  { deliveries: 1, name: "DOMAIN_EVENTS_INSERT" },
  { deliveries: 1, name: "OUTBOX_MESSAGES_INSERT" },
  { deliveries: 0, name: "PROJECTIONS_INSERT" },
  { deliveries: 1, name: "PROJECTIONS_UPDATE" },
  { deliveries: 1, name: "INBOX_RECEIPTS_INSERT" },
  { deliveries: 1, name: "EVENT_SUBSCRIPTIONS_INSERT" },
  { deliveries: 1, name: "CURSOR_GENERATIONS_INSERT" },
  { deliveries: 1, name: "REDUCER" },
  { deliveries: 2, name: "POST_COMMIT" },
  { deliveries: 1, name: "FUZZ" },
]);

interface CrashRun {
  readonly marker: boolean;
  readonly nonZeroExit: boolean;
  readonly stderr: string;
}
interface Surviving {
  readonly events: number;
  readonly foreignKeyViolations: number;
  readonly generations: number;
  readonly inbox: number;
  readonly integrity: string;
  readonly ledgerEnd: bigint;
  readonly outbox: number;
  readonly projection: DurableProjection | null;
  readonly subscriptions: number;
}

function spawnCrash(path: string, boundary: string, seed = MATRIX_SEED, skip = 0): CrashRun {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", WORKER, path, boundary, String(seed), String(skip)],
    { encoding: "utf8", timeout: 30_000 },
  );
  return {
    marker: child.stdout.includes(`BOUNDARY:${boundary}`),
    nonZeroExit: child.status !== 0,
    stderr: child.stderr,
  };
}

function surviving(path: string): Surviving {
  return withDrillDatabase(path, (database) => ({
    events: countRows(database, "domain_events"),
    foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all().length,
    generations: countRows(database, "cursor_generations"),
    inbox: countRows(database, "inbox_receipts"),
    integrity: String(database.prepare("PRAGMA integrity_check").get()?.["integrity_check"]),
    ledgerEnd: ledgerEnd(database),
    outbox: countRows(database, "outbox_messages"),
    projection: readDurableProjection(database),
    subscriptions: countRows(database, "event_subscriptions"),
  }));
}

/** `open` re-runs validateSchema, so a schema the kill left half-written cannot pass. The
 *  health report is returned rather than a bare `true` so the caller asserts SQLite's own
 *  verdict on the reopened file instead of merely that nothing threw. */
function reopens(path: string): { readonly quickCheck: string; readonly violations: number } {
  const store = SqliteEventStore.open(path);
  try {
    const health = store.getHealth();
    return { quickCheck: health.quickCheck, violations: health.foreignKeyViolations };
  } finally {
    store.close();
  }
}

function reconcile(path: string, pageLimit = 100): ProjectionRebuildResult {
  return withDrillStore(path, (store) => withDrillDatabase(path, (database) =>
    rebuildProjection(database, {
      name: DRILL_PROJECTION, pageLimit, reducers: DRILL_REDUCERS, source: store,
      state: DRILL_ORIGIN_STATE, upcaster: DRILL_UPCASTER,
    })));
}

function rebuiltAt(path: string, pageLimit = 100): ProjectionRebuilt {
  const result = reconcile(path, pageLimit);
  if (result.outcome !== "REBUILT") {
    throw new Error(`expected a completed rebuild, got ${result.code} at ${result.layer}`);
  }
  return result;
}

/**
 * The whole-prefix proof. `rebuildProjection` walks the surviving ledger from the origin,
 * clamps at the durable checkpoint and refuses STATE_CONFLICT unless the recomputed digest
 * equals the stored one — so a REBUILT outcome means the durable row is exactly the fold of a
 * whole ledger prefix. The explicit counts around it rule out the other half-states: an event
 * without its outbox row, an inbox receipt without its projection advance, or the reverse.
 */
function assertWholePrefix(path: string, at: string, deliveries: number): void {
  const state = surviving(path);
  expect(state.integrity, `${at} integrity_check`).toBe("ok");
  expect(state.foreignKeyViolations, `${at} foreign_key_check`).toBe(0);
  expect(reopens(path), `${at} reopen`).toStrictEqual({ quickCheck: "ok", violations: 0 });
  expect(state.events, `${at} events`).toBe(deliveries);
  expect(state.outbox, `${at} outbox`).toBe(deliveries);
  expect(state.inbox, `${at} inbox receipts`).toBe(deliveries);
  expect(state.ledgerEnd, `${at} ledger end`).toBe(BigInt(deliveries));
  expect(state.subscriptions, `${at} subscriptions`).toBe(0);
  expect(state.generations, `${at} generations`).toBe(0);

  const rebuilt = reconcile(path);
  if (rebuilt.outcome !== "REBUILT") {
    throw new Error(`${at}: the surviving state is not a whole-prefix fold of the ledger — ` +
      `${rebuilt.code} at ${rebuilt.layer}: ${rebuilt.detail}`);
  }
  expect(rebuilt.checkpoint.globalPosition, `${at} rebuild checkpoint`).toBe(BigInt(deliveries));
  if (deliveries === 0) {
    expect(state.projection, `${at} durable row`).toBeNull();
    return;
  }
  expect(state.projection?.position, `${at} durable position`).toBe(BigInt(deliveries));
  expect(state.projection?.digest, `${at} durable digest`).toBe(rebuilt.stateDigest);
}

describe("crash drill matrix", () => {
  it("leaves no partial state at any transaction boundary", () => {
    const covered: string[] = [];
    for (const boundary of BOUNDARIES) {
      withDrillDirectory((path) => {
        const run = spawnCrash(path, boundary.name);
        expect(run.marker, `${boundary.name} marker (stderr: ${run.stderr})`).toBe(true);
        expect(run.nonZeroExit, `${boundary.name} exit status`).toBe(true);
        assertWholePrefix(path, boundary.name, boundary.deliveries);
      });
      covered.push(boundary.name);
    }

    expect(covered).toStrictEqual(BOUNDARIES.map((boundary) => boundary.name));
    expect(covered.length).toBe(BOUNDARIES.length);
    expect(covered.length).toBeGreaterThan(0);
    expect(new Set(covered).size).toBe(BOUNDARIES.length);
  }, 180_000);

  it("survives everything the COMMIT already accepted", () => {
    withDrillDirectory((path) => {
      const run = spawnCrash(path, "POST_COMMIT");

      expect(run.marker).toBe(true);
      expect(run.nonZeroExit).toBe(true);
      const state = surviving(path);
      // The opposite arm of all-or-nothing: the kill landed AFTER the commit returned, so
      // both deliveries and every effect they owed must still be on disk.
      expect(state.events).toBe(2);
      expect(state.outbox).toBe(2);
      expect(state.inbox).toBe(2);
      expect(state.projection?.position).toBe(2n);
      expect(state.integrity).toBe("ok");
    });
  }, 60_000);

  it("recovers from a seeded kill wherever the fuzz lands it", () => {
    const survivors: number[] = [];
    for (const seed of FUZZ_SEEDS) {
      withDrillDirectory((path) => {
        const run = spawnCrash(path, "FUZZ", seed);
        expect(run.marker, `fuzz seed ${seed} marker (stderr: ${run.stderr})`).toBe(true);
        expect(run.nonZeroExit, `fuzz seed ${seed} exit status`).toBe(true);
        // Where the fuzz landed is not known ahead of time, so the surviving event count is
        // the observed one; the outbox, inbox, ledger-end and durable-digest comparisons
        // against it are what bite here.
        const state = surviving(path);
        assertWholePrefix(path, `fuzz seed ${seed}`, state.events);
        survivors.push(state.events);
      });
    }

    expect(survivors.length).toBe(FUZZ_SEEDS.length);
    expect(survivors.length).toBeGreaterThan(0);
    // A fuzz that always died at the same statement would cover exactly one boundary while
    // looking like six cases.
    expect(new Set(survivors).size).toBeGreaterThan(2);
  }, 180_000);
});

/** Fires `run` just before the rebuild's `at`-th ledger read, so a foreign writer lands
 *  between two of its persist transactions rather than before or after the whole walk. */
function interleaving(
  store: SqliteEventStore, at: number, run: () => void,
): ProjectionLedgerSource {
  let reads = 0;
  return {
    readEventsAfter(after, limit) {
      reads += 1;
      if (reads === at) {
        run();
      }
      return store.readEventsAfter(after, limit);
    },
  };
}

/** A ledger view that stops at `ceiling`, so a second rebuild can be made to land on exactly
 *  the position the first one is about to write — the only way the compare-and-set, rather
 *  than the ahead-of-checkpoint guard, is the arm that refuses. */
function ceilingSource(store: SqliteEventStore, ceiling: bigint): ProjectionLedgerSource {
  return {
    readEventsAfter(after, limit) {
      const page = store.readEventsAfter(after, limit);
      const items = page.items.filter((event) => event.globalPosition <= ceiling);
      return {
        hasMore: items.length === page.items.length && page.hasMore,
        items, nextCursor: page.nextCursor,
      };
    },
  };
}

/** Two relayed deliveries followed by an unrelayed tail, so the durable checkpoint sits at 2
 *  while the ledger runs to 5 and a rebuild has several pages left to persist. */
function seedRacedLedger(path: string): ReturnType<typeof relayHistory> {
  return withDrillStore(path, (store) => {
    const carried = relayHistory(store, [crashCommit(0), crashCommit(1)]);
    for (let index = 2; index < 5; index += 1) {
      store.commit(drillCommitInput(crashCommit(index), index));
    }
    return { ...carried, versions: { [CRASH_AGGREGATE]: 5 } };
  });
}

function racedRebuild(path: string, at: number, run: (store: SqliteEventStore) => void): {
  readonly durable: DurableProjection | null; readonly result: ProjectionRebuildResult;
} {
  const result = withDrillStore(path, (store) => withDrillDatabase(path, (database) =>
    rebuildProjection(database, {
      name: DRILL_PROJECTION, pageLimit: 1, reducers: DRILL_REDUCERS,
      source: interleaving(store, at, () => {
        run(store);
      }),
      state: DRILL_ORIGIN_STATE, upcaster: DRILL_UPCASTER,
    })));
  return { durable: surviving(path).projection, result };
}

describe("combined idempotence", () => {
  it("dedupes a redelivery of the same inbound message across a crash and a restart", () => {
    withDrillDirectory((path) => {
      const run = spawnCrash(path, "PROJECTIONS_UPDATE");
      expect(run.marker, `stderr: ${run.stderr}`).toBe(true);
      expect(run.nonZeroExit).toBe(true);
      const before = rebuiltAt(path);
      expect(before.checkpoint.globalPosition).toBe(1n);
      const redelivery: DrillCommit = {
        aggregateId: CRASH_AGGREGATE, commandId: "cmd-redelivered",
        events: [{ eventId: "evt-redelivered", eventType: PLAIN_EVENT, payload: "redelivered" }],
        inboundId: crashCommit(0).messageId, messageId: "msg-redelivered",
      };
      const ask = (expectedVersion: number): ReturnType<typeof drillRelayRequest> =>
        drillRelayRequest(
          redelivery, expectedVersion, before.checkpoint.globalPosition, before.state,
        );

      withDrillStore(path, (store) => {
        // At the STALE expectedVersion the command layer refuses before apply ever runs, so
        // that arm proves nothing about the inbox — which is why the bump below is required.
        let stale: unknown = null;
        try {
          relayMessage(store, ask(0));
        } catch (error) {
          stale = error;
        }
        expect(stale).toBeInstanceOf(DurableStoreError);
        expect((stale as DurableStoreError).code).toBe("EXPECTED_VERSION_CONFLICT");

        const result = relayMessage(store, ask(1));

        expect(result.outcome).toBe("ALREADY_APPLIED");
        if (result.outcome !== "ALREADY_APPLIED") {
          throw new Error("unreachable");
        }
        expect(result.deduplicatedBy).toBe("INBOX");
        expect(result.commit).toBeNull();
      });

      const after = surviving(path);
      expect(after.projection).toStrictEqual({ digest: before.stateDigest, position: 1n });
      expect(after.events).toBe(1);
      expect(after.inbox).toBe(1);
      expect(after.outbox).toBe(1);
    });
  }, 60_000);

  it("resumes a rebuild killed mid-flight to the state an uninterrupted one reaches", () => {
    withDrillDirectory((crashed) => {
      withDrillDirectory((clean) => {
        const crash = spawnCrash(crashed, "REBUILD_PROJECTIONS_UPDATE", MATRIX_SEED, 2);
        expect(crash.marker, `stderr: ${crash.stderr}`).toBe(true);
        expect(crash.nonZeroExit).toBe(true);
        const reference = spawnCrash(clean, "NONE");
        expect(reference.nonZeroExit, `NONE stderr: ${reference.stderr}`).toBe(false);
        const uninterrupted = surviving(clean).projection;

        const partial = surviving(crashed);
        // Genuinely mid-rebuild: past the relayed checkpoint of 2, short of the ledger end.
        expect(partial.ledgerEnd).toBe(6n);
        expect(partial.projection?.position).toBe(3n);
        expect(uninterrupted?.position).toBe(6n);

        const resumed = rebuiltAt(crashed, 1);

        expect(resumed.checkpoint.globalPosition).toBe(6n);
        expect(resumed.stateDigest).toBe(uninterrupted?.digest);
        expect(surviving(crashed).projection).toStrictEqual(uninterrupted);
        // ...and resuming a completed rebuild once more still changes nothing.
        expect(rebuiltAt(crashed, 1).stateDigest).toBe(resumed.stateDigest);
        expect(surviving(crashed).projection).toStrictEqual(uninterrupted);
      });
    });
  }, 60_000);

  it("matches a cold rebuild after rebuild, relay, rebuild on the same ledger", () => {
    const history = [0, 1, 2, 3].map((index) => crashCommit(index));
    withDrillDirectory((mixed) => {
      withDrillDirectory((cold) => {
        const first = withDrillStore(mixed, (store) => relayHistory(store, history.slice(0, 3)));
        expect(rebuiltAt(mixed).stateDigest).toBe(first.digest);
        const second = withDrillStore(mixed, (store) =>
          relayHistory(store, history.slice(3), { start: first }));
        const interleaved = rebuiltAt(mixed);

        withDrillStore(cold, (store) => relayHistory(store, history));
        const single = rebuiltAt(cold);

        expect(interleaved.stateDigest).toBe(second.digest);
        expect(interleaved.stateDigest).toBe(single.stateDigest);
        expect(interleaved.checkpoint.globalPosition).toBe(single.checkpoint.globalPosition);
        expect(interleaved.state).toStrictEqual(single.state);
      });
    });
  }, 60_000);

  it("refuses when a relay advances the durable row past the rebuild's next page", () => {
    withDrillDirectory((path) => {
      const carried = seedRacedLedger(path);

      const raced = racedRebuild(path, 3, (store) => {
        relayHistory(store, [crashCommit(5)], { start: carried });
      });

      expect(raced.result.outcome).toBe("REFUSED");
      if (raced.result.outcome !== "REFUSED") {
        throw new Error("unreachable");
      }
      expect(raced.result.code).toBe("PROJECTION_REBUILD_STATE_CONFLICT");
      expect(raced.result.layer).toBe("STATE");
      expect(raced.result.fold).toBeNull();
      expect(raced.result.detail).toContain("runs ahead of");
      // The relay's advance stands; the rebuild did not roll it back to its own older fold.
      expect(raced.durable?.position).toBe(6n);
    });
  }, 60_000);

  it("loses its compare-and-set when another writer lands on the exact next position", () => {
    withDrillDirectory((path) => {
      seedRacedLedger(path);

      const raced = racedRebuild(path, 3, (store) => {
        withDrillDatabase(path, (database) => {
          const foreign = rebuildProjection(database, {
            name: DRILL_PROJECTION, pageLimit: 1, reducers: DRILL_REDUCERS,
            source: ceilingSource(store, 3n), state: DRILL_ORIGIN_STATE, upcaster: DRILL_UPCASTER,
          });
          if (foreign.outcome !== "REBUILT" || foreign.checkpoint.globalPosition !== 3n) {
            throw new Error(`the foreign writer did not land on position 3: ${foreign.outcome}`);
          }
        });
      });

      expect(raced.result.outcome).toBe("REFUSED");
      if (raced.result.outcome !== "REFUSED") {
        throw new Error("unreachable");
      }
      expect(raced.result.code).toBe("PROJECTION_REBUILD_STATE_CONFLICT");
      expect(raced.result.layer).toBe("STATE");
      // The position and digest guards both PASS here — the foreign row is exactly what this
      // rebuild recomputed — so the compare-and-set is the only arm that can refuse.
      expect(raced.result.detail).toContain("compare-and-set");
      expect(raced.durable?.position).toBe(3n);
    });
  }, 60_000);
});
