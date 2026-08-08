import { writeSync } from "node:fs";

import { relayMessage } from "../outbox-relay/transactional-outbox-relay.js";
import { advanceGeneration } from "../subscriptions/subscription-writes.js";
import {
  DRILL_AT, DRILL_ORIGIN_DIGEST, DRILL_ORIGIN_STATE, DRILL_PROJECTION, DRILL_REDUCERS,
  DRILL_UPCASTER, PLAIN_EVENT, UPCAST_EVENT, boundedInteger, crashCommit, drillCommitInput,
  drillRelayRequest, mulberry32, openDrillStore,
} from "./projection-drill-test-helpers.ts";
import { rebuildProjection } from "./projection-rebuild.js";

/**
 * Crash injector. Kills its own process with SIGKILL at one named transaction boundary so the
 * WAL is left to recover, which is the only thing that proves crash safety — a RAISE(ABORT)
 * trigger only proves rollback. Table boundaries are reached by a user-defined function called
 * from a TEMP trigger installed on the STORE'S OWN connection: UDFs are per-connection, so a
 * permanent trigger created elsewhere would raise `no such function` and merely refuse.
 *
 * argv: <databasePath> <boundary> [seed] [skip]
 * Exit: never cleanly in a crash mode. 97 means the boundary was never reached, which the
 * parent must be able to tell apart from a working crash; 0 is only ever the NONE mode.
 */

const NEVER_REACHED = 97;
const RELAY_REFUSED = 96;
const ADVANCE_REFUSED = 95;
const REBUILD_REFUSED = 94;
const REBUILD_TAIL = 4;
const FUZZ_TICKS = 12;

const TRIGGER_TIMING = {
  CURSOR_GENERATIONS_INSERT: "BEFORE INSERT ON cursor_generations",
  DOMAIN_EVENTS_INSERT: "BEFORE INSERT ON domain_events",
  EVENT_SUBSCRIPTIONS_INSERT: "BEFORE INSERT ON event_subscriptions",
  INBOX_RECEIPTS_INSERT: "BEFORE INSERT ON inbox_receipts",
  OUTBOX_MESSAGES_INSERT: "BEFORE INSERT ON outbox_messages",
  PROJECTIONS_INSERT: "BEFORE INSERT ON projections",
  PROJECTIONS_UPDATE: "BEFORE UPDATE ON projections",
};

const [databasePath, boundary, rawSeed, rawSkip] = process.argv.slice(2);
const seed = Number.parseInt(rawSeed ?? "1", 10);
const skip = Number.parseInt(rawSkip ?? "0", 10);

/** The marker is flushed with writeSync because SIGKILL runs no exit handlers and a buffered
 *  console.log would lose the only evidence that the boundary was actually reached. */
function die(name) {
  writeSync(1, `BOUNDARY:${name}\n`);
  process.kill(process.pid, "SIGKILL");
  // Unreachable in practice; a throw keeps a kill that somehow did not land from letting the
  // interrupted statement complete and report a clean success.
  throw new Error(`SIGKILL at ${name} did not take effect`);
}

function fail(code, detail) {
  writeSync(2, `${detail}\n`);
  process.exit(code);
}

/**
 * `CommitApplyContext.database` is the only public route to the store's own connection. The
 * probe apply throws, so the whole transaction rolls back and the ledger is untouched — the
 * connection is captured without polluting the history the drill later reconciles.
 */
function stashConnection(store) {
  let connection = null;
  try {
    store.commitWithApply(drillCommitInput(crashCommit(9_000), 0), (context) => {
      connection = context.database;
      throw new Error("connection probe");
    });
  } catch (error) {
    if (connection === null) {
      throw error;
    }
  }
  return connection;
}

function armTrigger(connection, name, timing) {
  let seen = 0;
  connection.function("moe_crash_now", () => {
    seen += 1;
    if (seen > skip) {
      die(name);
    }
    return 0;
  });
  connection.exec(
    `CREATE TEMP TRIGGER moe_crash_${name} ${timing} BEGIN SELECT moe_crash_now(); END`,
  );
}

/** Every table at once, killing at a seeded tick, so boundaries between the statements no JS
 *  hook can reach are still covered. */
function armFuzz(connection) {
  const target = boundedInteger(mulberry32(seed), 1, FUZZ_TICKS);
  let ticks = 0;
  connection.function("moe_crash_now", () => {
    ticks += 1;
    if (ticks >= target) {
      die("FUZZ");
    }
    return 0;
  });
  for (const [name, timing] of Object.entries(TRIGGER_TIMING)) {
    connection.exec(
      `CREATE TEMP TRIGGER moe_fuzz_${name} ${timing} BEGIN SELECT moe_crash_now(); END`,
    );
  }
}

function relayOnce(store, index, carried, reducers) {
  const result = relayMessage(store, drillRelayRequest(
    crashCommit(index), index, carried.checkpoint, carried.state, reducers,
  ));
  if (result.outcome !== "APPLIED") {
    fail(RELAY_REFUSED, `RELAY_REFUSED:${result.code ?? result.outcome} at ${index}`);
  }
  return {
    checkpoint: result.checkpoint.globalPosition,
    digest: result.stateDigest,
    state: result.state,
  };
}

function relayRun(store, from, count, carried, reducers = DRILL_REDUCERS) {
  let next = carried;
  for (let index = from; index < from + count; index += 1) {
    next = relayOnce(store, index, next, reducers);
  }
  return next;
}

const ORIGIN = {
  checkpoint: 0n, digest: DRILL_ORIGIN_DIGEST, state: DRILL_ORIGIN_STATE,
};

function relayWorkload(store, connection) {
  const prelude = boundary === "PROJECTIONS_INSERT" ? 0 : 1;
  const carried = relayRun(store, 0, prelude, ORIGIN);
  armTrigger(connection, boundary, TRIGGER_TIMING[boundary]);
  relayRun(store, prelude, 1, carried);
}

/** Kills inside the fold, after the events and outbox rows were written but before the
 *  projection and inbox writes the same transaction still owes. */
function reducerWorkload(store) {
  const carried = relayRun(store, 0, 1, ORIGIN);
  relayRun(store, 1, 1, carried, {
    [PLAIN_EVENT]: () => die("REDUCER"),
    [UPCAST_EVENT]: () => die("REDUCER"),
  });
}

/** The opposite arm of all-or-nothing: everything the COMMIT accepted must still be there. */
function postCommitWorkload(store) {
  const carried = relayRun(store, 0, 1, ORIGIN);
  relayRun(store, 1, 1, carried);
  die("POST_COMMIT");
}

function subscriptionWorkload(store, connection) {
  const carried = relayRun(store, 0, 1, ORIGIN);
  armTrigger(connection, boundary, TRIGGER_TIMING[boundary]);
  const advanced = advanceGeneration(connection, {
    at: DRILL_AT,
    baselines: [{
      checkpoint: carried.checkpoint, projection: DRILL_PROJECTION,
      state: carried.state, stateDigest: carried.digest,
    }],
    reason: "crash-drill",
  });
  if (advanced.outcome !== "ADVANCED") {
    fail(ADVANCE_REFUSED, `ADVANCE_REFUSED:${advanced.code ?? advanced.outcome}`);
  }
}

function fuzzWorkload(store, connection) {
  armFuzz(connection);
  const carried = relayRun(store, 0, 3, ORIGIN);
  const advanced = advanceGeneration(connection, {
    at: DRILL_AT,
    baselines: [{
      checkpoint: carried.checkpoint, projection: DRILL_PROJECTION,
      state: carried.state, stateDigest: carried.digest,
    }],
    reason: "crash-drill",
  });
  if (advanced.outcome !== "ADVANCED") {
    fail(ADVANCE_REFUSED, `ADVANCE_REFUSED:${advanced.code ?? advanced.outcome}`);
  }
}

/**
 * Leaves an unrelayed ledger tail so the rebuild has several pages left to persist past the
 * durable checkpoint — without it a rebuild of a fully relayed ledger writes exactly once and
 * there is no mid-rebuild to interrupt. NONE runs the identical workload without arming, so
 * the parent has an uninterrupted reference to compare a resumed rebuild against.
 */
function rebuildWorkload(store, connection) {
  relayRun(store, 0, 2, ORIGIN);
  for (let index = 2; index < 2 + REBUILD_TAIL; index += 1) {
    store.commit(drillCommitInput(crashCommit(index), index));
  }
  if (boundary !== "NONE") {
    armTrigger(connection, boundary, TRIGGER_TIMING.PROJECTIONS_UPDATE);
  }
  const rebuilt = rebuildProjection(connection, {
    name: DRILL_PROJECTION, pageLimit: 1, reducers: DRILL_REDUCERS, source: store,
    state: DRILL_ORIGIN_STATE, upcaster: DRILL_UPCASTER,
  });
  if (rebuilt.outcome !== "REBUILT") {
    fail(REBUILD_REFUSED, `REBUILD_REFUSED:${rebuilt.code} at ${rebuilt.layer}`);
  }
}

const WORKLOADS = {
  CURSOR_GENERATIONS_INSERT: subscriptionWorkload,
  DOMAIN_EVENTS_INSERT: relayWorkload,
  EVENT_SUBSCRIPTIONS_INSERT: subscriptionWorkload,
  FUZZ: fuzzWorkload,
  INBOX_RECEIPTS_INSERT: relayWorkload,
  NONE: rebuildWorkload,
  OUTBOX_MESSAGES_INSERT: relayWorkload,
  POST_COMMIT: postCommitWorkload,
  PROJECTIONS_INSERT: relayWorkload,
  PROJECTIONS_UPDATE: relayWorkload,
  REBUILD_PROJECTIONS_UPDATE: rebuildWorkload,
  REDUCER: reducerWorkload,
};

const workload = Object.hasOwn(WORKLOADS, boundary ?? "") ? WORKLOADS[boundary] : null;
if (databasePath === undefined || workload === null) {
  fail(1, `UNKNOWN_BOUNDARY:${String(boundary)}`);
}

const store = openDrillStore(databasePath);
workload(store, stashConnection(store));
if (boundary === "NONE") {
  store.close();
  process.exit(0);
}
// A crash mode that gets here never reached its boundary; that must not read as a pass.
fail(NEVER_REACHED, `BOUNDARY_NEVER_REACHED:${boundary}`);
