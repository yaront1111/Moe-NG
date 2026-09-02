/**
 * PRD coverage over a REAL store. The goal side is the PRODUCTION `goal.create_with_source`
 * journey, revisions are the PRODUCTION proposers (the `/1` service and the `/2` store), Gate 1
 * is the PRODUCTION approval command over a real paired session, the plan is sealed by the
 * PRODUCTION compiler and activated by the PRODUCTION approval intent, and the acceptance is
 * the PRODUCTION `integration.accept_output` over the daemon's own verifier receipt. The
 * default readers (active graphs, review ledgers) run in every arm that has no injection.
 */
import { decodeGraphContent } from "@moe/scheduler";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { productContractGate1Authority } from "@moe/core";
import type { ProductContractRevisionRef } from "@moe/core";
import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, RUN_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { humanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { runApprovalIntentCommand } from "../planning/approval-intent.js";
import { runSubmitDecomposition } from "../planning/compile-dispatcher.js";
import { compiledPlanAuthority } from "../planning/compiled-authority-bodies.js";
import {
  createProductContractGate1Authority, runProductContractGate1Command,
} from "../product-contract/product-contract-gate-1-command.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, productContractGate1SubjectDigest,
} from "../product-contract/product-contract-gate-1-contract.js";
import { runProductContractProposeRevision } from "../product-contract/product-contract-propose-service.js";
import { commitProductContractRevisionV2 } from "../product-contract/product-contract-v2-store.js";
import { runReviewCommand } from "../review/review-services.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";
import type { DocumentCoverageView } from "./document-coverage-contract.js";
import { createDocumentCoverageReadPort } from "./document-coverage-read.js";
import type { DocumentCoverageReadOptions } from "./document-coverage-read.js";

const PRD = [
  "# Cover me", "", "## 11. Evidence", "Evidence rows are immutable.", "## 12. Anchors", "Anchors point into evidence.",
].join("\n");
const OTHER_PRD = "# Another product\n\n## 1. Scope\nA different document.\n";
const CONTRACT_ID = "contract-cover-1";
const SHA_OTHER = "f".repeat(64);
const OPERATOR = "principal-1";
const NOW_MS = Date.parse("2026-09-02T12:00:00.000Z");
const encoder = new TextEncoder();

afterEach(closeStores);

const draft = (sha: string, revisionId = "rev-cover-1") => ({
  authorRef: "principal-product",
  contractId: CONTRACT_ID,
  criteria: [
    { criterionId: "crit-1", requirementId: "req-evidence", statement: "Every evidence row keeps its fields (PRD §11).", supersedesCriterionId: null },
    { criterionId: "crit-2", requirementId: "req-evidence", statement: "Evidence rows cannot be edited.", supersedesCriterionId: null },
    { criterionId: "crit-3", requirementId: "req-anchors", statement: "An anchor names a known evidence row.", supersedesCriterionId: null },
  ],
  lineage: null,
  requirements: [
    { requirementId: "req-anchors", statement: "Anchors are precise (PRD §12).", supersedesRequirementId: null },
    { requirementId: "req-evidence", statement: "Evidence is immutable (PRD §11).", supersedesRequirementId: null },
  ],
  retiredCriterionIds: [], retiredRequirementIds: [], revisionId, sourceDocumentDigests: [sha],
});

function boundWorld(): { sha: string; store: SqliteEventStore } {
  const store = openStore();
  installTestRecoveryBinding(store);
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

/** The PRODUCTION `/1` proposer: the revision core will re-admit, with its digest re-derived. */
function proposeRevision(store: SqliteEventStore, sha: string, revisionId = "rev-cover-1"): ProductContractRevisionRef {
  const committed = runProductContractProposeRevision(store, {
    correlationId: `corr-propose-${revisionId}`, decidedAt: "2026-09-02T12:00:00.000Z",
    payload: { draft: draft(sha, revisionId), goalRef: GOAL_ID }, principalId: "compiler-agent-1", projectId: PROJECT_ID,
  });
  if (!committed.ok) throw new Error(`proposer refused: ${committed.code}`);
  return committed.ref;
}

/** Gate 1 through the PRODUCTION command over a real paired operator session. */
function approveGate1(store: SqliteEventStore, ref: ProductContractRevisionRef, commandId: string): void {
  const minted = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES, clock: () => NOW_MS, operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID, sessionTtlMs: 60 * 60 * 1000, store,
  }).mint();
  if (!minted.ok) throw new Error(`pairing mint refused: ${minted.code}`);
  const authority = createProductContractGate1Authority({
    projectId: PROJECT_ID, sessions: createSessionAuthority(store, { clock: () => NOW_MS, projectId: PROJECT_ID }), store,
  });
  const gate = productContractGate1Authority(ref);
  const requestDigest = productContractGate1SubjectDigest({ commandId, projectId: PROJECT_ID, workRef: gate.workRef });
  const outcome = runProductContractGate1Command(store, encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt: "2026-09-02T12:00:30.000Z", expectedVersion: 0,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: {
      authentication: { issuedAt: NOW_MS, kind: "BEARER", requestDigest, requestId: commandId },
      contractId: ref.contractId, revisionDigest: ref.revisionDigest, revisionId: ref.revisionId,
    },
    principalId: minted.principalId, projectId: PROJECT_ID, schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  })), authority, { sessionId: minted.principalId, transportOrigin: "MCP_HTTP" });
  if (!outcome.ok) throw new Error(`gate 1 refused: ${outcome.code}`);
}

/** The PRODUCTION compiler seals one node carrying every criterion, then the PRODUCTION approval intent activates it. */
function sealAndActivate(store: SqliteEventStore, ref: ProductContractRevisionRef): void {
  const submitted = runSubmitDecomposition(store, {
    correlationId: "corr-submit", decidedAt: "2026-09-02T12:01:00.000Z",
    payload: {
      gateRef: { contractId: ref.contractId, revisionDigest: ref.revisionDigest, revisionId: ref.revisionId },
      goalRef: GOAL_ID,
      structure: { completionNodeKey: "node-slice", nodes: [{
        capability: "capability-implement", criterionIds: ["crit-1", "crit-2", "crit-3"], dependsOn: [],
        nodeKey: "node-slice", objective: "Land the evidence ledger.", readScopes: ["services/api/src"],
        resources: ["resource-a"], verificationRecipeRefs: ["recipe-a"], writeScopes: ["services/api/src/node"],
      }] },
    },
    principalId: OPERATOR, projectId: PROJECT_ID,
  });
  if (!submitted.ok) throw new Error(`decomposition refused: ${submitted.code}`);
  const approved = runApprovalIntentCommand({
    commandId: "cmd-intent-approve", correlationId: "corr-intent", decidedAt: "2026-09-02T12:02:00.000Z",
    expectedVersion: store.getAggregateVersion(RUN_ID), humanReview: humanReviewWitness(OPERATOR, "cmd-intent-approve"),
    payload: { decision: "APPROVE", decisionReason: null, dependencyChanges: { additions: [], challenges: [], removals: [] }, runId: RUN_ID },
    principalId: OPERATOR, projectId: PROJECT_ID, store, targetAggregateId: RUN_ID,
  });
  if (!approved.ok) throw new Error(`approval intent refused: ${approved.code}`);
}

/** The PRODUCTION acceptance over the daemon's own verifier receipt. */
function acceptNode(store: SqliteEventStore, nodeKey: string): void {
  const seeded = seedVerifierReceipt(store, nodeKey, PROJECT_ID);
  const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-accept-${nodeKey}`, correlationId: "corr-accept", decidedAt: "2026-09-02T12:05:00.000Z",
    expectedVersion: seeded.currentVersion, kind: "integration.accept_output",
    payload: { receiptId: seeded.receiptId, subjectRef: nodeKey },
    principalId: "operator-local", projectId: PROJECT_ID, schemaVersion: "moe-review-command/1",
  })));
  if (!outcome.ok) throw new Error(`acceptance refused: ${outcome.code}`);
}

/** A raw committed acceptance decision on an aggregate: exactly what the review ledger folds. */
function rawAcceptance(store: SqliteEventStore, subjectRef: string): void {
  const bytes = encoder.encode(JSON.stringify({
    policyDecision: "ALLOW", reviewInputDigest: "r".repeat(64), reviewerCalibrationDigest: "c".repeat(64),
    verifierReceiptId: `receipt-${subjectRef}`, verifierReceiptSha256: "s".repeat(64),
  }));
  const response = store.commitExpectedVersionDecision({
    commandKind: "integration.accept_output", committedResultBytes: bytes, correlationId: "corr-raw-accept",
    decidedAt: "2026-09-02T12:05:00.000Z",
    events: [{ domainSchemaVersion: "coverage-fixture/1", eventId: `raw-accept-${subjectRef}`, eventType: "ReviewOutputAccepted", payload: bytes }],
    expectedVersion: 0, key: { commandId: `cmd-raw-accept-${subjectRef}`, principalId: "operator-local", projectId: PROJECT_ID },
    requestBytes: bytes, targetAggregateId: subjectRef,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error(`raw acceptance refused: ${response.decision.resultCode}`);
}

/** The REAL compile of a one-node plan carrying crit-1 under the given key, for a given goal. */
function graphFor(goalRef: string, nodeKey: string): ActiveCompiledGraph {
  const compiled = compiledPlanAuthority({
    authorRef: "principal-compiler", completionNodeKey: nodeKey,
    criteria: [{ criterionId: "crit-1", statement: "Every evidence row keeps its fields." }],
    graphRevisionRef: `graph-revision-${goalRef}`, idPrefix: `coverage-${goalRef}`, knownCapabilities: null,
    nodes: [{ capability: "capability-implement", criterionIds: ["crit-1"], dependsOn: [], nodeKey, objective: "Keep fields.",
      readScopes: ["src"], resources: ["resource-a"], verificationRecipeRefs: ["recipe-a"], writeScopes: ["src/evidence"] }],
  });
  if (!compiled.ok) throw new Error(`fixture compile refused: ${compiled.code}`);
  const decoded = decodeGraphContent(Buffer.from(compiled.graphContentBytesBase64, "base64"));
  if (!decoded.ok) throw new Error("fixture graph did not decode");
  return Object.freeze({ content: decoded.value.content, goalRef });
}

function portFor(store: SqliteEventStore, overrides: Partial<DocumentCoverageReadOptions> = {}) {
  return createDocumentCoverageReadPort({ projectId: PROJECT_ID, store, ...overrides });
}
function coverage(result: ReturnType<ReturnType<typeof portFor>["readCoverage"]>): DocumentCoverageView {
  if (result.outcome !== "COVERAGE") throw new Error(`expected COVERAGE, got ${result.code} (${result.layer})`);
  return result;
}
const statusOf = (view: DocumentCoverageView): Record<string, [string, string | null]> =>
  Object.fromEntries(view.contracts.flatMap((contract) => contract.requirements.flatMap(
    (requirement) => requirement.criteria.map((criterion) => [criterion.criterionId, [criterion.status, criterion.nodeKey]] as const),
  )));

describe("createDocumentCoverageReadPort", () => {
  it("refuses a malformed digest and a goal the catalog does not bind", () => {
    const { store } = boundWorld();
    expect(portFor(store).readCoverage({ contentSha256: "not-a-digest" })).toMatchObject({ code: "DOCUMENT_COVERAGE_READ_MALFORMED", outcome: "REFUSED" });
    expect(portFor(store).readCoverage({ goalRef: "goal-that-never-was" })).toMatchObject({ code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", outcome: "REFUSED" });
  });

  it("answers an honest empty coverage for a document nothing is bound to", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    expect(portFor(store).readCoverage({ contentSha256: SHA_OTHER })).toEqual({
      contracts: [], document: { byteLength: null, contentSha256: SHA_OTHER, displayPath: null }, goals: [],
      outcome: "COVERAGE", sections: null,
      totals: { contracts: 0, criteria: 0, goals: 0, planned: 0, requirements: 0, unattributable: 0, verified: 0 },
    });
  });

  it("lists the bound goal, its document and its sections before any contract exists", () => {
    const { sha, store } = boundWorld();
    const view = coverage(portFor(store).readCoverage({ contentSha256: sha }));
    expect(view.goals).toEqual([{
      goalId: GOAL_ID, lastActivityAt: expect.any(String), lifecycle: "DRAFT", planningRunRef: expect.any(String), title: "Coverage goal",
    }]);
    expect(view.document).toEqual({ byteLength: encoder.encode(PRD).byteLength, contentSha256: sha, displayPath: "docs/prd.md" });
    expect(view.contracts).toEqual([]);
    expect(view.sections).toEqual({ advisoryOnly: true, entries: [
      { cited: 0, criteria: 0, heading: "Cover me", number: null, verified: 0 },
      { cited: 0, criteria: 0, heading: "11. Evidence", number: "11", verified: 0 },
      { cited: 0, criteria: 0, heading: "12. Anchors", number: "12", verified: 0 },
    ] });
  });

  it("reports a pending contract's criteria as UNPLANNED with the re-derived digest", () => {
    const { sha, store } = boundWorld();
    const ref = proposeRevision(store, sha);
    const view = coverage(portFor(store).readCoverage({ contentSha256: sha }));
    expect(view.contracts).toHaveLength(1);
    expect(view.contracts[0]).toMatchObject({ contractId: CONTRACT_ID, gate1: "PENDING", plane: "V1", revisionDigest: ref.revisionDigest, revisionId: "rev-cover-1" });
    expect(view.contracts[0]?.requirements.map((row) => row.requirementId)).toEqual(["req-anchors", "req-evidence"]);
    expect(statusOf(view)).toEqual({ "crit-1": ["UNPLANNED", null], "crit-2": ["UNPLANNED", null], "crit-3": ["UNPLANNED", null] });
    expect(view.totals).toEqual({ contracts: 1, criteria: 3, goals: 1, planned: 0, requirements: 2, unattributable: 0, verified: 0 });
  });

  it("runs the production join: sealed plan, approval intent, verifier receipt, acceptance", () => {
    const { sha, store } = boundWorld();
    const ref = proposeRevision(store, sha);
    approveGate1(store, ref, "cmd-gate1-join");
    sealAndActivate(store, ref);
    // The DEFAULT readers: the activated graph is walked from the run's sealed hashes and the
    // review ledger is folded from the real decision ledger. Nothing injected.
    const planned = coverage(portFor(store).readCoverage({ goalRef: GOAL_ID }));
    expect(planned.goals[0]?.lifecycle).toBe("EXECUTION_ENABLED");
    expect(planned.contracts[0]?.gate1).toBe("APPROVED");
    expect(statusOf(planned)).toEqual({ "crit-1": ["PLANNED", "node-slice"], "crit-2": ["PLANNED", "node-slice"], "crit-3": ["PLANNED", "node-slice"] });
    expect(planned.totals).toMatchObject({ planned: 3, unattributable: 0, verified: 0 });
    acceptNode(store, "node-slice");
    const verified = coverage(portFor(store).readCoverage({ goalRef: GOAL_ID }));
    expect(statusOf(verified)).toEqual({ "crit-1": ["VERIFIED", "node-slice"], "crit-2": ["VERIFIED", "node-slice"], "crit-3": ["VERIFIED", "node-slice"] });
    expect(verified.totals).toEqual({ contracts: 1, criteria: 3, goals: 1, planned: 0, requirements: 2, unattributable: 0, verified: 3 });
    expect(verified.sections?.entries).toEqual([
      { cited: 0, criteria: 0, heading: "Cover me", number: null, verified: 0 },
      { cited: 1, criteria: 2, heading: "11. Evidence", number: "11", verified: 2 },
      { cited: 1, criteria: 1, heading: "12. Anchors", number: "12", verified: 1 },
    ]);
    expect(verified.goals[0]?.lastActivityAt).toBe("2026-09-02T12:05:00.000Z");
  });

  it("refuses to attribute an acceptance to a node key another activated plan also carries", () => {
    const { sha, store } = boundWorld();
    const other = send(store, envelope("goal.create_with_source", 0, {
      instructions: "Build the other product.", source: { displayPath: "docs/other.md", mediaType: "text/markdown", text: OTHER_PRD }, title: "Other goal",
    }, "2"));
    if (!other.ok) throw new Error(`second bind refused: ${other.code}`);
    proposeRevision(store, sha);
    // A REAL committed acceptance on the bare key "implement", read by the DEFAULT review reader.
    rawAcceptance(store, "implement");
    const shared = coverage(portFor(store, {
      readActive: () => [graphFor(GOAL_ID, "implement"), graphFor("goal-2", "implement")],
    }).readCoverage({ contentSha256: sha }));
    expect(statusOf(shared)["crit-1"]).toEqual(["UNATTRIBUTABLE", "implement"]);
    expect(shared.totals).toMatchObject({ unattributable: 1, verified: 0 });
    // Control: the same acceptance on a key only this document's plan carries IS verified.
    const unique = coverage(portFor(store, {
      readActive: () => [graphFor(GOAL_ID, "implement"), graphFor("goal-2", "implement-other")],
    }).readCoverage({ contentSha256: sha }));
    expect(statusOf(unique)["crit-1"]).toEqual(["VERIFIED", "implement"]);
    expect(unique.totals).toMatchObject({ unattributable: 0, verified: 1 });
  });

  it("counts one revision per contract: the approved one, else the one the Gate 1 card offers", () => {
    const { sha, store } = boundWorld();
    proposeRevision(store, sha, "rev-cover-1");
    const second = proposeRevision(store, sha, "rev-cover-2");
    const pending = coverage(portFor(store).readCoverage({ contentSha256: sha }));
    expect(pending.contracts.map((contract) => [contract.revisionId, contract.gate1])).toEqual([["rev-cover-1", "PENDING"]]);
    expect(pending.totals.criteria).toBe(3);
    approveGate1(store, second, "cmd-gate1-second");
    const approved = coverage(portFor(store).readCoverage({ contentSha256: sha }));
    expect(approved.contracts.map((contract) => [contract.revisionId, contract.gate1])).toEqual([["rev-cover-2", "APPROVED"]]);
    expect(approved.totals.criteria).toBe(3);
  });

  it("sees a /2 revision citing the document, with its six requirement sections flattened", () => {
    const { sha, store } = boundWorld();
    const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
      dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
      statement: `${requirementId} must hold (PRD §11).`, supersedesRequirementId: null,
    });
    const criterion = (criterionId: string, requirementId: string) => ({
      criterionId, requirementId, statement: `${criterionId} is observable.`, supersedesCriterionId: null,
      verification: `Run deterministic ${criterionId} verification.`,
    });
    const committed = commitProductContractRevisionV2(store, {
      commandId: "command-revision-v2", correlationId: "revision-v2-corr", decidedAt: "2026-09-02T12:00:00.000Z",
      draft: {
        assumptions: [{ assumptionId: "assumption-browser", statement: "A browser exists.", validationCriterionId: "criterion-runtime" }],
        authorRef: "agent-product-v2", budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
        contractId: "contract-v2",
        criteria: [criterion("criterion-deployment", "deployment-loopback"), criterion("criterion-keyboard", "ux-keyboard"),
          criterion("criterion-latency", "nfr-latency"), criterion("criterion-login", "requirement-login"),
          criterion("criterion-runtime", "technology-runtime"), criterion("criterion-session", "security-session")],
        deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
        functionalRequirements: [requirement("requirement-login")],
        journeys: [{ criterionIds: ["criterion-login", "criterion-session"], journeyId: "journey-login", statement: "A user signs in.", userJobId: "job-access" }],
        lineage: null,
        materialDecisions: [{ decisionId: "decision-stack", options: [{ optionId: "option-next", statement: "Use Next.js." }, { optionId: "option-rust", statement: "Use Axum." }], question: "Which qualified profile?", selectedOptionId: "option-next" }],
        negativeScope: [{ scopeId: "scope-native", statement: "No native client." }],
        nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
        objectives: [{ objectiveId: "objective-adoption", statement: "Enable first use." }],
        productCompleteDefinition: { criterionIds: ["criterion-deployment", "criterion-keyboard", "criterion-latency", "criterion-login", "criterion-runtime", "criterion-session"], statement: "Every criterion is independently verified." },
        retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "revision-v2-1",
        securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
        sourceDocumentDigests: [sha],
        successMetrics: [{ measurement: "Count successful sessions.", metricId: "metric-first-use", objectiveIds: ["objective-adoption"], statement: "Users finish.", target: "80 percent." }],
        technologyRequirements: [requirement("technology-runtime")],
        userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
        uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
      },
      goalRef: GOAL_ID, principalId: "agent-product-v2", projectId: PROJECT_ID,
    });
    if (!committed.ok) throw new Error(`v2 revision refused: ${committed.code}`);
    const view = coverage(portFor(store).readCoverage({ contentSha256: sha }));
    expect(view.contracts).toHaveLength(1);
    expect(view.contracts[0]).toMatchObject({ contractId: "contract-v2", gate1: "PENDING", plane: "V2", revisionId: "revision-v2-1" });
    expect(view.contracts[0]?.revisionDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(view.contracts[0]?.requirements.map((row) => row.requirementId)).toEqual([
      "requirement-login", "nfr-latency", "security-session", "technology-runtime", "ux-keyboard", "deployment-loopback",
    ]);
    expect(view.totals).toMatchObject({ contracts: 1, criteria: 6, requirements: 6 });
    expect(view.sections?.entries.find((row) => row.number === "11")).toEqual({ cited: 6, criteria: 6, heading: "11. Evidence", number: "11", verified: 0 });
  });

  it("reads the same coverage through the bound goal as through the digest, and ignores other documents' revisions", () => {
    const { sha, store } = boundWorld();
    proposeRevision(store, sha);
    const port = portFor(store);
    expect(port.readCoverage({ goalRef: GOAL_ID })).toEqual(port.readCoverage({ contentSha256: sha }));
    const other = coverage(port.readCoverage({ contentSha256: SHA_OTHER }));
    expect(other.contracts).toEqual([]);
    expect(other.goals).toEqual([]);
    expect(other.sections).toBeNull();
  });

  it("answers UNREADABLE instead of throwing when a ledger walk fails", () => {
    const { sha, store } = boundWorld();
    expect(portFor(store, { readActive: () => { throw new Error("walk exploded"); } }).readCoverage({ contentSha256: sha }))
      .toEqual({ code: "DOCUMENT_COVERAGE_READ_UNREADABLE", layer: "DOCUMENT_COVERAGE_READ", outcome: "REFUSED" });
  });
});
