/**
 * GOAL CLOSE READINESS: is every approved criterion of this goal's Product Contract verified?
 *
 * Unit arms exercise readiness arithmetic with explicit injected coverage, including reserved
 * VERIFIED states. Criterion execution is covered by its dedicated integration suite. The real-store
 * arms use shipped contract, approval, compiler and review writers with test verifier/landing
 * receipts: generic node acceptance stays EVIDENCE_REQUIRED and blocks both the close command
 * and its offered action. No injected criterion evidence grants authority to the real-store arms.
 */
import type { JsonObject } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { productContractGate1Authority } from "@moe/core";
import type { ProductContractRevisionRef } from "@moe/core";
import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { humanReviewWitness, readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import type { ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, RUN_ID,
  acceptancePayload, closeStores, decisionCount, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { createAffordancePort } from "../http/affordance-read.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { createDocumentCoverageReadPort } from "../http/document-coverage-read.js";
import { coverageRefused } from "../http/document-coverage-contract.js";
import type {
  DocumentCoverageReadPort, DocumentCoverageReadResult,
} from "../http/document-coverage-contract.js";
import { runApprovalIntentCommand } from "../planning/approval-intent.js";
import { runSubmitDecomposition } from "../planning/compile-dispatcher.js";
import {
  createProductContractGate1Authority, runProductContractGate1Command,
} from "../product-contract/product-contract-gate-1-command.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  productContractGate1SubjectDigest,
} from "../product-contract/product-contract-gate-1-contract.js";
import { runProductContractProposeRevision } from "../product-contract/product-contract-propose-service.js";
import { runReviewCommand } from "../review/review-services.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";
import { goalCloseReadinessFor, readGoalCloseReadiness } from "./goal-close-readiness.js";
import {
  approveNodes, cleanupGoalClosureFixtures, closeGoalThroughCommandPath,
  seedLandingReceipt, seedReviewAcceptance, seedVerifiedNode,
} from "./goal-closure-test-fixtures.js";
import { GOAL_HANDLERS } from "./goal-services.js";

const PRD = [
  "# Cover me", "", "## 11. Evidence", "Evidence rows are immutable.",
  "## 12. Anchors", "Anchors point into evidence.",
].join("\n");
const CONTRACT_ID = "contract-close-1";
const SECOND_CONTRACT_ID = "contract-close-2";
const OPERATOR = "principal-1";
const NOW_MS = Date.parse("2026-09-02T12:00:00.000Z");
/** The layer the coverage read stamps on its own refusals, taken from production, never typed. */
const COVERAGE_LAYER = coverageRefused("ANY").layer;
const encoder = new TextEncoder();

afterEach(() => {
  cleanupGoalClosureFixtures();
  closeStores();
});

// ---------------------------------------------------------------------------
// UNIT: a port that answers exactly what the caller stages, and counts its calls.
// ---------------------------------------------------------------------------

interface StubPort extends DocumentCoverageReadPort {
  readonly calls: string[];
}

function stubPort(answer: DocumentCoverageReadResult | (() => never)): StubPort {
  const calls: string[] = [];
  return {
    boundProjectId: PROJECT_ID,
    calls,
    readCoverage: (selector): DocumentCoverageReadResult => {
      calls.push("goalRef" in selector ? selector.goalRef : selector.contentSha256);
      if (typeof answer === "function") return answer();
      return answer;
    },
  };
}

/** A COVERAGE view carrying the given totals; every other field is the read's own empty shape. */
function view(totals: {
  contracts: number; criteria: number; unattributable?: number; verified: number;
}): DocumentCoverageReadResult {
  return {
    contracts: Array.from({ length: totals.contracts }, (_unused, index) => ({
      contractId: `contract-${index}`, gate1: "APPROVED" as const, plane: "V1" as const,
      requirements: [], revisionDigest: "d".repeat(64), revisionId: `rev-${index}`,
    })),
    document: { byteLength: null, contentSha256: "a".repeat(64), displayPath: null },
    goals: [], outcome: "COVERAGE", sections: null,
    totals: {
      contracts: totals.contracts, criteria: totals.criteria, goals: 1, planned: 0,
      requirements: 0, unattributable: totals.unattributable ?? 0, verified: totals.verified,
    },
  };
}

// ---------------------------------------------------------------------------
// REAL STORE: the shipped writers, nothing planted.
// ---------------------------------------------------------------------------

const criterion = (id: string, requirementId: string, statement: string) =>
  ({ criterionId: id, requirementId, statement, supersedesCriterionId: null });

const draft = (sha: string, contractId: string, revisionId: string, ids: readonly string[]) => ({
  authorRef: "principal-product",
  contractId,
  criteria: ids.map((id, index) => criterion(id, "req-evidence", `Statement ${index} for ${id}.`)),
  lineage: null,
  requirements: [
    { requirementId: "req-evidence", statement: "Evidence is immutable.", supersedesRequirementId: null },
  ],
  retiredCriterionIds: [], retiredRequirementIds: [], revisionId, sourceDocumentDigests: [sha],
});

/** The goal bound to a real source document through the shipped `goal.create_with_source`. */
function boundWorld(): { sha: string; store: SqliteEventStore } {
  const store = openStore();
  installTestRecoveryBinding(store);
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Build this PRD and show how much of it is done.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Closure readiness goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  const read = createGoalSourceReadPort({ projectId: PROJECT_ID, store }).read(GOAL_ID);
  if (!read.ok) throw new Error(`fixture source read refused: ${read.code}`);
  return { sha: read.contentSha256, store };
}

function proposeRevision(
  store: SqliteEventStore, sha: string, contractId: string, revisionId: string,
  ids: readonly string[],
): ProductContractRevisionRef {
  const committed = runProductContractProposeRevision(store, {
    correlationId: `corr-propose-${revisionId}`, decidedAt: "2026-09-02T12:00:00.000Z",
    payload: { draft: draft(sha, contractId, revisionId, ids), goalRef: GOAL_ID },
    principalId: "compiler-agent-1", projectId: PROJECT_ID,
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
    projectId: PROJECT_ID,
    sessions: createSessionAuthority(store, { clock: () => NOW_MS, projectId: PROJECT_ID }),
    store,
  });
  const workRef = productContractGate1Authority(ref).workRef;
  const requestDigest = productContractGate1SubjectDigest({ commandId, projectId: PROJECT_ID, workRef });
  const outcome = runProductContractGate1Command(store, encoder.encode(JSON.stringify({
    commandId, correlationId: `corr-${commandId}`, decidedAt: "2026-09-02T12:00:30.000Z",
    expectedVersion: 0, kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: {
      authentication: { issuedAt: NOW_MS, kind: "BEARER", requestDigest, requestId: commandId },
      contractId: ref.contractId, revisionDigest: ref.revisionDigest, revisionId: ref.revisionId,
    },
    principalId: minted.principalId, projectId: PROJECT_ID,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  })), authority, { sessionId: minted.principalId, transportOrigin: "MCP_HTTP" });
  if (!outcome.ok) throw new Error(`gate 1 refused: ${outcome.code}`);
}

/**
 * The PRODUCTION compiler seals the one node the INITIAL run allows — carrying EVERY criterion
 * of the approved revision, because anything less is refused COMPILED_PLAN_CRITERION_UNBOUND —
 * and the PRODUCTION approval intent activates it.
 */
function sealAndActivate(
  store: SqliteEventStore, ref: ProductContractRevisionRef, criterionIds: readonly string[],
): void {
  const submitted = runSubmitDecomposition(store, {
    correlationId: "corr-submit", decidedAt: "2026-09-02T12:01:00.000Z",
    payload: {
      gateRef: {
        contractId: ref.contractId, revisionDigest: ref.revisionDigest, revisionId: ref.revisionId,
      },
      goalRef: GOAL_ID,
      structure: { completionNodeKey: "node-slice", nodes: [{
        capability: "capability-implement", criterionIds: [...criterionIds], dependsOn: [],
        nodeKey: "node-slice", objective: "Land the evidence ledger.",
        readScopes: ["services/api/src"], resources: ["resource-a"],
        verificationRecipeRefs: ["recipe-a"], writeScopes: ["services/api/src/node"],
      }] },
    },
    principalId: OPERATOR, projectId: PROJECT_ID,
  });
  if (!submitted.ok) throw new Error(`decomposition refused: ${submitted.code}`);
  const approved = runApprovalIntentCommand({
    commandId: "cmd-intent-approve", correlationId: "corr-intent",
    decidedAt: "2026-09-02T12:02:00.000Z", expectedVersion: store.getAggregateVersion(RUN_ID),
    humanReview: humanReviewWitness(OPERATOR, "cmd-intent-approve"),
    payload: {
      decision: "APPROVE", decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] }, runId: RUN_ID,
    },
    principalId: OPERATOR, projectId: PROJECT_ID, store, targetAggregateId: RUN_ID,
  });
  if (!approved.ok) throw new Error(`approval intent refused: ${approved.code}`);
}

/** The PRODUCTION acceptance over the daemon's own verifier receipt. */
function acceptNode(store: SqliteEventStore, nodeKey: string): string {
  nodeKey = compiledExecutionRef(PROJECT_ID, activeCompiledGraphs(store, PROJECT_ID)[0]!, nodeKey);
  const seeded = seedVerifierReceipt(store, nodeKey, PROJECT_ID);
  const outcome = runReviewCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-accept-${nodeKey}`, correlationId: "corr-accept",
    decidedAt: "2026-09-02T12:05:00.000Z", expectedVersion: seeded.currentVersion,
    kind: "integration.accept_output",
    payload: { receiptId: seeded.receiptId, subjectRef: nodeKey },
    principalId: "operator-local", projectId: PROJECT_ID, schemaVersion: "moe-review-command/1",
  })));
  if (!outcome.ok) throw new Error(`acceptance refused: ${outcome.code}`);
  return nodeKey;
}

/** A contract-bearing goal whose approved contract carries `ids`, sealed and activated. */
function contractBearingWorld(ids: readonly string[]): { sha: string; store: SqliteEventStore } {
  const { sha, store } = boundWorld();
  const ref = proposeRevision(store, sha, CONTRACT_ID, "rev-close-1", ids);
  approveGate1(store, ref, "cmd-gate1-close");
  sealAndActivate(store, ref, ids);
  return { sha, store };
}

describe("readGoalCloseReadiness", () => {
  it("reads NO_CONTRACT for a goal the coverage catalog does not bind", () => {
    // The contract-less seed/Foundation journey answers exactly this refusal — measured against
    // the production port — and it is what keeps today's `goal.close` offer unchanged there.
    const port = stubPort(coverageRefused("DOCUMENT_COVERAGE_READ_GOAL_UNBOUND"));

    expect(readGoalCloseReadiness(port, GOAL_ID)).toEqual({ kind: "NO_CONTRACT" });
    expect(port.calls).toEqual([GOAL_ID]);
  });

  it("reads NO_CONTRACT for a bound goal carrying no contract and for a contract with no criteria", () => {
    // The `document-coverage-read.test.ts` empty-totals frame: bound, but nothing to verify.
    expect(readGoalCloseReadiness(stubPort(view({ contracts: 0, criteria: 0, verified: 0 })), GOAL_ID))
      .toEqual({ kind: "NO_CONTRACT" });
    // A contract exists but binds zero criteria: there is no criterion to be unverified.
    expect(readGoalCloseReadiness(stubPort(view({ contracts: 1, criteria: 0, verified: 0 })), GOAL_ID))
      .toEqual({ kind: "NO_CONTRACT" });
  });

  it("reads NOT_READY with both counts while any criterion is unverified", () => {
    // The planned-not-yet-accepted frame: three criteria carried by a sealed node, none accepted.
    expect(readGoalCloseReadiness(stubPort(view({ contracts: 1, criteria: 3, verified: 0 })), GOAL_ID))
      .toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });
    // One short. This is the arm a `>=  criteria - 1` mutation reddens.
    expect(readGoalCloseReadiness(stubPort(view({ contracts: 1, criteria: 3, verified: 2 })), GOAL_ID))
      .toEqual({ criteria: 3, kind: "NOT_READY", verified: 2 });
  });

  it("never counts an UNATTRIBUTABLE criterion as verified", () => {
    // A criterion whose node key is carried by a SECOND activated plan reads UNATTRIBUTABLE
    // (document-coverage-read.ts:227): the coverage read cannot say which plan verified it, so
    // it is its own total and is NOT folded into `verified`. Readiness compares verified with
    // criteria and therefore stays NOT_READY — ambiguous attribution never closes a goal. The
    // arm pins that arithmetic at the seam instead of trusting the two totals to stay disjoint.
    expect(readGoalCloseReadiness(
      stubPort(view({ contracts: 1, criteria: 3, unattributable: 1, verified: 2 })), GOAL_ID,
    )).toEqual({ criteria: 3, kind: "NOT_READY", verified: 2 });
  });

  it("reads READY only when every criterion is verified", () => {
    expect(readGoalCloseReadiness(stubPort(view({ contracts: 1, criteria: 3, verified: 3 })), GOAL_ID))
      .toEqual({ criteria: 3, kind: "READY" });
  });

  it("fails CLOSED on every refusal that is not GOAL_UNBOUND, naming code and layer", () => {
    for (const code of [
      "DOCUMENT_COVERAGE_READ_CAPABILITY_DENIED", "DOCUMENT_COVERAGE_READ_MALFORMED",
      "DOCUMENT_COVERAGE_READ_PROJECT_MISMATCH", "DOCUMENT_COVERAGE_READ_UNREADABLE",
    ]) {
      expect(readGoalCloseReadiness(stubPort(coverageRefused(code)), GOAL_ID))
        .toEqual({ code, kind: "UNREADABLE", layer: COVERAGE_LAYER });
    }
  });

  it("fails CLOSED when the port itself throws", () => {
    const port = stubPort((): never => { throw new Error("store handle closed"); });

    expect(readGoalCloseReadiness(port, GOAL_ID)).toEqual({
      code: "DOCUMENT_COVERAGE_READ_UNREADABLE", kind: "UNREADABLE", layer: COVERAGE_LAYER,
    });
  });
});

describe("goalCloseReadinessFor over a real store", () => {
  it("answers NO_CONTRACT for the contract-less journey the seed goal follows", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");

    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID)).toEqual({ kind: "NO_CONTRACT" });
  }, 30_000);

  it("stays NOT_READY when the sealed node test is accepted without criterion evidence", () => {
    const ids = ["crit-1", "crit-2", "crit-3"];
    const { store } = contractBearingWorld(ids);

    // Sealed and activated, nothing accepted: every criterion is PLANNED, none VERIFIED.
    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID))
      .toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });

    acceptNode(store, "node-slice");

    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID))
      .toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });
  }, 30_000);

  it("keeps an unapproved second contract outside the immutable approved plan", () => {
    // A draft cannot change the approved plan's criterion scope. Generic acceptance
    // still supplies no criterion evidence for the original approved revision.
    const { sha, store } = contractBearingWorld(["crit-1", "crit-2", "crit-3"]);
    acceptNode(store, "node-slice");
    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID))
      .toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });

    proposeRevision(store, sha, SECOND_CONTRACT_ID, "rev-close-2", ["crit-4", "crit-5"]);

    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID))
      .toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });
    const coverage = createDocumentCoverageReadPort({ store, projectId: PROJECT_ID }).readCoverage({ goalRef: GOAL_ID });
    if (coverage.outcome !== "COVERAGE") throw new Error(coverage.code);
    expect(coverage.contracts.map(({ contractId, revisionId }) => ({ contractId, revisionId })))
      .toEqual([{ contractId: CONTRACT_ID, revisionId: "rev-close-1" }]);
  }, 30_000);
});

/**
 * THE CLOSURE PRECONDITION, over the same real contract-bearing worlds.
 *
 * These arms live here rather than in `goal-services.test.ts` because the world they need is
 * the ~130-line production-join recipe above. A third copy of it (the coverage read owns one,
 * this file owns one) is a drift hazard worth more than the tidiness of filing the arm next to
 * the handler; the roster pin that DOES belong there stays there.
 */
describe("goal.close refuses until every approved criterion is verified", () => {
  /**
   * The `goal.close` handler at its OWN seam, over the real store.
   *
   * It is driven directly rather than through `send` because the shared pipeline refuses a
   * compiled-journey goal BOTH earlier and for an unrelated reason: `COMMAND_PREREQUISITES`
   * (bootstrap-sequence.ts:22) requires a durable `approval.decide`, and the Product Contract
   * journey activates through `approval.decide_intent`. Routing these arms through `send` would
   * assert BOOTSTRAP_PREREQUISITE_MISSING — a green test of a gate that is not this one, which
   * is exactly the vacuity the reason-code rail forbids. `runBootstrapCommand` contributes
   * ingress decoding, the sequence gate and replay; none of them is under test here, and the
   * contract-less arm below still drives the FULL authenticated wire end to end.
   */
  const closeAttempt = (store: SqliteEventStore, commandId = "cmd-close-1"): ServiceOutcome => {
    const handler = GOAL_HANDLERS["goal.close"];
    if (handler === undefined) throw new Error("goal.close is not in GOAL_HANDLERS");
    return handler({
      ledger: readDurableLedger(store, PROJECT_ID),
      request: {
        commandId, correlationId: "corr-close", decidedAt: "2026-09-02T12:10:00.000Z",
        expectedVersion: store.getAggregateVersion(GOAL_ID), kind: "goal.close",
        payload: acceptancePayload() as JsonObject, principalId: "operator-local",
        projectId: PROJECT_ID, schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      },
      store,
    });
  };

  it("refuses GOAL_CLOSE_CRITERIA_UNVERIFIED at DAEMON_PREREQUISITE and commits nothing", () => {
    const { store } = contractBearingWorld(["crit-1", "crit-2", "crit-3"]);
    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID))
      .toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });
    const decisionsBefore = decisionCount(store);
    const goalEventsBefore = store.readEvents(GOAL_ID).length;

    const outcome = closeAttempt(store);

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_CRITERIA_UNVERIFIED", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
    // Nothing was committed and no witness was minted: the gate runs BEFORE qualification.
    expect(decisionCount(store)).toBe(decisionsBefore);
    expect(store.readEvents(GOAL_ID)).toHaveLength(goalEventsBefore);
    expect(store.readEvents(GOAL_ID).filter((e) => e.eventType === "GoalCompleted")).toHaveLength(0);
    expect((readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
      { lifecycle?: string } | undefined)?.lifecycle).toBe("EXECUTION_ENABLED");
  }, 30_000);

  it("refuses closure after a real node test acceptance and landing without criterion evidence", () => {
    const { store } = contractBearingWorld(["crit-1", "crit-2", "crit-3"]);
    const nodeRef = acceptNode(store, "node-slice");
    seedLandingReceipt(store, nodeRef, "COMMITTED");
    const before = decisionCount(store);
    const outcome = closeAttempt(store);
    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_CRITERIA_UNVERIFIED", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
    const coverage = createDocumentCoverageReadPort({ projectId: PROJECT_ID, store }).readCoverage({ goalRef: GOAL_ID });
    expect(coverage.outcome).toBe("COVERAGE");
    if (coverage.outcome !== "COVERAGE") throw new Error("fixture coverage refused");
    expect(coverage.contracts.flatMap((contract) => contract.requirements.flatMap((row) => row.criteria)))
      .toHaveLength(3);
    expect(coverage.contracts.flatMap((contract) => contract.requirements.flatMap((row) => row.criteria)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ nodeTestStatus: "NODE_TEST_PASSED", status: "EVIDENCE_REQUIRED" })]));
    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID)).toEqual({ criteria: 3, kind: "NOT_READY", verified: 0 });
    expect(decisionCount(store)).toBe(before);
    expect(store.readEvents(GOAL_ID).filter((event) => event.eventType === "GoalCompleted")).toHaveLength(0);
  }, 30_000);

  it("keeps refusing when a new contract adds more criteria without evidence", () => {
    const { sha, store } = contractBearingWorld(["crit-1", "crit-2", "crit-3"]);
    acceptNode(store, "node-slice");
    expect(closeAttempt(store)).toMatchObject({ code: "GOAL_CLOSE_CRITERIA_UNVERIFIED" });

    proposeRevision(store, sha, SECOND_CONTRACT_ID, "rev-close-2", ["crit-4", "crit-5"]);

    expect(closeAttempt(store, "cmd-close-2")).toMatchObject({
      code: "GOAL_CLOSE_CRITERIA_UNVERIFIED", ok: false, refusedBy: "DAEMON_PREREQUISITE",
    });
  }, 30_000);

  it.runIf(process.platform === "win32")("closes a contract-less goal with actual Foundation evidence", async () => {
    // NO_CONTRACT still falls through to qualification. A real Foundation receipt,
    // review and activation account prove the legacy leg; raw LIVE evidence cannot.
    const store = openStore();
    const verified = await seedVerifiedNode(store);
    seedReviewAcceptance(store, verified.nodeRef);
    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID)).toEqual({ kind: "NO_CONTRACT" });

    const closed = closeGoalThroughCommandPath(store, 2);

    expect(closed.ok).toBe(true);
    expect(store.readEvents(GOAL_ID).filter((e) => e.eventType === "GoalCompleted")).toHaveLength(1);
    expect((readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
      { lifecycle?: string } | undefined)?.lifecycle).toBe("COMPLETED");
  }, 120_000);
});

/**
 * THE OFFER GATE at `/affordances/read`, over the PRODUCTION port and a real store — the same
 * surface the control room polls. `affordance-planning-offers.test.ts` pins the ladder's per-
 * lifecycle behaviour against a staged fact; these arms prove the fact is actually WIRED, which
 * a stubbed ladder test can never show.
 */
describe("/affordances/read withholds goal.close until the product is verified", () => {
  let minted = 0;
  /**
   * Every offer the surface makes ABOUT THIS GOAL — the per-goal ladder's whole output, and the
   * set the arms below assert equality over. The scope is narrowed to this goal's two target
   * aggregates on purpose: the rest of the surface is the bootstrap ladder (session.*,
   * policy.install, goal.create against freshly minted ids), which is unrelated to this gate and
   * carries non-deterministic session identifiers. Narrowed by TARGET, never by kind, so a
   * `goal.close` that wrongly appears still lands inside the assertion.
   */
  const goalOffers = (store: SqliteEventStore): readonly string[] => {
    const result = createAffordancePort({
      mintId: () => `afford-close-${String(minted += 1)}`, projectId: PROJECT_ID, store,
    }).readSurface();
    if (!("nextAllowedCommands" in result)) throw new Error("expected a surface, got a refusal");
    return result.nextAllowedCommands
      .filter((entry) => entry.targetAggregateId === GOAL_ID
        || entry.targetAggregateId === `publish:${GOAL_ID}`)
      .map((entry) => `${entry.commandKind}@${entry.targetAggregateId}`).sort();
  };

  it("withholds close after node test acceptance and landing while retaining the publish offer", () => {
    const { store } = contractBearingWorld(["crit-1", "crit-2", "crit-3"]);

    // A publishable commit proves landing, while criterion evidence still gates close.
    expect(goalOffers(store)).toEqual([]);

    const nodeRef = acceptNode(store, "node-slice");

    expect(goalOffers(store)).toEqual([]);

    seedLandingReceipt(store, nodeRef, "COMMITTED");

    expect(goalOffers(store)).toEqual([
      `repository.publish@publish:${GOAL_ID}`,
    ]);
  }, 30_000);

  it("keeps close withheld and publish available when a new contract adds criteria", () => {
    const { sha, store } = contractBearingWorld(["crit-1", "crit-2", "crit-3"]);
    const nodeRef = acceptNode(store, "node-slice");
    seedLandingReceipt(store, nodeRef, "COMMITTED");
    expect(goalOffers(store)).toEqual([`repository.publish@publish:${GOAL_ID}`]);

    proposeRevision(store, sha, SECOND_CONTRACT_ID, "rev-close-2", ["crit-4", "crit-5"]);

    expect(goalOffers(store)).toEqual([`repository.publish@publish:${GOAL_ID}`]);
  }, 30_000);

  it("offers a contract-less goal exactly as it did before this gate existed", () => {
    // The seed/Foundation journey. Its goal.close card is what board-chain.spec.ts asserts
    // appears right after activation, and NO_CONTRACT is what keeps it there.
    const store = openStore();
    approveNodes(store, ["node-1"]);
    expect(goalCloseReadinessFor(store, PROJECT_ID, GOAL_ID)).toEqual({ kind: "NO_CONTRACT" });

    expect(goalOffers(store)).toContain(`goal.close@${GOAL_ID}`);
  }, 30_000);
});
