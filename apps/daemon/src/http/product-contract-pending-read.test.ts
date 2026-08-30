/**
 * The Gate 1 card's read. The goal side is the PRODUCTION
 * `goal.create_with_source` journey; the revision side is the PRODUCTION writer
 * (`commitProductContractRevision`), so every served record is one core will
 * re-admit — and the served digest is re-derived from those stored bytes, never
 * echoed. The approval-exclusion row is committed straight through the store
 * because the port's contract there is exactly "what the ledger folds".
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
import { commitProductContractRevision }
  from "../product-contract/product-contract-revision-store.js";
import { createProductContractPendingReadPort } from "./product-contract-pending-read.js";

const PRD = "# Approve me\n\nA PRD whose contract the browser card must show.\n";
const encoder = new TextEncoder();

/** A core-admissible draft (mirrors core's own fixture; those are not exported). */
const productContractDraft = () => ({
  authorRef: "principal-product",
  contractId: "product-contract-a",
  criteria: [{
    criterionId: "criterion-authentication",
    requirementId: "requirement-authentication",
    statement: "A registered user signs in with valid credentials.",
    supersedesCriterionId: null as string | null,
  }],
  lineage: null as null | { parentRevisionDigest: string; parentRevisionId: string },
  requirements: [{
    requirementId: "requirement-authentication",
    statement: "Registered users can sign in.",
    supersedesRequirementId: null as string | null,
  }],
  retiredCriterionIds: [] as string[],
  retiredRequirementIds: [] as string[],
  revisionId: "product-revision-1",
  sourceDocumentDigests: ["a".repeat(64)],
});

afterEach(closeStores);

function boundWorld(): { sha: string; store: SqliteEventStore } {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Show this contract on the Gate 1 card.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Gate 1 card goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  const read = createGoalSourceReadPort({ projectId: PROJECT_ID, store }).read(GOAL_ID);
  if (!read.ok) throw new Error(`fixture source read refused: ${read.code}`);
  return { sha: read.contentSha256, store };
}

function commitRevision(store: SqliteEventStore, sha: string) {
  const committed = commitProductContractRevision(store, {
    correlationId: "corr-pending-revision",
    decidedAt: "2026-08-31T12:00:00.000Z",
    draft: { ...productContractDraft(), sourceDocumentDigests: [sha] },
    principalId: "principal-writer",
    projectId: PROJECT_ID,
  });
  if (!committed.ok) throw new Error(`fixture revision refused: ${committed.code}`);
  return committed.ref;
}

function approveRow(
  store: SqliteEventStore, contractId: string, revisionId: string,
): void {
  const bytes = encoder.encode(JSON.stringify({
    contractId, gateId: "gate-1", grant: {},
    revisionDigest: "e".repeat(64), revisionId, workRef: "work-pending-1",
  }));
  const response = store.commitExpectedVersionDecision({
    commandKind: "pending.fixture",
    committedResultBytes: bytes,
    correlationId: "corr-pending-gate",
    decidedAt: "2026-08-31T12:00:00.000Z",
    events: [{
      domainSchemaVersion: "pending-fixture/1",
      eventId: "pending-fixture-gate-event",
      eventType: "PendingFixtureCommitted",
      payload: bytes,
    }],
    expectedVersion: 0,
    key: {
      commandId: "cmd-pending-gate", principalId: "operator-local", projectId: PROJECT_ID,
    },
    requestBytes: bytes,
    targetAggregateId: "product-contract-gate-1-pendingtest",
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`fixture gate refused: ${response.decision.resultCode}`);
  }
}

function portFor(store: SqliteEventStore) {
  let minted = 0;
  return createProductContractPendingReadPort({
    mintId: () => `gate1-cmd-${(minted += 1)}`, projectId: PROJECT_ID, store,
  });
}

describe("createProductContractPendingReadPort", () => {
  it("answers NONE for a plain goal and for an unknown ref", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const port = portFor(store);
    expect(port.readPending(GOAL_ID)).toEqual({ outcome: "NONE" });
    expect(port.readPending("goal-that-never-was")).toEqual({ outcome: "NONE" });
  });

  it("answers NONE while nothing is committed for the bound source", () => {
    const { store } = boundWorld();
    expect(portFor(store).readPending(GOAL_ID)).toEqual({ outcome: "NONE" });
  });

  it("serves the pending revision with a re-derived ref and a minted template", () => {
    const { sha, store } = boundWorld();
    const ref = commitRevision(store, sha);
    const answer = portFor(store).readPending(GOAL_ID);
    if (answer.outcome !== "PENDING") throw new Error(`expected PENDING, got ${answer.outcome}`);
    // The triple matches the WRITER's own answer — digest re-derived from the
    // stored bytes, never copied from any caller.
    expect(answer.ref).toEqual({
      contractId: ref.contractId,
      revisionDigest: ref.revisionDigest,
      revisionId: ref.revisionId,
    });
    expect(answer.revision["criteria"]).toEqual(
      (productContractDraft().criteria as unknown[]),
    );
    expect(answer.approval.commandId).toBe("gate1-cmd-1");
    expect(answer.approval.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    // A second read mints a FRESH command id (the bearer replay marker is
    // single-use per command id) and therefore a different subject digest.
    const again = portFor(store).readPending(GOAL_ID);
    if (again.outcome !== "PENDING") throw new Error("expected PENDING twice");
    expect(again.ref).toEqual(answer.ref);
  });

  it("stops serving a revision once a Gate 1 approval names it", () => {
    const { sha, store } = boundWorld();
    const ref = commitRevision(store, sha);
    approveRow(store, ref.contractId, ref.revisionId);
    expect(portFor(store).readPending(GOAL_ID)).toEqual({ outcome: "NONE" });
  });

  it("ignores a committed revision that does not cite this goal's source", () => {
    const { store } = boundWorld();
    commitRevision(store, "f".repeat(64));
    expect(portFor(store).readPending(GOAL_ID)).toEqual({ outcome: "NONE" });
  });
});
