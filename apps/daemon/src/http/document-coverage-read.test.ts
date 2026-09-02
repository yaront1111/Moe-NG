/**
 * PRD coverage over a REAL store. The goal side is the PRODUCTION `goal.create_with_source`
 * journey; the revision side is the PRODUCTION writer (`commitProductContractRevision`); the
 * sealed graph is the REAL compile (`compiledPlanAuthority` through the production codecs).
 * Only the two ledger walks that own their own suites are injected: which activated graphs
 * exist, and what each node's review ledger holds - because those are exactly the facts
 * whose spelling decides PLANNED versus VERIFIED, and an arm must be able to flip one alone.
 */
import { decodeGraphContent } from "@moe/scheduler";
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
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { compiledPlanAuthority } from "../planning/compiled-authority-bodies.js";
import { commitProductContractRevision }
  from "../product-contract/product-contract-revision-store.js";
import type { AcceptanceRecord } from "../review/review-read-model.js";
import type { DocumentCoverageView } from "./document-coverage-contract.js";
import { createDocumentCoverageReadPort } from "./document-coverage-read.js";
import type { DocumentCoverageReadOptions } from "./document-coverage-read.js";

const PRD = [
  "# Cover me",
  "",
  "## 11. Evidence",
  "Evidence rows are immutable.",
  "## 12. Anchors",
  "Anchors point into evidence.",
].join("\n");
const CONTRACT_ID = "contract-cover-1";
const REVISION_ID = "rev-cover-1";
const SHA_OTHER = "f".repeat(64);
const encoder = new TextEncoder();

const ACCEPTED: AcceptanceRecord = Object.freeze({
  policyDecision: "ACCEPT",
  reviewInputDigest: "1".repeat(64),
  reviewerCalibrationDigest: "2".repeat(64),
  verifierReceiptId: "receipt-1",
  verifierReceiptSha256: "3".repeat(64),
});

afterEach(closeStores);

/** A core-admissible draft: two requirements, three criteria, statements citing sections. */
const draft = (sha: string) => ({
  authorRef: "principal-product",
  contractId: CONTRACT_ID,
  criteria: [
    { criterionId: "crit-1", requirementId: "req-evidence",
      statement: "Every evidence row keeps its fields (PRD §11).",
      supersedesCriterionId: null as string | null },
    { criterionId: "crit-2", requirementId: "req-evidence",
      statement: "Evidence rows cannot be edited.", supersedesCriterionId: null as string | null },
    { criterionId: "crit-3", requirementId: "req-anchors",
      statement: "An anchor names a known evidence row.",
      supersedesCriterionId: null as string | null },
  ],
  lineage: null as null | { parentRevisionDigest: string; parentRevisionId: string },
  requirements: [
    { requirementId: "req-anchors", statement: "Anchors are precise (PRD §12).",
      supersedesRequirementId: null as string | null },
    { requirementId: "req-evidence", statement: "Evidence is immutable (PRD §11).",
      supersedesRequirementId: null as string | null },
  ],
  retiredCriterionIds: [] as string[],
  retiredRequirementIds: [] as string[],
  revisionId: REVISION_ID,
  sourceDocumentDigests: [sha],
});

function boundWorld(): { sha: string; store: SqliteEventStore } {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Build this PRD and show how much of it is done.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Coverage goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  const read = createGoalSourceReadPort({ projectId: PROJECT_ID, store }).read(GOAL_ID);
  if (!read.ok) throw new Error(`fixture source read refused: ${read.code}`);
  return { sha: read.contentSha256, store };
}

function commitRevision(store: SqliteEventStore, sha: string) {
  const committed = commitProductContractRevision(store, {
    correlationId: "corr-coverage-revision",
    decidedAt: "2026-09-02T12:00:00.000Z",
    draft: draft(sha),
    principalId: "principal-writer",
    projectId: PROJECT_ID,
  });
  if (!committed.ok) throw new Error(`fixture revision refused: ${committed.code}`);
  return committed.ref;
}

/** A Gate 1 approval row, committed straight through the store: the port reads the fold. */
function approveRow(store: SqliteEventStore, contractId: string, revisionId: string): void {
  const bytes = encoder.encode(JSON.stringify({
    contractId, gateId: "gate-1", grant: {},
    revisionDigest: "e".repeat(64), revisionId, workRef: "work-coverage-1",
  }));
  const response = store.commitExpectedVersionDecision({
    commandKind: "coverage.fixture",
    committedResultBytes: bytes,
    correlationId: "corr-coverage-gate",
    decidedAt: "2026-09-02T12:00:00.000Z",
    events: [{
      domainSchemaVersion: "coverage-fixture/1",
      eventId: "coverage-fixture-gate-event",
      eventType: "CoverageFixtureCommitted",
      payload: bytes,
    }],
    expectedVersion: 0,
    key: { commandId: "cmd-coverage-gate", principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: bytes,
    targetAggregateId: "product-contract-gate-1-coveragetest",
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`fixture gate refused: ${response.decision.resultCode}`);
  }
}

/** The REAL compile of a two-node plan: node-a carries crit-1, node-b carries crit-2. */
function activeGraphFor(goalRef: string): ActiveCompiledGraph {
  const compiled = compiledPlanAuthority({
    authorRef: "principal-compiler",
    completionNodeKey: "node-b",
    criteria: [
      { criterionId: "crit-1", statement: "Every evidence row keeps its fields." },
      { criterionId: "crit-2", statement: "Evidence rows cannot be edited." },
    ],
    graphRevisionRef: "graph-revision-coverage-1",
    idPrefix: "coverage-test",
    knownCapabilities: null,
    nodes: [
      {
        capability: "capability-implement", criterionIds: ["crit-1"], dependsOn: [],
        nodeKey: "node-a", objective: "Keep evidence fields.", readScopes: ["src"],
        resources: ["resource-a"], verificationRecipeRefs: ["recipe-a"],
        writeScopes: ["src/evidence"],
      },
      {
        capability: "capability-implement", criterionIds: ["crit-2"], dependsOn: ["node-a"],
        nodeKey: "node-b", objective: "Refuse evidence edits.", readScopes: ["src"],
        resources: ["resource-b"], verificationRecipeRefs: ["recipe-b"],
        writeScopes: ["src/evidence"],
      },
    ],
  });
  if (!compiled.ok) throw new Error(`fixture compile refused: ${compiled.code}`);
  const decoded = decodeGraphContent(Buffer.from(compiled.graphContentBytesBase64, "base64"));
  if (!decoded.ok) throw new Error("fixture graph did not decode");
  return Object.freeze({ content: decoded.value.content, goalRef });
}

function portFor(
  store: SqliteEventStore,
  overrides: Partial<Pick<DocumentCoverageReadOptions, "readActive" | "readReview">> = {},
) {
  return createDocumentCoverageReadPort({ projectId: PROJECT_ID, store, ...overrides });
}

function coverage(result: ReturnType<ReturnType<typeof portFor>["readCoverage"]>): DocumentCoverageView {
  if (result.outcome !== "COVERAGE") throw new Error(`expected COVERAGE, got ${result.code}`);
  return result;
}

const statusOf = (view: DocumentCoverageView): Record<string, [string, string | null]> =>
  Object.fromEntries(view.contracts.flatMap((contract) => contract.requirements.flatMap(
    (requirement) => requirement.criteria.map((criterion) =>
      [criterion.criterionId, [criterion.status, criterion.nodeKey]] as const),
  )));

describe("createDocumentCoverageReadPort", () => {
  it("refuses a malformed digest and a goal the catalog does not bind", () => {
    const { store } = boundWorld();
    expect(portFor(store).readCoverage({ contentSha256: "not-a-digest" })).toMatchObject({
      code: "DOCUMENT_COVERAGE_READ_MALFORMED", outcome: "REFUSED",
    });
    expect(portFor(store).readCoverage({ goalRef: "goal-that-never-was" })).toMatchObject({
      code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", outcome: "REFUSED",
    });
  });

  it("answers an honest empty coverage for a document nothing is bound to", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    expect(portFor(store).readCoverage({ contentSha256: SHA_OTHER })).toEqual({
      contracts: [],
      document: { byteLength: null, contentSha256: SHA_OTHER, displayPath: null },
      goals: [],
      outcome: "COVERAGE",
      sections: null,
      totals: { contracts: 0, criteria: 0, goals: 0, planned: 0, requirements: 0, verified: 0 },
    });
  });

  it("lists the bound goal, its document and its sections before any contract exists", () => {
    const { sha, store } = boundWorld();
    const view = coverage(portFor(store).readCoverage({ contentSha256: sha }));
    expect(view.goals).toEqual([{
      goalId: GOAL_ID, lastActivityAt: expect.any(String), lifecycle: "DRAFT",
      planningRunRef: expect.any(String), title: "Coverage goal",
    }]);
    expect(view.goals[0]?.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(view.document).toEqual({
      byteLength: encoder.encode(PRD).byteLength, contentSha256: sha, displayPath: "docs/prd.md",
    });
    expect(view.contracts).toEqual([]);
    expect(view.sections).toEqual({
      advisoryOnly: true,
      entries: [
        { cited: 0, heading: "Cover me", number: null, verified: 0 },
        { cited: 0, heading: "11. Evidence", number: "11", verified: 0 },
        { cited: 0, heading: "12. Anchors", number: "12", verified: 0 },
      ],
    });
  });

  it("reports a pending contract's criteria as UNPLANNED with the re-derived digest", () => {
    const { sha, store } = boundWorld();
    const ref = commitRevision(store, sha);
    const view = coverage(portFor(store).readCoverage({ contentSha256: sha }));
    expect(view.contracts).toHaveLength(1);
    expect(view.contracts[0]).toMatchObject({
      contractId: CONTRACT_ID, gate1: "PENDING",
      revisionDigest: ref.revisionDigest, revisionId: REVISION_ID,
    });
    // Requirements in the writer's stored order, criteria joined by requirementId.
    expect(view.contracts[0]?.requirements.map((row) => row.requirementId))
      .toEqual(["req-anchors", "req-evidence"]);
    expect(statusOf(view)).toEqual({
      "crit-1": ["UNPLANNED", null], "crit-2": ["UNPLANNED", null], "crit-3": ["UNPLANNED", null],
    });
    expect(view.totals).toEqual({
      contracts: 1, criteria: 3, goals: 1, planned: 0, requirements: 2, verified: 0,
    });
  });

  it("marks a carried criterion PLANNED and an accepted node's criterion VERIFIED", () => {
    const { sha, store } = boundWorld();
    const ref = commitRevision(store, sha);
    approveRow(store, ref.contractId, ref.revisionId);
    const port = portFor(store, {
      readActive: () => [activeGraphFor(GOAL_ID)],
      readReview: (_store, _projectId, nodeRef) =>
        ({ accepted: nodeRef === "node-a" ? ACCEPTED : undefined }),
    });
    const view = coverage(port.readCoverage({ contentSha256: sha }));
    expect(view.contracts[0]?.gate1).toBe("APPROVED");
    expect(statusOf(view)).toEqual({
      "crit-1": ["VERIFIED", "node-a"], "crit-2": ["PLANNED", "node-b"], "crit-3": ["UNPLANNED", null],
    });
    expect(view.totals).toEqual({
      contracts: 1, criteria: 3, goals: 1, planned: 1, requirements: 2, verified: 1,
    });
    // The advisory section map: section 11 is cited by one requirement whose criteria are
    // one VERIFIED and one PLANNED; section 12 by one requirement, nothing verified.
    expect(view.sections?.entries).toEqual([
      { cited: 0, heading: "Cover me", number: null, verified: 0 },
      { cited: 1, heading: "11. Evidence", number: "11", verified: 1 },
      { cited: 1, heading: "12. Anchors", number: "12", verified: 0 },
    ]);
  });

  it("reads the same coverage through the bound goal as through the digest", () => {
    const { sha, store } = boundWorld();
    commitRevision(store, sha);
    const port = portFor(store, { readActive: () => [activeGraphFor(GOAL_ID)] });
    expect(port.readCoverage({ goalRef: GOAL_ID })).toEqual(port.readCoverage({ contentSha256: sha }));
    expect(coverage(port.readCoverage({ goalRef: GOAL_ID })).totals.planned).toBe(2);
  });

  it("ignores a revision citing another document and a plan sealed for another goal", () => {
    const { sha, store } = boundWorld();
    commitRevision(store, SHA_OTHER);
    const port = portFor(store, { readActive: () => [activeGraphFor("goal-other")] });
    const view = coverage(port.readCoverage({ contentSha256: sha }));
    expect(view.contracts).toEqual([]);
    expect(view.totals.criteria).toBe(0);
    // The other document's coverage sees the revision, but no goal, no text, no sections.
    const other = coverage(port.readCoverage({ contentSha256: SHA_OTHER }));
    expect(other.goals).toEqual([]);
    expect(other.sections).toBeNull();
    expect(statusOf(other)).toEqual({
      "crit-1": ["UNPLANNED", null], "crit-2": ["UNPLANNED", null], "crit-3": ["UNPLANNED", null],
    });
  });

  it("answers UNREADABLE instead of throwing when a ledger walk fails", () => {
    const { sha, store } = boundWorld();
    const port = portFor(store, { readActive: () => { throw new Error("walk exploded"); } });
    expect(port.readCoverage({ contentSha256: sha })).toEqual({
      code: "DOCUMENT_COVERAGE_READ_UNREADABLE", layer: "DOCUMENT_COVERAGE_READ", outcome: "REFUSED",
    });
  });
});
