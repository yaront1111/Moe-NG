/**
 * Expansion preparation and manual approval binding.
 *
 * The admitted expansion arrives as INBOUND DATA, never as an imported scheduler symbol:
 * `@moe/core` declares only `@moe/contracts`, and `@moe/scheduler` depends on `@moe/core`, so
 * the reverse edge is a cycle. Every fixture below is therefore hand-built to this package's
 * own closed shape.
 */
import { describe, expect, it } from "vitest";

import {
  EXPANSION_PREPARATION_CODES,
  EXPANSION_PREPARATION_COMPONENTS,
  EXPANSION_PREPARATION_LAYERS,
  prepareExpansion,
} from "./expansion-preparation.js";
import type {
  ExpansionPreparationInput,
  ExpansionPreparationResult,
} from "./expansion-preparation.js";
import {
  EXPANSION_APPROVAL_CODES,
  EXPANSION_APPROVAL_COMPONENTS,
  EXPANSION_APPROVAL_LAYERS,
  approveExpansionManually,
} from "./expansion-approval.js";
import type { ExpansionApprovalResult } from "./expansion-approval.js";

const hex = (character: string): string => character.repeat(64);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const PREDECESSOR = {
  graphContentHash: hex("a"), graphEpoch: 7, revisionId: "revision-1",
};
const SUCCESSOR = {
  graphContentHash: hex("b"), graphEpoch: 8,
  predecessorGraphContentHash: PREDECESSOR.graphContentHash,
  predecessorRevisionId: PREDECESSOR.revisionId, revisionId: "revision-2",
};

const supersessionInput = (): Record<string, unknown> => ({
  dispositions: [{
    kind: "ADD", nodeKey: "node-add", predecessorAuthorityHash: null,
    safeCarry: null, successorAuthorityHash: hex("1"),
  }],
  expectedPredecessor: { ...PREDECESSOR },
  successor: { ...SUCCESSOR },
  supportedCanonicalizerVersions: ["canon-v1"],
});

/** Tier `R2` is human-only (design 710), so this input evaluates to REQUIRE_HUMAN_APPROVAL. */
const policyInput = (): Record<string, unknown> => ({
  action: "graph.expand",
  actor: "human:reviewer-1",
  callerRiskHint: null,
  decisionDigest: hex("c"),
  evaluatedAtEpochMs: 1_700_000_000_000,
  evaluatorVersion: "policy-evaluator-v1",
  facts: [{ factId: "fact-risk", tier: "R2", truthClass: "DAEMON_VERIFIED" }],
  graphNodeRevisionRefs: ["revision-1"],
  policyRevisionRef: hex("d"),
  requiredFactIds: ["fact-risk"],
  scope: ["child-a", "child-b"],
  sliceChain: [{
    autoApprovalOptIns: [], sliceRef: "slice-root",
    rules: [{
      effect: "ALLOW", obligations: [], requiredFactIds: ["fact-risk"], ruleId: "rule-1",
    }],
  }],
  waivers: [],
});

const admittedFacts = (): Record<string, unknown> => ({
  budgetReservation: {
    accountId: "account-1", admissionRef: "admission-1",
    reservationId: "budget-reservation-1", state: "RESERVED",
  },
  childKeys: ["child-a", "child-b"],
  evidenceDigest: hex("1"),
  fairness: {
    capRevisionRef: "cap-revision-3", opportunityRef: "opportunity-1",
    resourceId: "resource-1", workItemId: "work-item-1",
  },
  goalVersion: 4,
  observedAtSequence: 12,
  proposalId: "proposal-1",
  qualityDigest: hex("2"),
  resourceReservation: { epoch: 5, resourceIds: ["resource-1"], state: "HELD" },
  revision: 3,
  sourceDigests: [hex("3")],
  truthClass: "DAEMON_VERIFIED",
});

const preparationInput = (): Record<string, unknown> => ({
  admitted: admittedFacts(),
  criteria: {
    approvalRef: "approval-1", budgetRef: hex("4"), criteriaRef: hex("5"),
    dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
    riskTier: "R2",
  },
  deadlineEpochMs: 1_700_000_600_000,
  fence: {
    authorityFencedRef: "fenced-authority-1", fencedAtEpoch: 7,
    subordinateAuthorityFenced: true,
  },
  funding: {
    fundingRef: "funding-1", meter: "EXECUTION", quantity: 9,
    reservationId: "funding-reservation-1", state: "RESERVED",
  },
  graphLifecycle: "ACTIVE",
  policy: policyInput(),
  supersession: supersessionInput(),
});

function accepted(result: ExpansionPreparationResult): {
  readonly bound: Readonly<Record<string, unknown>>; readonly identity: string;
} {
  if (!result.ok) throw new Error(`expected an accepted preparation, got ${result.code}`);
  return { bound: result.preparation.bound as unknown as Readonly<Record<string, unknown>>,
    identity: result.preparation.identity };
}

function refusal(result: ExpansionPreparationResult): Readonly<Record<string, unknown>> {
  if (result.ok) throw new Error("expected a refusal, got an accepted preparation");
  return { code: result.code, component: result.component, layer: result.layer, ok: result.ok };
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value).every((key) => deeplyFrozen(
    (value as Readonly<Record<PropertyKey, unknown>>)[key], seen,
  ));
}

const AUTHORITY_PATTERN = /run|lease|effect|slot|allocation|dispatch|activat/iu;

/**
 * Every key the module MINTS. `sources` is not descended into: it echoes the caller's own
 * evidence verbatim, and a policy rule's `effect` field is a rule effect, not an execution one.
 */
function mintedKeys(value: unknown, seen = new Set<object>(), keys: string[] = []): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return keys;
  seen.add(value);
  for (const key of Object.keys(value)) {
    keys.push(key);
    if (key !== "sources") mintedKeys((value as Record<string, unknown>)[key], seen, keys);
  }
  return keys;
}

/** A named single-field edit. Each must move the canonical identity and nothing else. */
interface Perturbation {
  readonly apply: (input: Record<string, any>) => void;
  readonly family: string;
  readonly name: string;
}

const PERTURBATIONS: readonly Perturbation[] = [
  { family: "admitted proposal", name: "proposalId",
    apply: (input) => { input["admitted"].proposalId = "proposal-2"; } },
  { family: "admitted proposal", name: "revision",
    apply: (input) => { input["admitted"].revision = 4; } },
  { family: "goal version", name: "goalVersion",
    apply: (input) => { input["admitted"].goalVersion = 5; } },
  { family: "source facts", name: "observedAtSequence",
    apply: (input) => { input["admitted"].observedAtSequence = 13; } },
  { family: "source facts", name: "childKeys",
    apply: (input) => { input["admitted"].childKeys = ["child-a", "child-c"]; } },
  { family: "source facts", name: "sourceDigests",
    apply: (input) => { input["admitted"].sourceDigests = [hex("9")]; } },
  { family: "scope/oracle/input", name: "evidenceDigest",
    apply: (input) => { input["admitted"].evidenceDigest = hex("8"); } },
  { family: "quality/dependency", name: "qualityDigest",
    apply: (input) => { input["admitted"].qualityDigest = hex("7"); } },
  { family: "budget reservation", name: "budgetReservation.reservationId",
    apply: (input) => { input["admitted"].budgetReservation.reservationId = "budget-2"; } },
  { family: "budget reservation", name: "budgetReservation.accountId",
    apply: (input) => { input["admitted"].budgetReservation.accountId = "account-2"; } },
  { family: "resource reservation", name: "resourceReservation.epoch",
    apply: (input) => { input["admitted"].resourceReservation.epoch = 6; } },
  { family: "resource reservation", name: "resourceReservation.resourceIds",
    apply: (input) => { input["admitted"].resourceReservation.resourceIds = ["resource-2"]; } },
  { family: "fairness opportunity", name: "fairness.opportunityRef",
    apply: (input) => { input["admitted"].fairness.opportunityRef = "opportunity-2"; } },
  { family: "fairness cap revision", name: "fairness.capRevisionRef",
    apply: (input) => { input["admitted"].fairness.capRevisionRef = null; } },
  { family: "approval criteria", name: "criteria.approvalRef",
    apply: (input) => { input["criteria"].approvalRef = "approval-2"; } },
  { family: "approval criteria", name: "criteria.budgetRef",
    apply: (input) => { input["criteria"].budgetRef = hex("6"); } },
  { family: "approval criteria", name: "criteria.criteriaRef",
    apply: (input) => { input["criteria"].criteriaRef = hex("e"); } },
  { family: "approval criteria", name: "criteria.riskTier",
    apply: (input) => { input["criteria"].riskTier = "R3"; } },
  { family: "quality/dependency", name: "criteria.dependencyChanges",
    apply: (input) => { input["criteria"].dependencyChanges.additions = ["dependency-b"]; } },
  { family: "deadline", name: "deadlineEpochMs",
    apply: (input) => { input["deadlineEpochMs"] = 1_700_000_700_000; } },
  { family: "supersession fence", name: "fence.authorityFencedRef",
    apply: (input) => { input["fence"].authorityFencedRef = "fenced-authority-2"; } },
  { family: "supersession fence", name: "fence.fencedAtEpoch",
    apply: (input) => { input["fence"].fencedAtEpoch = 8; } },
  { family: "supersession funding", name: "funding.fundingRef",
    apply: (input) => { input["funding"].fundingRef = "funding-2"; } },
  { family: "supersession funding", name: "funding.quantity",
    apply: (input) => { input["funding"].quantity = 10; } },
  { family: "policy", name: "policy.decisionDigest",
    apply: (input) => { input["policy"].decisionDigest = hex("f"); } },
  { family: "policy", name: "policy.policyRevisionRef",
    apply: (input) => { input["policy"].policyRevisionRef = hex("0"); } },
  { family: "supersession disposition", name: "supersession.dispositions[0].nodeKey",
    apply: (input) => { input["supersession"].dispositions[0].nodeKey = "node-other"; } },
  { family: "supersession disposition", name: "supersession.successor.revisionId",
    apply: (input) => { input["supersession"].successor.revisionId = "revision-3"; } },
  { family: "graph epoch", name: "supersession graph epoch pair",
    apply: (input) => {
      input["supersession"].expectedPredecessor.graphEpoch = 9;
      input["supersession"].successor.graphEpoch = 10;
    } },
  { family: "graph content hash", name: "supersession graph content hash pair",
    apply: (input) => {
      input["supersession"].expectedPredecessor.graphContentHash = hex("2");
      input["supersession"].successor.predecessorGraphContentHash = hex("2");
    } },
];

/** Hand-written so a shrunken generator cannot pass by producing fewer cases. */
const PERTURBATION_NAMES: readonly string[] = [
  "proposalId", "revision", "goalVersion", "observedAtSequence", "childKeys", "sourceDigests",
  "evidenceDigest", "qualityDigest", "budgetReservation.reservationId",
  "budgetReservation.accountId", "resourceReservation.epoch", "resourceReservation.resourceIds",
  "fairness.opportunityRef", "fairness.capRevisionRef", "criteria.approvalRef",
  "criteria.budgetRef", "criteria.criteriaRef", "criteria.riskTier", "criteria.dependencyChanges",
  "deadlineEpochMs", "fence.authorityFencedRef", "fence.fencedAtEpoch", "funding.fundingRef",
  "funding.quantity", "policy.decisionDigest", "policy.policyRevisionRef",
  "supersession.dispositions[0].nodeKey", "supersession.successor.revisionId",
  "supersession graph epoch pair", "supersession graph content hash pair",
];

/** Every family DoD 1 enumerates, asserted as a set so a dropped family is visible. */
const BOUND_FAMILIES: readonly string[] = [
  "admitted proposal", "approval criteria", "budget reservation", "deadline", "fairness cap revision",
  "fairness opportunity", "goal version", "graph content hash", "graph epoch", "policy",
  "quality/dependency", "resource reservation", "scope/oracle/input", "source facts",
  "supersession disposition", "supersession fence", "supersession funding",
];

describe("expansion preparation vocabulary", () => {
  it("publishes the exact closed refusal vocabulary", () => {
    expect(EXPANSION_PREPARATION_CODES).toEqual([
      "EXPANSION_PREPARATION_BUDGET_NOT_RESERVED",
      "EXPANSION_PREPARATION_EVIDENCE_UNKNOWN",
      "EXPANSION_PREPARATION_FENCE_UNPROVEN",
      "EXPANSION_PREPARATION_FUNDING_NOT_RESERVED",
      "EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE",
      "EXPANSION_PREPARATION_INPUT_INVALID",
      "EXPANSION_PREPARATION_POLICY_INPUT_INVALID",
      "EXPANSION_PREPARATION_POLICY_NOT_ELIGIBLE",
      "EXPANSION_PREPARATION_RESOURCES_NOT_HELD",
    ]);
    expect(EXPANSION_PREPARATION_LAYERS).toEqual([
      "BUDGET", "EVIDENCE", "FENCE", "FUNDING", "INPUT", "LIFECYCLE", "POLICY", "RESOURCE",
      "SUPERSESSION_KERNEL",
    ]);
    expect(EXPANSION_PREPARATION_COMPONENTS).toEqual([
      "EXPANSION_PREPARATION", "GRAPH_REVISION", "POLICY_EVALUATION", "SUPERSESSION_ENGINE",
    ]);
  });
});

describe("expansion preparation identity", () => {
  it("binds every enumerated fact family into one canonical identity", () => {
    const { bound, identity } = accepted(prepareExpansion(preparationInput()));
    expect(Object.keys(bound).sort()).toEqual([
      "admitted", "criteria", "deadlineEpochMs", "fence", "funding", "graphLifecycle",
      "policyDecision", "supersessionAuthorityHash",
    ]);
    expect(bound["policyDecision"]).toEqual({
      decision: "REQUIRE_HUMAN_APPROVAL", decisionDigest: hex("c"), policyRevisionRef: hex("d"),
    });
    expect(bound["graphLifecycle"]).toBe("ACTIVE");
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("derives a byte-identical identity from a byte-identical record", () => {
    const first = accepted(prepareExpansion(preparationInput()));
    const second = accepted(prepareExpansion(preparationInput()));
    expect(second.identity).toBe(first.identity);
    expect(second.bound).toEqual(first.bound);
  });

  it("deep-freezes the whole prepared authority", () => {
    const result = prepareExpansion(preparationInput());
    expect(result.ok).toBe(true);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("mints no child run, lease, effect, slot, allocation or dispatch authority", () => {
    const result = prepareExpansion(preparationInput());
    expect(Object.keys(accepted(result) && (result as { preparation: object }).preparation).sort())
      .toEqual(["bound", "identity", "sources"]);
    const keys = mintedKeys(result);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => AUTHORITY_PATTERN.test(key))).toEqual([]);
  });

  it("generates one perturbation case per bound field and covers every family", () => {
    expect(PERTURBATIONS.map((entry) => entry.name)).toEqual(PERTURBATION_NAMES);
    expect(PERTURBATIONS.length).toBe(30);
    expect([...new Set(PERTURBATIONS.map((entry) => entry.family))].sort())
      .toEqual(BOUND_FAMILIES);
  });

  it.each(PERTURBATIONS)("moves the identity when $name changes", ({ apply }) => {
    const baseline = accepted(prepareExpansion(preparationInput()));
    const mutated = clone(preparationInput());
    apply(mutated);
    const perturbed = accepted(prepareExpansion(mutated));
    expect(perturbed.identity).not.toBe(baseline.identity);
  });
});

describe("expansion preparation refusals", () => {
  it("refuses a missing fact family without defaulting it", () => {
    const input = clone(preparationInput());
    delete input["funding"];
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_INPUT_INVALID", component: "EXPANSION_PREPARATION",
      layer: "INPUT", ok: false,
    });
  });

  it("refuses an extra key rather than ignoring it", () => {
    const input = clone(preparationInput()) as Record<string, unknown>;
    input["identity"] = hex("a");
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_INPUT_INVALID", component: "EXPANSION_PREPARATION",
      layer: "INPUT", ok: false,
    });
  });

  it("refuses an UNKNOWN admitted truth class", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["admitted"].truthClass = "UNKNOWN";
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_EVIDENCE_UNKNOWN", component: "EXPANSION_PREPARATION",
      layer: "EVIDENCE", ok: false,
    });
  });

  it("refuses a released budget reservation", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["admitted"].budgetReservation.state = "RELEASED";
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_BUDGET_NOT_RESERVED", component: "EXPANSION_PREPARATION",
      layer: "BUDGET", ok: false,
    });
  });

  it("refuses a released resource reservation", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["admitted"].resourceReservation.state = "RELEASED";
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_RESOURCES_NOT_HELD", component: "EXPANSION_PREPARATION",
      layer: "RESOURCE", ok: false,
    });
  });

  it("refuses a consumed funding reservation", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["funding"].state = "CONSUMED";
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_FUNDING_NOT_RESERVED", component: "EXPANSION_PREPARATION",
      layer: "FUNDING", ok: false,
    });
  });

  it("refuses an unfenced subordinate authority", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["fence"].subordinateAuthorityFenced = false;
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_FENCE_UNPROVEN", component: "EXPANSION_PREPARATION",
      layer: "FENCE", ok: false,
    });
  });

  it("refuses a graph lifecycle that cannot legally supersede", () => {
    const input = clone(preparationInput()) as Record<string, unknown>;
    input["graphLifecycle"] = "APPROVED";
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_GRAPH_NOT_SUPERSEDABLE", component: "GRAPH_REVISION",
      layer: "LIFECYCLE", ok: false,
    });
  });

  it("delegates a malformed policy input to the policy evaluator", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["policy"].sliceChain = [];
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_POLICY_INPUT_INVALID", component: "POLICY_EVALUATION",
      layer: "POLICY", ok: false,
    });
  });

  it("refuses a policy outcome of DENY", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["policy"].sliceChain[0].rules[0].effect = "DENY";
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_POLICY_NOT_ELIGIBLE", component: "POLICY_EVALUATION",
      layer: "POLICY", ok: false,
    });
  });

  it("refuses a policy outcome of HOLD_UNKNOWN", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["policy"].facts = [];
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "EXPANSION_PREPARATION_POLICY_NOT_ELIGIBLE", component: "POLICY_EVALUATION",
      layer: "POLICY", ok: false,
    });
  });

  it("carries the supersession kernel's own code and layer verbatim on a rebound revision", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["supersession"].successor.graphEpoch = 12;
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "REVISION_REBOUND", component: "SUPERSESSION_ENGINE",
      layer: "SUPERSESSION_KERNEL", ok: false,
    });
  });

  it("carries the supersession kernel's consequence-changed code verbatim", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    const carry = (source: string, target: string): Record<string, unknown> => ({
      canonicalizerVersion: "canon-v1", dependenciesPresent: true,
      environmentClosureUnchanged: true, policySliceUnchanged: true,
      predecessorResultUnchanged: true, sourceHash: source, targetHash: target,
    });
    input["supersession"].dispositions[0] = {
      kind: "CARRY", nodeKey: "node-carry", predecessorAuthorityHash: hex("2"),
      safeCarry: { authority: carry(hex("2"), hex("6")), inputBinding: carry(hex("8"), hex("8")) },
      successorAuthorityHash: hex("2"),
    };
    expect(refusal(prepareExpansion(input))).toEqual({
      code: "SUPERSESSION_CONSEQUENCE_CHANGED", component: "SUPERSESSION_ENGINE",
      layer: "SUPERSESSION_KERNEL", ok: false,
    });
  });

  it("leaves every refused input byte-identical", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["admitted"].truthClass = "UNKNOWN";
    const before = JSON.stringify(input);
    prepareExpansion(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("returns no prepared authority on any refusal", () => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["funding"].state = "RELEASED";
    const result = prepareExpansion(input) as ExpansionPreparationResult;
    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["code", "component", "layer", "ok"]);
    expect(deeplyFrozen(result)).toBe(true);
  });
});

describe("expansion preparation input typing", () => {
  it("accepts the declared input type through the exported surface", () => {
    const typed: ExpansionPreparationInput =
      preparationInput() as unknown as ExpansionPreparationInput;
    expect(prepareExpansion(typed).ok).toBe(true);
  });
});

/** Policy ALLOW: an R0 fact the last slice explicitly opts into (design 710). */
const allowPolicyInput = (): Record<string, unknown> => ({
  ...policyInput(),
  facts: [{ factId: "fact-risk", tier: "R0", truthClass: "DAEMON_VERIFIED" }],
  sliceChain: [{
    autoApprovalOptIns: [{ action: "graph.expand", tier: "R0" }], sliceRef: "slice-root",
    rules: [{
      effect: "ALLOW", obligations: [], requiredFactIds: ["fact-risk"], ruleId: "rule-1",
    }],
  }],
});

function preparedFrom(input: Record<string, unknown>): Record<string, unknown> {
  const result = prepareExpansion(input);
  if (!result.ok) throw new Error(`fixture preparation refused with ${result.code}`);
  return result.preparation as unknown as Record<string, unknown>;
}

const humanApproval = (): Record<string, unknown> => ({
  actor: "human:reviewer-1",
  actorKind: "HUMAN",
  applicablePolicyRef: hex("d"),
  approvalRef: "approval-1",
  approvedNodeScope: ["child-a", "child-b"],
  budgetRef: hex("4"),
  criteriaRef: hex("5"),
  decision: null,
  decisionReason: null,
  dependencyChanges: { additions: ["dependency-a"], challenges: [], removals: [] },
  exactRevisionHash: hex("b"),
  lifecycle: "PENDING",
  planQualityAssessmentRef: hex("2"),
  policyDecisionRef: hex("c"),
  riskTier: "R2",
  stepUpAuthRef: "step-up-1",
  truthClass: "HUMAN_APPROVED",
  validity: "CURRENT",
});

const decideCommand = (): Record<string, unknown> => ({
  decision: "APPROVE", decisionReason: "approved after review",
  kind: "approval.decide", stepUpAuthRef: "step-up-1",
});

const claimFor = (preparation: Record<string, any>): Record<string, unknown> => ({
  budgetReservationId: preparation["bound"].admitted.budgetReservation.reservationId,
  budgetReservationState: preparation["bound"].admitted.budgetReservation.state,
  preparationIdentity: preparation["identity"],
  resourceEpoch: preparation["bound"].admitted.resourceReservation.epoch,
  resourceIds: [...preparation["bound"].admitted.resourceReservation.resourceIds],
  resourceReservationState: preparation["bound"].admitted.resourceReservation.state,
  supersessionAuthorityHash: preparation["bound"].supersessionAuthorityHash,
});

function approvalRequest(): Record<string, any> {
  const preparation = preparedFrom(preparationInput());
  return clone({
    approval: humanApproval(), claim: claimFor(preparation), command: decideCommand(),
    nowEpochMs: 1_700_000_300_000, preparation,
  });
}

function approvalRefusal(result: ExpansionApprovalResult): Readonly<Record<string, unknown>> {
  if (result.ok) throw new Error("expected a refusal, got an approved expansion");
  return { code: result.code, component: result.component, layer: result.layer, ok: result.ok };
}

/** Refuses AND leaves every input byte-identical. Both halves, on every negative case. */
function expectApprovalRefusal(
  request: Record<string, unknown>,
  code: string,
  layer: string,
  component: string,
): void {
  const before = JSON.stringify(request);
  const result = approveExpansionManually(request);
  expect(approvalRefusal(result)).toEqual({ code, component, layer, ok: false });
  expect(JSON.stringify(request)).toBe(before);
  expect(Object.keys(result).sort()).toEqual(["code", "component", "layer", "ok"]);
  expect(deeplyFrozen(result)).toBe(true);
  expect(mintedKeys(result).filter((key) => AUTHORITY_PATTERN.test(key))).toEqual([]);
}

describe("expansion approval vocabulary", () => {
  it("publishes the exact closed refusal vocabulary", () => {
    expect(EXPANSION_APPROVAL_CODES).toEqual([
      "EXPANSION_APPROVAL_BUDGET_MISMATCH", "EXPANSION_APPROVAL_COMMAND_REFUSED",
      "EXPANSION_APPROVAL_CRITERIA_MISMATCH", "EXPANSION_APPROVAL_DEADLINE_EXPIRED",
      "EXPANSION_APPROVAL_DEPENDENCY_MISMATCH", "EXPANSION_APPROVAL_INPUT_INVALID",
      "EXPANSION_APPROVAL_MANUAL_REQUIRED", "EXPANSION_APPROVAL_NOT_APPROVED",
      "EXPANSION_APPROVAL_POLICY_CHANGED", "EXPANSION_APPROVAL_POLICY_MISMATCH",
      "EXPANSION_APPROVAL_PREPARATION_MISMATCH", "EXPANSION_APPROVAL_PREPARATION_STALE",
      "EXPANSION_APPROVAL_QUALITY_MISMATCH", "EXPANSION_APPROVAL_RECORD_INVALID",
      "EXPANSION_APPROVAL_RECORD_INVALIDATED", "EXPANSION_APPROVAL_RESOURCE_MISMATCH",
      "EXPANSION_APPROVAL_REVISION_MISMATCH", "EXPANSION_APPROVAL_SCOPE_MISMATCH",
      "EXPANSION_APPROVAL_SUPERSESSION_CHANGED", "EXPANSION_APPROVAL_SUPERSESSION_MISMATCH",
    ]);
    expect(EXPANSION_APPROVAL_LAYERS).toEqual([
      "ACTOR", "BINDING", "DEADLINE", "IDENTITY", "INPUT", "LIFECYCLE", "POLICY",
      "SUPERSESSION_KERNEL",
    ]);
    expect(EXPANSION_APPROVAL_COMPONENTS).toEqual([
      "APPROVAL_COMMAND", "APPROVAL_VALIDATION", "EXPANSION_APPROVAL", "EXPANSION_PREPARATION",
      "POLICY_EVALUATION", "SUPERSESSION_ENGINE",
    ]);
  });
});

describe("expansion manual approval", () => {
  it("binds one human decision to the exact stored preparation identity", () => {
    const request = approvalRequest();
    const result = approveExpansionManually(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result).sort()).toEqual(["binding", "ok"]);
    expect(Object.keys(result.binding).sort()).toEqual([
      "approvalRef", "decidedApproval", "identity", "preparationIdentity",
    ]);
    expect(result.binding.preparationIdentity).toBe(request["preparation"].identity);
    expect(result.binding.approvalRef).toBe("approval-1");
    expect(result.binding.decidedApproval.decision).toBe("APPROVE");
    expect(result.binding.decidedApproval.lifecycle).toBe("DECIDED");
    expect(result.binding.identity).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts a duplicate byte-identical replay with a byte-identical result", () => {
    const first = approveExpansionManually(approvalRequest());
    const second = approveExpansionManually(approvalRequest());
    expect(second).toEqual(first);
  });

  it("moves the approval identity when the prepared identity moves", () => {
    const first = approveExpansionManually(approvalRequest());
    const moved = approvalRequest();
    const shifted = clone(preparationInput()) as Record<string, any>;
    shifted["deadlineEpochMs"] = 1_700_000_900_000;
    moved["preparation"] = clone(preparedFrom(shifted));
    moved["claim"] = clone(claimFor(moved["preparation"]));
    const second = approveExpansionManually(moved);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.binding.identity).not.toBe(first.binding.identity);
  });

  it("deep-freezes the approved binding and mints no execution authority", () => {
    const result = approveExpansionManually(approvalRequest());
    expect(deeplyFrozen(result)).toBe(true);
    const keys = mintedKeys(result);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => AUTHORITY_PATTERN.test(key))).toEqual([]);
  });
});

describe("expansion manual approval is manual only", () => {
  const allowInput = (): Record<string, any> => {
    const input = clone(preparationInput()) as Record<string, any>;
    input["policy"] = allowPolicyInput();
    input["criteria"].riskTier = "R1";
    return input;
  };
  const systemRecord = (): Record<string, unknown> => ({
    ...humanApproval(), actor: `policy:${hex("d")}`, actorKind: "SYSTEM_POLICY",
    riskTier: "R1", stepUpAuthRef: null, truthClass: "DAEMON_VERIFIED",
  });

  it("prepares a policy ALLOW proposal as eligible for review", () => {
    const result = prepareExpansion(allowInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preparation.bound.policyDecision.decision).toBe("ALLOW");
  });

  it("refuses a system-policy actor on the exact input a human actor approves", () => {
    const preparation = preparedFrom(allowInput());
    const base = {
      claim: claimFor(preparation), command: { ...decideCommand(), stepUpAuthRef: null },
      nowEpochMs: 1_700_000_300_000, preparation,
    };
    expectApprovalRefusal(
      clone({ ...base, approval: systemRecord() }),
      "EXPANSION_APPROVAL_MANUAL_REQUIRED", "ACTOR", "EXPANSION_APPROVAL",
    );
    const human = clone({
      ...base, approval: { ...humanApproval(), riskTier: "R1" }, command: decideCommand(),
    });
    expect(approveExpansionManually(human).ok).toBe(true);
  });

  it("refuses a withdraw command rather than treating it as an approval", () => {
    const request = approvalRequest();
    request["command"] = { kind: "approval.withdraw" };
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_NOT_APPROVED", "LIFECYCLE",
      "EXPANSION_APPROVAL");
  });

  it("refuses a REJECT decision", () => {
    const request = approvalRequest();
    request["command"].decision = "REJECT";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_NOT_APPROVED", "LIFECYCLE",
      "EXPANSION_APPROVAL");
  });
});

describe("expansion manual approval races", () => {
  it("refuses when the budget reservation was released after preparation", () => {
    const request = approvalRequest();
    request["claim"].budgetReservationState = "RELEASED";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_BUDGET_MISMATCH", "BINDING",
      "EXPANSION_APPROVAL");
  });

  it("refuses when the resource reservation was released after preparation", () => {
    const request = approvalRequest();
    request["claim"].resourceReservationState = "RELEASED";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_RESOURCE_MISMATCH", "BINDING",
      "EXPANSION_APPROVAL");
  });

  it("refuses an approval invalidated after preparation", () => {
    const request = approvalRequest();
    request["approval"].validity = "INVALIDATED";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_RECORD_INVALIDATED", "LIFECYCLE",
      "EXPANSION_APPROVAL");
  });

  it("refuses once the prepared deadline has passed", () => {
    const request = approvalRequest();
    request["nowEpochMs"] = request["preparation"].bound.deadlineEpochMs + 1;
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_DEADLINE_EXPIRED", "DEADLINE",
      "EXPANSION_APPROVAL");
  });

  it("approves exactly at the prepared deadline", () => {
    const request = approvalRequest();
    request["nowEpochMs"] = request["preparation"].bound.deadlineEpochMs;
    expect(approveExpansionManually(request).ok).toBe(true);
  });

  it("refuses a claim naming a re-prepared identity", () => {
    const request = approvalRequest();
    const reprepared = clone(preparationInput()) as Record<string, any>;
    reprepared["admitted"].revision = 4;
    request["claim"].preparationIdentity = preparedFrom(reprepared)["identity"];
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_PREPARATION_MISMATCH", "IDENTITY",
      "EXPANSION_APPROVAL");
  });

  it("refuses a stored preparation whose bound facts no longer match its identity", () => {
    const request = approvalRequest();
    request["preparation"].bound.admitted.goalVersion = 99;
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_PREPARATION_STALE", "IDENTITY",
      "EXPANSION_PREPARATION");
  });

  it("refuses when the stored supersession no longer derives the bound authority hash", () => {
    const request = approvalRequest();
    request["preparation"].sources.supersession.successor.revisionId = "revision-9";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_SUPERSESSION_CHANGED",
      "SUPERSESSION_KERNEL", "SUPERSESSION_ENGINE");
  });

  it("refuses when the stored policy input no longer yields the bound decision", () => {
    const request = approvalRequest();
    request["preparation"].sources.policy.decisionDigest = hex("e");
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_POLICY_CHANGED", "POLICY",
      "POLICY_EVALUATION");
  });
});

/** One mismatched byte per bound family DoD 2 enumerates. */
interface ApprovalMismatch {
  readonly apply: (request: Record<string, any>) => void;
  readonly code: string;
  readonly name: string;
}

const MISMATCHES: readonly ApprovalMismatch[] = [
  { name: "approval.approvalRef", code: "EXPANSION_APPROVAL_CRITERIA_MISMATCH",
    apply: (request) => { request["approval"].approvalRef = "approval-2"; } },
  { name: "approval.criteriaRef", code: "EXPANSION_APPROVAL_CRITERIA_MISMATCH",
    apply: (request) => { request["approval"].criteriaRef = hex("6"); } },
  { name: "approval.riskTier", code: "EXPANSION_APPROVAL_CRITERIA_MISMATCH",
    apply: (request) => { request["approval"].riskTier = "R3"; } },
  { name: "approval.budgetRef", code: "EXPANSION_APPROVAL_BUDGET_MISMATCH",
    apply: (request) => { request["approval"].budgetRef = hex("6"); } },
  { name: "approval.approvedNodeScope", code: "EXPANSION_APPROVAL_SCOPE_MISMATCH",
    apply: (request) => { request["approval"].approvedNodeScope = ["child-a"]; } },
  { name: "approval.planQualityAssessmentRef", code: "EXPANSION_APPROVAL_QUALITY_MISMATCH",
    apply: (request) => { request["approval"].planQualityAssessmentRef = hex("7"); } },
  { name: "approval.dependencyChanges", code: "EXPANSION_APPROVAL_DEPENDENCY_MISMATCH",
    apply: (request) => { request["approval"].dependencyChanges.removals = ["dependency-z"]; } },
  { name: "approval.applicablePolicyRef", code: "EXPANSION_APPROVAL_POLICY_MISMATCH",
    apply: (request) => { request["approval"].applicablePolicyRef = hex("0"); } },
  { name: "approval.policyDecisionRef", code: "EXPANSION_APPROVAL_POLICY_MISMATCH",
    apply: (request) => { request["approval"].policyDecisionRef = hex("0"); } },
  { name: "approval.exactRevisionHash", code: "EXPANSION_APPROVAL_REVISION_MISMATCH",
    apply: (request) => { request["approval"].exactRevisionHash = hex("9"); } },
  { name: "claim.budgetReservationId", code: "EXPANSION_APPROVAL_BUDGET_MISMATCH",
    apply: (request) => { request["claim"].budgetReservationId = "budget-reservation-2"; } },
  { name: "claim.resourceEpoch", code: "EXPANSION_APPROVAL_RESOURCE_MISMATCH",
    apply: (request) => { request["claim"].resourceEpoch = 6; } },
  { name: "claim.resourceIds", code: "EXPANSION_APPROVAL_RESOURCE_MISMATCH",
    apply: (request) => { request["claim"].resourceIds = ["resource-2"]; } },
  { name: "claim.supersessionAuthorityHash",
    code: "EXPANSION_APPROVAL_SUPERSESSION_MISMATCH",
    apply: (request) => { request["claim"].supersessionAuthorityHash = hex("3"); } },
];

/** Hand-written so a shrunken table cannot pass by emitting fewer cases. */
const MISMATCH_NAMES: readonly string[] = [
  "approval.approvalRef", "approval.criteriaRef", "approval.riskTier", "approval.budgetRef",
  "approval.approvedNodeScope", "approval.planQualityAssessmentRef",
  "approval.dependencyChanges", "approval.applicablePolicyRef", "approval.policyDecisionRef",
  "approval.exactRevisionHash", "claim.budgetReservationId", "claim.resourceEpoch",
  "claim.resourceIds", "claim.supersessionAuthorityHash",
];

describe("expansion manual approval byte matching", () => {
  it("generates one case per enumerated approval byte", () => {
    expect(MISMATCHES.map((entry) => entry.name)).toEqual(MISMATCH_NAMES);
    expect(MISMATCHES.length).toBe(14);
  });

  it.each(MISMATCHES)("refuses when $name does not match the stored identity",
    ({ apply, code }) => {
      const request = approvalRequest();
      apply(request);
      expectApprovalRefusal(request, code, "BINDING", "EXPANSION_APPROVAL");
    });
});

describe("expansion manual approval input refusals", () => {
  it("refuses a request missing a member", () => {
    const request = approvalRequest();
    delete request["claim"];
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_INPUT_INVALID", "INPUT",
      "EXPANSION_APPROVAL");
  });

  it("refuses a request carrying an extra member", () => {
    const request = approvalRequest();
    request["childRunRef"] = "run-1";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_INPUT_INVALID", "INPUT",
      "EXPANSION_APPROVAL");
  });

  it("delegates a structurally invalid approval record to the approval validator", () => {
    const request = approvalRequest();
    request["approval"].actor = "";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_RECORD_INVALID", "INPUT",
      "APPROVAL_VALIDATION");
  });

  it("delegates an illegal approval transition to the approval command reducer", () => {
    const request = approvalRequest();
    request["approval"].lifecycle = "DECIDED";
    request["approval"].decision = "APPROVE";
    expectApprovalRefusal(request, "EXPANSION_APPROVAL_COMMAND_REFUSED", "LIFECYCLE",
      "APPROVAL_COMMAND");
  });
});
