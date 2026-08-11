/**
 * Package-ROOT reachability contract for @moe/core.
 *
 * Every specifier here is the bare package root. `packages/core/package.json`
 * pins `"exports": { ".": "./src/index.ts" }` — an exclusive map — so a deep
 * subpath would not resolve for a real consumer and testing one would prove
 * nothing. The expected namespace below is hand-transcribed, never derived from
 * the namespace under test, so a removed export AND an unreviewed addition both
 * go red.
 *
 * THREE GUARDS, EACH BLIND TO WHAT THE OTHER TWO SEE.
 *  1. The count and name-set pins below see RUNTIME VALUES only. A published
 *     `export type` is invisible to them.
 *  2. The type block therefore annotates each published type on a value that
 *     came through the bare specifier, so an unpublished type is a tsc error
 *     rather than a silently green test.
 *  3. Neither of those runs in real Node. vitest rewrites a `./foo.js`
 *     specifier back to `foo.ts`; Node does not, and `--experimental-strip-types`
 *     ERASES every `export type`. A closure published only as types satisfies
 *     tsc and leaves NOTHING importable. Only the child-process probes at the
 *     bottom can tell those apart.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import * as core from "@moe/core";
import type {
  ExpansionAdmittedFacts, ExpansionApprovalBinding, ExpansionApprovalClaim, ExpansionApprovalCode,
  ExpansionApprovalComponent, ExpansionApprovalCriteria, ExpansionApprovalLayer,
  ExpansionApprovalRefusal, ExpansionApprovalRequest, ExpansionApprovalResult,
  ExpansionBudgetReservationFacts, ExpansionFairnessFacts, ExpansionFenceFacts,
  ExpansionFundingFacts, ExpansionPolicyFacts, ExpansionPreparation, ExpansionPreparationCode,
  ExpansionPreparationComponent, ExpansionPreparationInput, ExpansionPreparationLayer,
  ExpansionPreparationRefusal, ExpansionPreparationResult, ExpansionPreparationSources,
  ExpansionPreparedFacts, ExpansionResourceReservationFacts,
} from "@moe/core";
import type { ApprovalDecisionRecord, PolicyEvaluationInput } from "@moe/core";

type ExportKind = "array" | "function" | "record" | "string";
/**
 * Hand-transcribed: 20 pre-existing vocabulary values + 5 transition records +
 * 3 obligation/layer strings + 33 pre-existing functions + the 8 expansion
 * preparation and approval values published by this task.
 */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["APPROVAL_ACTOR_KINDS", "array"], ["APPROVAL_COMMAND_KINDS", "array"],
  ["CARRY_FORWARD_REASON_CODES", "array"], ["CORE_DECISION_REASON_OBLIGATION", "string"],
  ["CORE_STEP_UP_OBLIGATION", "string"],
  ["EXPANSION_APPROVAL_CODES", "array"], ["EXPANSION_APPROVAL_COMPONENTS", "array"],
  ["EXPANSION_APPROVAL_LAYERS", "array"],
  ["EXPANSION_HOLD_CAUSES", "array"], ["EXPANSION_HOLD_COMMAND_KINDS", "array"],
  ["EXPANSION_HOLD_ERROR_CODES", "array"], ["EXPANSION_HOLD_LAYERS", "array"],
  ["EXPANSION_PREPARATION_CODES", "array"], ["EXPANSION_PREPARATION_COMPONENTS", "array"],
  ["EXPANSION_PREPARATION_LAYERS", "array"],
  ["GOAL_COMMAND_KINDS", "array"], ["GOAL_TRANSITIONS", "record"],
  ["GRAPH_REVISION_COMMAND_KINDS", "array"], ["GRAPH_REVISION_TRANSITIONS", "record"],
  ["PLANNING_EXPANSION_ERROR_CODES", "array"], ["PLANNING_EXPANSION_LAYERS", "array"],
  ["PLANNING_EXPANSION_TARGETS", "array"], ["PLANNING_RUN_COMMAND_KINDS", "array"],
  ["PLANNING_RUN_TRANSITIONS", "record"],
  ["POLICY_AUTO_APPROVAL_TIERS", "array"], ["POLICY_OBLIGATION_KINDS", "array"],
  ["POLICY_OUTCOMES", "array"], ["POLICY_OUTCOME_DOMINANCE", "array"],
  ["POLICY_REASON_CODES", "array"], ["POLICY_RISK_TIERS", "array"],
  ["POLICY_RULE_EFFECTS", "array"], ["PRINCIPAL_KINDS", "array"],
  ["PROJECT_COMMAND_KINDS", "array"], ["PROJECT_TRANSITIONS", "record"],
  ["SESSION_AUTH_LAYERS", "array"], ["SESSION_STATUSES", "array"],
  ["SUPERSESSION_DISPOSITION_KINDS", "array"], ["SUPERSESSION_KERNEL_LAYER", "string"],
  ["applyApprovalCommand", "function"], ["applyApprovalInvalidation", "function"],
  ["approveExpansionManually", "function"], ["authenticateCommand", "function"],
  ["authenticateSession", "function"], ["canonicalizeCapabilities", "function"],
  ["createCredential", "function"], ["createPrincipal", "function"],
  ["createSession", "function"], ["decideSupersession", "function"],
  ["evaluateCarryForward", "function"], ["evaluatePolicy", "function"],
  ["inspectPlanningExpansionContract", "function"], ["isCurrentGeneration", "function"],
  ["isSessionUsableAt", "function"], ["matchCapability", "function"],
  ["prepareExpansion", "function"], ["reduceExpansionPlanningHold", "function"],
  ["reduceGoal", "function"], ["reduceGraphRevision", "function"],
  ["reducePlanningRun", "function"], ["reduceProject", "function"],
  ["rotateCredential", "function"], ["snapshotPlanningRunContractState", "function"],
  ["validExpansionCreateCommand", "function"], ["validExpansionCreatedEvent", "function"],
  ["validExpansionHoldBinding", "function"], ["validExpansionProposalIdentity", "function"],
  ["validExpansionProposeCommand", "function"], ["validExpansionSealedEvent", "function"],
  ["validPlanningRunContractState", "function"],
];
const surface: Readonly<Record<string, unknown>> = core;

it("generates one expectation per published root export", () => {
  expect(EXPECTED_EXPORTS.length).toBe(69);
});

it("publishes exactly the reviewed root namespace, with no loss and no addition", () => {
  expect(Object.keys(core).filter((key) => key !== "default").sort())
    .toEqual(EXPECTED_EXPORTS.map(([name]) => name));
});

it.each(EXPECTED_EXPORTS)("publishes %s on the package root as a %s", (name, kind) => {
  const value = surface[name];
  // Checked FIRST and by name: an import cycle yields a TDZ-undefined binding
  // that satisfies every `typeof` check below by reporting "undefined".
  expect(`${name}=${value === undefined ? "undefined" : "defined"}`).toBe(`${name}=defined`);
  if (kind === "array") expect(Array.isArray(value)).toBe(true);
  else if (kind === "record") {
    expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  } else expect(typeof value).toBe(kind);
});

/**
 * The expansion closure this task published, exercised through the bare
 * specifier. Fixtures are rebuilt inline: expansion-approval.test.ts is not
 * importable through the exclusive `exports` map, so a real consumer could not
 * reach its helpers either. They are fixture DATA — every verdict below is
 * decided by the production surface, never re-derived here.
 */
const hex = (character: string): string => character.repeat(64);

const PREDECESSOR = { graphContentHash: hex("a"), graphEpoch: 7, revisionId: "revision-1" };
const SUCCESSOR = {
  graphContentHash: hex("b"), graphEpoch: 8,
  predecessorGraphContentHash: PREDECESSOR.graphContentHash,
  predecessorRevisionId: PREDECESSOR.revisionId, revisionId: "revision-2",
};

/** Tier R2 is human-only (design 710), so this evaluates to REQUIRE_HUMAN_APPROVAL. */
const policyInput = (): PolicyEvaluationInput => ({
  action: "graph.expand", actor: "human:reviewer-1", callerRiskHint: null,
  decisionDigest: hex("c"), evaluatedAtEpochMs: 1_700_000_000_000,
  evaluatorVersion: "policy-evaluator-v1",
  facts: [{ factId: "fact-risk", tier: "R2", truthClass: "DAEMON_VERIFIED" }],
  graphNodeRevisionRefs: ["revision-1"], policyRevisionRef: hex("d"),
  requiredFactIds: ["fact-risk"], scope: ["child-a", "child-b"],
  sliceChain: [{
    autoApprovalOptIns: [], sliceRef: "slice-root",
    rules: [{ effect: "ALLOW", obligations: [], requiredFactIds: ["fact-risk"], ruleId: "rule-1" }],
  }],
  waivers: [],
});

/**
 * Typed as the PUBLISHED ExpansionPreparationInput rather than cast into it. A
 * cast would assert the shape instead of checking it, and the point of the
 * annotation is that tsc rejects the fixture if the published type drifts from
 * what prepareExpansion actually accepts.
 */
const preparationInput = (): ExpansionPreparationInput => ({
  admitted: {
    budgetReservation: {
      accountId: "account-1", admissionRef: "admission-1",
      reservationId: "budget-reservation-1", state: "RESERVED",
    },
    childKeys: ["child-a", "child-b"], evidenceDigest: hex("1"),
    fairness: {
      capRevisionRef: "cap-revision-3", opportunityRef: "opportunity-1",
      resourceId: "resource-1", workItemId: "work-item-1",
    },
    goalVersion: 4, observedAtSequence: 12, proposalId: "proposal-1", qualityDigest: hex("2"),
    resourceReservation: { epoch: 5, resourceIds: ["resource-1"], state: "HELD" },
    revision: 3, sourceDigests: [hex("3")], truthClass: "DAEMON_VERIFIED",
  },
  criteria: {
    approvalRef: "approval-1", budgetRef: hex("4"), criteriaRef: hex("5"),
    dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
    riskTier: "R2",
  },
  deadlineEpochMs: 1_700_000_600_000,
  fence: {
    authorityFencedRef: "fenced-authority-1", fencedAtEpoch: 7, subordinateAuthorityFenced: true,
  },
  funding: {
    fundingRef: "funding-1", meter: "EXECUTION", quantity: 9,
    reservationId: "funding-reservation-1", state: "RESERVED",
  },
  graphLifecycle: "ACTIVE", policy: policyInput(),
  supersession: {
    dispositions: [{
      kind: "ADD", nodeKey: "node-add", predecessorAuthorityHash: null,
      safeCarry: null, successorAuthorityHash: hex("1"),
    }],
    expectedPredecessor: { ...PREDECESSOR }, successor: { ...SUCCESSOR },
    supportedCanonicalizerVersions: ["canon-v1"],
  },
});

function preparedFrom(input: unknown): ExpansionPreparation {
  const result: ExpansionPreparationResult = core.prepareExpansion(input);
  if (!result.ok) throw new Error(`fixture preparation refused with ${result.code}`);
  return result.preparation;
}

it("prepares an expansion through the root and names every prepared type", () => {
  const preparation: ExpansionPreparation = preparedFrom(preparationInput());
  const bound: ExpansionPreparedFacts = preparation.bound;
  const sources: ExpansionPreparationSources = preparation.sources;
  const admitted: ExpansionAdmittedFacts = bound.admitted;
  const criteria: ExpansionApprovalCriteria = bound.criteria;
  const fence: ExpansionFenceFacts = bound.fence;
  const funding: ExpansionFundingFacts = bound.funding;
  const policy: ExpansionPolicyFacts = bound.policyDecision;
  const budget: ExpansionBudgetReservationFacts = admitted.budgetReservation;
  const resources: ExpansionResourceReservationFacts = admitted.resourceReservation;
  const fairness: ExpansionFairnessFacts = admitted.fairness;

  expect(preparation.identity).toMatch(/^[0-9a-f]{64}$/u);
  expect(bound.supersessionAuthorityHash).toMatch(/^[0-9a-f]{64}$/u);
  expect(policy.decision).toBe("REQUIRE_HUMAN_APPROVAL");
  expect(policy.policyRevisionRef).toBe(hex("d"));
  expect([budget.state, resources.state, funding.state]).toEqual(["RESERVED", "HELD", "RESERVED"]);
  expect([criteria.riskTier, fence.subordinateAuthorityFenced]).toEqual(["R2", true]);
  expect([fairness.workItemId, admitted.truthClass]).toEqual(["work-item-1", "DAEMON_VERIFIED"]);
  expect(sources.supersession.expectedPredecessor.revisionId).toBe("revision-1");
});

it("refuses a preparation from the root, naming code, component and layer", () => {
  const input = { ...preparationInput(), graphLifecycle: "SUPERSEDED" };
  const result: ExpansionPreparationResult = core.prepareExpansion(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionPreparationRefusal = result;
  const code: ExpansionPreparationCode = "EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE";
  const component: ExpansionPreparationComponent = refusal.component;
  const layer: ExpansionPreparationLayer = refusal.layer;
  expect([refusal.code, component, layer]).toEqual([code, "GRAPH_REVISION", "LIFECYCLE"]);
  expect(core.EXPANSION_PREPARATION_CODES).toContain(code);
  expect(core.EXPANSION_PREPARATION_COMPONENTS).toContain(component);
  expect(core.EXPANSION_PREPARATION_LAYERS).toContain(layer);
});

const humanApproval = (): ApprovalDecisionRecord => ({
  actor: "human:reviewer-1", actorKind: "HUMAN", applicablePolicyRef: hex("d"),
  approvalRef: "approval-1", approvedNodeScope: ["child-a", "child-b"], budgetRef: hex("4"),
  criteriaRef: hex("5"), decision: null, decisionReason: null,
  dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
  exactRevisionHash: hex("b"), lifecycle: "PENDING", planQualityAssessmentRef: hex("2"),
  policyDecisionRef: hex("c"), riskTier: "R2", stepUpAuthRef: "step-up-1",
  truthClass: "HUMAN_APPROVED", validity: "CURRENT",
});

function approvalRequest(): ExpansionApprovalRequest {
  const preparation = preparedFrom(preparationInput());
  const claim: ExpansionApprovalClaim = {
    budgetReservationId: preparation.bound.admitted.budgetReservation.reservationId,
    budgetReservationState: preparation.bound.admitted.budgetReservation.state,
    preparationIdentity: preparation.identity,
    resourceEpoch: preparation.bound.admitted.resourceReservation.epoch,
    resourceIds: [...preparation.bound.admitted.resourceReservation.resourceIds],
    resourceReservationState: preparation.bound.admitted.resourceReservation.state,
    supersessionAuthorityHash: preparation.bound.supersessionAuthorityHash,
  };
  return {
    approval: humanApproval(), claim,
    command: {
      decision: "APPROVE", decisionReason: "approved after review",
      kind: "approval.decide", stepUpAuthRef: "step-up-1",
    },
    nowEpochMs: 1_700_000_300_000, preparation,
  };
}

it("approves an expansion manually through the root and names every approval type", () => {
  const request: ExpansionApprovalRequest = approvalRequest();
  const result: ExpansionApprovalResult = core.approveExpansionManually(request);
  if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
  const binding: ExpansionApprovalBinding = result.binding;
  expect(binding.approvalRef).toBe("approval-1");
  expect(binding.preparationIdentity).toBe(request.preparation.identity);
  expect(binding.identity).toMatch(/^[0-9a-f]{64}$/u);
  expect(binding.decidedApproval.decision).toBe("APPROVE");
});

it("refuses a non-human approval from the root, naming code, component and layer", () => {
  const request: ExpansionApprovalRequest = {
    ...approvalRequest(), approval: { ...humanApproval(), actorKind: "SYSTEM_POLICY" },
  };
  const result: ExpansionApprovalResult = core.approveExpansionManually(request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  const refusal: ExpansionApprovalRefusal = result;
  const code: ExpansionApprovalCode = refusal.code;
  const component: ExpansionApprovalComponent = refusal.component;
  const layer: ExpansionApprovalLayer = refusal.layer;
  expect(core.EXPANSION_APPROVAL_CODES).toContain(code);
  expect(core.EXPANSION_APPROVAL_COMPONENTS).toContain(component);
  expect(core.EXPANSION_APPROVAL_LAYERS).toContain(layer);
  expect([code, layer]).toEqual(["EXPANSION_APPROVAL_RECORD_INVALID", "INPUT"]);
});

it("publishes the core expansion vocabularies as frozen closed sets", () => {
  for (const vocabulary of [
    core.EXPANSION_APPROVAL_CODES, core.EXPANSION_APPROVAL_COMPONENTS,
    core.EXPANSION_APPROVAL_LAYERS, core.EXPANSION_PREPARATION_CODES,
    core.EXPANSION_PREPARATION_COMPONENTS, core.EXPANSION_PREPARATION_LAYERS,
  ]) {
    expect(Object.isFrozen(vocabulary)).toBe(true);
  }
});

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_KILL_MS = 20_000;

/**
 * cwd is the package root so the bare specifier `@moe/core` resolves through
 * this package's own `exports` map via Node's self-reference rule — the exact
 * resolution `@moe/scheduler` and `@moe/daemon` get.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    // Killed on timeout rather than left to outlive the run: vitest's own test
    // timeout fails the assertion but would not reap the child.
    { cwd: PACKAGE_ROOT, timeout: CHILD_KILL_MS },
  );
  return JSON.parse(stdout) as unknown;
};

const REPORT_ROOT_ENTRY = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/core");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    namedExportCount: keys.length,
    undefinedBindingCount: keys.filter((key) => ns[key] === undefined).length,
    prepareExpansion: typeof ns.prepareExpansion,
    approveExpansionManually: typeof ns.approveExpansionManually,
    reduceExpansionPlanningHold: typeof ns.reduceExpansionPlanningHold,
    reducePlanningRun: typeof ns.reducePlanningRun,
    preparationLayers: [...(ns.EXPANSION_PREPARATION_LAYERS ?? [])],
    approvalComponents: [...(ns.EXPANSION_APPROVAL_COMPONENTS ?? [])],
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const reportUnbridged = (specifier: string): string => `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  await import(${JSON.stringify("SPECIFIER")});
  report({ outcome: "IMPORTED", code: "NONE" });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`.replace(JSON.stringify("SPECIFIER"), JSON.stringify(specifier));

it("loads @moe/core in Node's strip-types runtime with the expansion closure importable", async () => {
  // Asserts the BINDINGS, not the exit code: a child can exit 0 having imported
  // nothing, and type-stripping erases every `export type`, so a closure
  // published only as types would arrive here with these values missing while
  // tsc stayed green. The two vocabularies are compared by LITERAL equality
  // rather than by length: a frozen array that lost a member keeps its type.
  expect(await probe(REPORT_ROOT_ENTRY)).toEqual({
    outcome: "IMPORTED",
    namedExportCount: 69,
    undefinedBindingCount: 0,
    prepareExpansion: "function",
    approveExpansionManually: "function",
    reduceExpansionPlanningHold: "function",
    reducePlanningRun: "function",
    preparationLayers: [
      "BUDGET", "EVIDENCE", "FENCE", "FUNDING", "INPUT", "LIFECYCLE", "POLICY", "RESOURCE",
      "SUPERSESSION_KERNEL",
    ],
    approvalComponents: [
      "APPROVAL_COMMAND", "APPROVAL_VALIDATION", "EXPANSION_APPROVAL", "EXPANSION_PREPARATION",
      "POLICY_EVALUATION", "SUPERSESSION_ENGINE",
    ],
  });
}, CHILD_TIMEOUT_MS);

it("still refuses an unbridged test module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control, and the reason the probe above is not vacuous. It pins the
  // LITERAL reason code rather than "it threw": it proves test-tier code was kept
  // off the runtime surface AND that a broken probe would report FAILED instead
  // of quietly reporting IMPORTED for a package that never loaded.
  expect(await probe(reportUnbridged("./src/index-surface.test.js"))).toEqual({
    outcome: "FAILED",
    code: "ERR_MODULE_NOT_FOUND",
  });
}, CHILD_TIMEOUT_MS);
