/**
 * The production compiler-lane detection, over a REAL store: the source side is
 * the PRODUCTION `goal.create_with_source` journey (nothing hand-seeds a
 * binding), and the Gate 1 side is the LEDGER — committed decisions on the
 * gate's own aggregate prefix, joined to the committed revision at the derived
 * aggregate id by PROVENANCE (the revision must cite the goal's source sha).
 * The Gate 1 rows here are committed straight through the store because the
 * lane's contract is exactly "what the ledger folds": the dispatcher re-proves
 * every byte at submit, so the lane may trust fold shape and nothing else.
 */
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { deriveProductContractRevisionAggregateId }
  from "../product-contract/product-contract-revision-store.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createCompilerLanePort } from "./affordance-compiler-lane.js";

const PRD = "# Compile me\n\nA PRD the offer ladder must route to the compiler.\n";
const CONTRACT_ID = "contract-lane-1";
const REVISION_ID = "rev-lane-1";
const REVISION_DIGEST = "e".repeat(64);
const encoder = new TextEncoder();

afterEach(closeStores);

function boundWorld(): { sha: string; store: SqliteEventStore } {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Route this goal to the compiler lane.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Compiler lane goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  const read = createGoalSourceReadPort({ projectId: PROJECT_ID, store }).read(GOAL_ID);
  if (!read.ok) throw new Error(`fixture source read refused: ${read.code}`);
  return { sha: read.contentSha256, store };
}

function commitRow(
  store: SqliteEventStore, suffix: string, aggregateId: string, result: object,
): void {
  const bytes = encoder.encode(JSON.stringify(result));
  const response = store.commitExpectedVersionDecision({
    commandKind: "lane.fixture",
    committedResultBytes: bytes,
    correlationId: `corr-lane-${suffix}`,
    decidedAt: "2026-08-30T12:00:00.000Z",
    events: [{
      domainSchemaVersion: "lane-fixture/1",
      eventId: `lane-fixture-event-${suffix}`,
      eventType: "LaneFixtureCommitted",
      payload: bytes,
    }],
    expectedVersion: 0,
    key: {
      commandId: `cmd-lane-${suffix}`, principalId: "operator-local", projectId: PROJECT_ID,
    },
    requestBytes: bytes,
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`fixture row refused: ${response.decision.resultCode}`);
  }
}

function laneFor(store: SqliteEventStore) {
  return createCompilerLanePort({
    ledger: readDurableLedger(store, PROJECT_ID), projectId: PROJECT_ID, store,
  });
}

describe("createCompilerLanePort", () => {
  it("routes a source-bound goal to the COMPILER lane, pre-Gate-1", () => {
    const { store } = boundWorld();
    expect(laneFor(store).factsFor(GOAL_ID)).toEqual({
      approvedGateRef: null, lane: "COMPILER",
    });
  });

  it("routes a plain goal to the LEGACY lane, and an unknown goal too", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const lane = laneFor(store);
    expect(lane.factsFor(GOAL_ID)).toEqual({ lane: "LEGACY" });
    expect(lane.factsFor("goal-that-never-was")).toEqual({ lane: "LEGACY" });
  });

  it("returns the gate ref once an approval names a revision citing the goal's sha", () => {
    const { sha, store } = boundWorld();
    commitRow(store, "revision",
      deriveProductContractRevisionAggregateId(PROJECT_ID, CONTRACT_ID, REVISION_ID),
      { contractId: CONTRACT_ID, revisionId: REVISION_ID, sourceDocumentDigests: [sha] });
    commitRow(store, "gate", "product-contract-gate-1-abc123", {
      contractId: CONTRACT_ID, gateId: "gate-1", grant: {},
      revisionDigest: REVISION_DIGEST, revisionId: REVISION_ID, workRef: "work-lane-1",
    });
    expect(laneFor(store).factsFor(GOAL_ID)).toEqual({
      approvedGateRef: {
        contractId: CONTRACT_ID, revisionDigest: REVISION_DIGEST, revisionId: REVISION_ID,
      },
      lane: "COMPILER",
    });
  });

  it("ignores an approval whose revision does NOT cite this goal's source", () => {
    // The join is provenance, not mere existence: a Gate 1 row for some OTHER
    // product must not flip this goal to the dispatcher.
    const { store } = boundWorld();
    commitRow(store, "revision",
      deriveProductContractRevisionAggregateId(PROJECT_ID, CONTRACT_ID, REVISION_ID),
      { contractId: CONTRACT_ID, revisionId: REVISION_ID,
        sourceDocumentDigests: ["f".repeat(64)] });
    commitRow(store, "gate", "product-contract-gate-1-abc123", {
      contractId: CONTRACT_ID, gateId: "gate-1", grant: {},
      revisionDigest: REVISION_DIGEST, revisionId: REVISION_ID, workRef: "work-lane-1",
    });
    expect(laneFor(store).factsFor(GOAL_ID)).toEqual({
      approvedGateRef: null, lane: "COMPILER",
    });
  });

  it("WITHHOLDS a goal whose stored source no longer re-proves", () => {
    const { store } = boundWorld();
    const tampered = encoder.encode(JSON.stringify({
      byteLength: 7, contentSha256: "ab".repeat(32), displayPath: "docs/prd.md",
      mediaType: "text/markdown", schemaVersion: "moe-document-source/1", text: "tamper!",
    }));
    const tamperingStore = new Proxy(store, {
      get(target, property) {
        if (property === "readAggregateEvents") {
          return (aggregateId: string, after: number, limit: number) => {
            const page = target.readAggregateEvents(aggregateId, after, limit);
            if (aggregateId === GOAL_ID) return page;
            return {
              ...page,
              items: page.items.map((event: object) => ({ ...event, payload: tampered })),
            };
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(createCompilerLanePort({
      ledger: readDurableLedger(store, PROJECT_ID),
      projectId: PROJECT_ID,
      store: tamperingStore,
    }).factsFor(GOAL_ID)).toEqual({ lane: "WITHHELD" });
  });
});
