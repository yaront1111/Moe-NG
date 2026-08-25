/**
 * The durable current-authority reader (task-738a12a816e8421a96edd84648565a38).
 *
 * THE HAPPY WORLD IS REAL, NOT SYNTHESISED. `seedActivationWorld` drives the production
 * bootstrap/planning/graph chain over a file-backed SQLite store, so the goal, the parent
 * planning run and the ACTIVE graph revision are all bytes production actually emits.
 *
 * THE HOSTILE WORLDS REPLACE ONE LEDGER ENTRY AT A TIME. `DurableLedger` is the reader's input
 * type, not an authority, so a hostile world is built by taking the REAL ledger and swapping the
 * single record under test. That isolates each tuple member: a test that rebuilt the whole world
 * could not tell which member the reader was actually consulting.
 *
 * Every refusal assertion names the exact code AND layer, and the delegated graph refusal also
 * pins the source code so a passthrough that invented its own provenance would fail.
 *
 * WINDOWS HANDLE DISCIPLINE: `closeStores()` runs in `afterAll`, before any temp directory is
 * reclaimed. A handle held open throws EPERM and kills the worker with no output.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_WORLD_NODE_KEY,
  seedActivationWorld,
} from "../activation/activation-world-fixtures.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  closeStores,
  openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readExpansionRequestAuthority } from "./expansion-request-current-authority.js";
import type { ExpansionRequestPayload } from "./expansion-request-contracts.js";

let store: SqliteEventStore;
let ledger: DurableLedger;
/** A store carrying the goal and run but NO active graph, for the delegated-refusal world. */
let graphlessStore: SqliteEventStore;

function payloadOf(overrides: Partial<ExpansionRequestPayload> = {}): ExpansionRequestPayload {
  return {
    goalRef: GOAL_ID,
    parentNodeRef: ACTIVATION_WORLD_NODE_KEY,
    parentRunRef: RUN_ID,
    rationale: "the parent node needs a decomposition",
    ...overrides,
  };
}

/** The REAL ledger with exactly one aggregate's durable record replaced. */
function ledgerWith(aggregateId: string, result: JsonValue | undefined): DurableLedger {
  const aggregates = new Map(ledger.aggregates);
  if (result === undefined) aggregates.delete(aggregateId);
  else aggregates.set(aggregateId, { currentVersion: 1, result });
  return Object.freeze({ aggregates, decisionCount: ledger.decisionCount, kinds: ledger.kinds });
}

function goalRecord(overrides: Record<string, JsonValue> = {}): JsonValue {
  const current = ledger.aggregates.get(GOAL_ID)?.result;
  expect(current).toBeDefined();
  return { ...(current as Record<string, JsonValue>), ...overrides };
}

function runRecord(overrides: Record<string, JsonValue> = {}): JsonValue {
  const current = ledger.aggregates.get(RUN_ID)?.result;
  expect(current).toBeDefined();
  const state = Object.hasOwn(current as object, "state")
    ? (current as Record<string, JsonValue>)["state"] : current;
  return { ...(state as Record<string, JsonValue>), ...overrides };
}

function refusalOf(value: unknown): Record<string, unknown> {
  const refusal = value as Record<string, unknown>;
  expect(refusal["ok"]).toBe(false);
  return { code: refusal["code"], layer: refusal["layer"] };
}

beforeAll(() => {
  store = openStore();
  seedActivationWorld(store);
  ledger = readDurableLedger(store, PROJECT_ID);
  graphlessStore = openStore();
});

afterAll(() => {
  closeStores();
});

describe("current authority happy world (task-738a12a816e8421a96edd84648565a38)", () => {
  it("resolves the one current goal, graph and parent from durable bytes alone", () => {
    const result = readExpansionRequestAuthority({
      ledger, payload: payloadOf(), projectId: PROJECT_ID, store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authority = result.authority;
    expect(authority.goalRef).toBe(GOAL_ID);
    expect(authority.parentRunRef).toBe(RUN_ID);
    expect(authority.parentNodeRef).toBe(ACTIVATION_WORLD_NODE_KEY);
    expect(authority.projectId).toBe(PROJECT_ID);
    expect(authority.generation).toBeGreaterThanOrEqual(1);
    expect(authority.goalVersion).toBeGreaterThanOrEqual(1);
    expect(authority.graphEpoch).toBeGreaterThanOrEqual(0);
    expect(authority.graphContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(authority.snapshotIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(authority.parentRevisionRef.length).toBeGreaterThan(0);
    expect(Object.isFrozen(authority)).toBe(true);
  });

  it("reads the goal's OWN durable version, generation and epoch, not a default", () => {
    const durable = ledger.aggregates.get(GOAL_ID)?.result as Record<string, JsonValue>;
    const result = readExpansionRequestAuthority({
      ledger, payload: payloadOf(), projectId: PROJECT_ID, store,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authority.goalVersion).toBe(durable["version"]);
    expect(result.authority.generation).toBe(durable["generation"]);
    expect(result.authority.graphEpoch).toBe(durable["graphEpoch"]);
  });
});

describe("goal leg refusals (task-738a12a816e8421a96edd84648565a38)", () => {
  it("refuses an absent goal", () => {
    expect(refusalOf(readExpansionRequestAuthority({
      ledger, payload: payloadOf({ goalRef: "goal-absent" }), projectId: PROJECT_ID, store,
    }))).toStrictEqual({
      code: "EXPANSION_REQUEST_GOAL_ABSENT", layer: "CURRENT_AUTHORITY",
    });
  });

  it("refuses a foreign project and a foreign goal identity, member by member", () => {
    let cases = 0;
    for (const override of [{ projectId: "project-other" }, { goalId: "goal-other" }]) {
      expect(refusalOf(readExpansionRequestAuthority({
        ledger: ledgerWith(GOAL_ID, goalRecord(override)),
        payload: payloadOf(), projectId: PROJECT_ID, store,
      }))).toStrictEqual({
        code: "EXPANSION_REQUEST_GOAL_FOREIGN", layer: "CURRENT_AUTHORITY",
      });
      cases += 1;
    }
    expect(cases).toBe(2);
  });

  it("refuses every terminal lifecycle and separates DRAFT from them", () => {
    let terminal = 0;
    for (const lifecycle of ["CLOSING", "COMPLETED", "CANCELLED"]) {
      expect(refusalOf(readExpansionRequestAuthority({
        ledger: ledgerWith(GOAL_ID, goalRecord({ lifecycle })),
        payload: payloadOf(), projectId: PROJECT_ID, store,
      }))).toStrictEqual({
        code: "EXPANSION_REQUEST_GOAL_TERMINAL", layer: "CURRENT_AUTHORITY",
      });
      terminal += 1;
    }
    expect(terminal).toBe(3);
    expect(refusalOf(readExpansionRequestAuthority({
      ledger: ledgerWith(GOAL_ID, goalRecord({ lifecycle: "DRAFT" })),
      payload: payloadOf(), projectId: PROJECT_ID, store,
    }))).toStrictEqual({
      code: "EXPANSION_REQUEST_GOAL_NOT_EXECUTING", layer: "CURRENT_AUTHORITY",
    });
  });

  it("refuses a malformed goal record rather than defaulting a missing counter", () => {
    const hostile: readonly JsonValue[] = [
      "not-a-record", 7, [], { ...(goalRecord() as object), generation: null } as JsonValue,
      { ...(goalRecord() as object), graphEpoch: -1 } as JsonValue,
      { ...(goalRecord() as object), version: "1" } as JsonValue,
      { ...(goalRecord() as object), lifecycle: "NOT_A_LIFECYCLE" } as JsonValue,
      { ...(goalRecord() as object), generation: 0 } as JsonValue,
    ];
    let cases = 0;
    for (const record of hostile) {
      expect(refusalOf(readExpansionRequestAuthority({
        ledger: ledgerWith(GOAL_ID, record), payload: payloadOf(), projectId: PROJECT_ID, store,
      }))).toStrictEqual({
        code: "EXPANSION_REQUEST_GOAL_MALFORMED", layer: "CURRENT_AUTHORITY",
      });
      cases += 1;
    }
    expect(cases).toBe(8);
  });
});

describe("parent run leg refusals (task-738a12a816e8421a96edd84648565a38)", () => {
  it("refuses an absent parent run", () => {
    expect(refusalOf(readExpansionRequestAuthority({
      ledger, payload: payloadOf({ parentRunRef: "run-absent" }), projectId: PROJECT_ID, store,
    }))).toStrictEqual({
      code: "EXPANSION_REQUEST_PARENT_RUN_ABSENT", layer: "CURRENT_AUTHORITY",
    });
  });

  it("refuses a parent run owned by another goal or carrying another identity", () => {
    let cases = 0;
    for (const override of [{ goalRef: "goal-other" }, { runId: "run-other" }]) {
      expect(refusalOf(readExpansionRequestAuthority({
        ledger: ledgerWith(RUN_ID, runRecord(override)),
        payload: payloadOf(), projectId: PROJECT_ID, store,
      }))).toStrictEqual({
        code: "EXPANSION_REQUEST_PARENT_RUN_FOREIGN", layer: "CURRENT_AUTHORITY",
      });
      cases += 1;
    }
    expect(cases).toBe(2);
  });

  it("refuses a malformed parent run record", () => {
    let cases = 0;
    for (const record of ["run", 3, [], { runId: RUN_ID } as JsonValue,
      { ...(runRecord() as object), lifecycle: "NOPE" } as JsonValue]) {
      expect(refusalOf(readExpansionRequestAuthority({
        ledger: ledgerWith(RUN_ID, record as JsonValue),
        payload: payloadOf(), projectId: PROJECT_ID, store,
      }))).toStrictEqual({
        code: "EXPANSION_REQUEST_PARENT_RUN_MALFORMED", layer: "CURRENT_AUTHORITY",
      });
      cases += 1;
    }
    expect(cases).toBe(5);
  });
});

describe("graph leg refusals (task-738a12a816e8421a96edd84648565a38)", () => {
  it("passes the active-graph reader's own code through as the source", () => {
    const result = readExpansionRequestAuthority({
      ledger, payload: payloadOf(), projectId: PROJECT_ID, store: graphlessStore,
    }) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["code"]).toBe("EXPANSION_REQUEST_GRAPH_UNAVAILABLE");
    expect(result["layer"]).toBe("CURRENT_AUTHORITY");
    expect(result["sourceCode"]).toBe("ACTIVE_GRAPH_ABSENT");
    expect(result["sourceLayer"]).toBe("ACTIVE_GRAPH_PROJECTION");
  });

  it("refuses when the active graph belongs to another goal", () => {
    // A whole second world: an executing goal AND a run that legitimately belongs to it, so the
    // goal and parent-run legs both PASS and the graph-ownership fence is the one that answers.
    const aggregates = new Map(ledger.aggregates);
    aggregates.set("goal-other", {
      currentVersion: 1, result: goalRecord({ goalId: "goal-other" }),
    });
    aggregates.set("run-other", {
      currentVersion: 1, result: runRecord({ goalRef: "goal-other", runId: "run-other" }),
    });
    const widened = Object.freeze({
      aggregates, decisionCount: ledger.decisionCount, kinds: ledger.kinds,
    });
    expect(refusalOf(readExpansionRequestAuthority({
      ledger: widened,
      payload: payloadOf({ goalRef: "goal-other", parentRunRef: "run-other" }),
      projectId: PROJECT_ID,
      store,
    }))).toStrictEqual({
      code: "EXPANSION_REQUEST_GRAPH_GOAL_MISMATCH", layer: "CURRENT_AUTHORITY",
    });
  });

  it("refuses when the goal's epoch and the active revision's epoch disagree", () => {
    const durable = ledger.aggregates.get(GOAL_ID)?.result as Record<string, JsonValue>;
    const moved = (durable["graphEpoch"] as number) + 1;
    expect(refusalOf(readExpansionRequestAuthority({
      ledger: ledgerWith(GOAL_ID, goalRecord({ graphEpoch: moved })),
      payload: payloadOf(), projectId: PROJECT_ID, store,
    }))).toStrictEqual({
      code: "EXPANSION_REQUEST_GRAPH_EPOCH_MISMATCH", layer: "CURRENT_AUTHORITY",
    });
  });

  it("refuses a parent node that is not a member of the active graph", () => {
    expect(refusalOf(readExpansionRequestAuthority({
      ledger, payload: payloadOf({ parentNodeRef: "node-not-in-graph" }),
      projectId: PROJECT_ID, store,
    }))).toStrictEqual({
      code: "EXPANSION_REQUEST_PARENT_NODE_ABSENT", layer: "CURRENT_AUTHORITY",
    });
  });
});
