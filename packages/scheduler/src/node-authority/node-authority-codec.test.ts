import { createHash } from "node:crypto";

import {
  createAcceptanceContract,
  createAcceptanceCriterionContent,
  createPlanExecutionContent,
  createPlanRevision,
  deriveAcceptanceCriterionContent,
  derivePlanExecutionContent,
} from "@moe/core";
import { describe, expect, it } from "vitest";

import { ADMISSION_PURPOSES, type AdmissionAmount } from "../budget/budget-reservation.js";
import { validateDependencyContract } from "../dependencies/dependency-contract.js";
import * as nodeAuthorityContract from "./node-authority-contract.js";
import {
  NODE_AUTHORITY_CODES,
  NODE_AUTHORITY_DIGEST_DOMAIN,
  NODE_AUTHORITY_LIMITS,
  NODE_AUTHORITY_SCHEMA_TAG,
  NODE_AUTHORITY_SCHEMA_VERSION,
  NODE_AUTHORITY_UNDECLARED_SCHEMA_VERSION,
  NODE_DEFINITION_KEYS,
  NODE_JOIN_ROLES,
} from "./node-authority-contract.js";
import {
  admitNodeDefinition,
  createNodeDefinition,
  createNodeDefinitionFromPlanningContent,
  decodeNodeDefinitionBytes,
  draftNodeAuthority,
  encodeNodeDefinition,
} from "./node-authority-codec.js";
import type { NodeAdmissionGatePolicy, NodeAuthorityRefusal } from "./node-authority-contract.js";

const hex = (digit: string): string => digit.repeat(64);
const decoder = new TextDecoder();
const PRIOR_NODE_AUTHORITY_DIGEST_DOMAIN = "MOE-NODE-AUTHORITY-BODY-HASH/1";
const NODE_ADMISSION_METERS_EXPECTED = Object.freeze([
  "attempt.count",
  "provider.cache_creation_input_tokens",
  "provider.cache_read_input_tokens",
  "provider.input_tokens",
  "provider.output_tokens",
  "runner.authorized_ms",
  "verification.authorized_ms",
] as const);
const PURPOSE_ORDER = Object.freeze([...ADMISSION_PURPOSES].sort());

const planDraft = () => ({
  affectedCriterionIds: ["criterion-a"],
  affectedNodeIds: ["node-a"],
  approvalState: "APPROVED",
  authorRef: "principal-a",
  graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null as string | null,
  rejectionRef: null as string | null,
  revisionId: "plan-revision-a",
  steps: [
    { description: "Analyse the node.", kind: "ANALYSIS", stepId: "step-a" },
    { description: "Implement the node.", kind: "IMPLEMENTATION", stepId: "step-b" },
  ],
  verificationRecipeRefs: ["recipe-a", "recipe-b"],
});

const acceptanceDraft = () => ({
  applicability: {
    graphContentHash: hex("a"),
    graphRevisionRef: "graph-revision-a",
    nodeIds: ["node-a"],
    nodeKind: "LEAF",
  },
  authorRef: "principal-a",
  contractId: "acceptance-contract-a",
  obligations: [{
    criterionId: "criterion-a",
    evidenceRequirements: [
      { evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" },
    ],
    statement: "The node ships its focused verification.",
    verificationRecipeRefs: ["recipe-a"],
  }],
});

const planContent = () => {
  const draft = planDraft();
  const result = createPlanExecutionContent({
    affectedCriterionIds: draft.affectedCriterionIds,
    affectedNodeIds: draft.affectedNodeIds,
    steps: draft.steps,
    verificationRecipeRefs: draft.verificationRecipeRefs,
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.content;
};

const criterionContent = () => {
  const draft = acceptanceDraft();
  const result = createAcceptanceCriterionContent({
    nodeKind: draft.applicability.nodeKind, obligations: draft.obligations,
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.content;
};

const registryEntry = () => ({
  parameterSchema: { digest: hex("b"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-a",
  proofRationale: "An artifact seal cannot become unsealed.",
  schemaId: "schema-a",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
});

const dependencyContract = () => ({
  alternateProducers: [] as string[],
  alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
  consumer: { contractHash: hex("c"), criterionRef: "criterion-a", kind: "PRECONDITION" },
  consumptionHorizon: "RESULT_SEAL",
  edgeKind: "ARTIFACT_CONSUMPTION",
  graphBindingDigest: hex("d"),
  invalidationFacts: [
    { sourceFactDigest: hex("e"), sourceFactRef: "fact-a", sourceFactVersion: 1 },
  ],
  minimumQualifyingMilestone: "RESULT_SEALED",
  necessity: {
    failedConsumerCriterionRef: "criterion-a",
    failureKind: "MISSING_ARTIFACT",
    truthClass: "OBSERVED",
  },
  producer: {
    artifactOrInterfaceRef: "artifact-a",
    digest: hex("f"),
    kind: "ARTIFACT_CONSUMPTION",
  },
  producerNodeKey: "node-producer",
  consumerNodeKey: "node-a",
  recheckPredicateRef: "predicate-a",
  satisfactionPredicate: {
    parametersDigest: hex("1"),
    predicateRef: "predicate-a",
    schemaId: "schema-a",
    schemaVersion: 1,
  },
  satisfactionWitnesses: [{
    sourceOperationClass: "ARTIFACT_SEAL",
    witnessDigest: hex("2"),
    witnessRef: "witness-a",
    witnessVersion: 1,
  }],
  stability: "MONOTONIC",
  truthClass: "OBSERVED",
});

const requirement = () => ({
  contract: dependencyContract(),
  edgeKind: "ARTIFACT_CONSUMPTION",
});

const authorityDraft = () => ({
  admissionAmounts: admissionAmounts(),
  admissionGatePolicy: "POLICY_ALLOWANCE" as NodeAdmissionGatePolicy,
  capability: "capability-implement",
  completionLinkage: null as string | null,
  constraints: ["constraint-a", "constraint-b"],
  directHardDependencies: [{ edgeKey: "edge-a", requirement: requirement() }],
  joinRole: "NONE",
  nodeKey: "node-a",
  objective: "Land the canonical node authority body.",
  policySliceHash: hex("3"),
  readScopes: ["services\\api\\src", "services/api/docs"],
  repositoryBaseTree: hex("4"),
  resources: ["resource-a"],
  verificationRecipeRevisions: ["recipe-a"],
  writeScopes: ["services/api/src/node"],
});

const admissionAmounts = (
  meter: string = "runner.authorized_ms",
): AdmissionAmount[] => PURPOSE_ORDER.map((purpose, index) => ({
  purpose, meter, quantity: index + 1,
}));

const typedAuthorityDraft = (): Record<string, unknown> => {
  return authorityDraft() as unknown as Record<string, unknown>;
};

const typedInput = (draft: Record<string, unknown> = typedAuthorityDraft()) =>
  createInput({ draft });

type AuthorityDraft = ReturnType<typeof authorityDraft>;
type PlanDraft = ReturnType<typeof planDraft>;
type AcceptanceDraft = ReturnType<typeof acceptanceDraft>;

function planOrThrow(draft: PlanDraft = planDraft()): unknown {
  const result = createPlanRevision(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function acceptanceOrThrow(draft: AcceptanceDraft = acceptanceDraft()): unknown {
  const result = createAcceptanceContract(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.contract;
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  acceptanceContract: acceptanceOrThrow(),
  draft: authorityDraft(),
  planRevision: planOrThrow(),
  predicateRegistry: [registryEntry()],
  ...overrides,
});

const withDraft = (change: (draft: AuthorityDraft) => void): Record<string, unknown> => {
  const draft = authorityDraft();
  change(draft);
  return createInput({ draft });
};

/**
 * A fresh mint that DECLARES, and therefore the only kind minted at the CURRENT
 * schema version. Fixtures needing v3 framing must go through this: an undeclared
 * mint is v2 by policy, so `createInput()` no longer exercises the current tag.
 */
const declaringInput = (declared: readonly string[] = ["migration-a"]) =>
  withDraft((draft) => {
    (draft as unknown as Record<string, unknown>)["declaredMigrations"] = [...declared];
  });

function acceptedOrThrow(input: unknown = createInput()) {
  const result = createNodeDefinition(input);
  if (!result.ok) throw new Error(result.issues.map((i) => `${i.code}@${i.layer}`).join(","));
  return result.value;
}

function bytesOrThrow(input: unknown = createInput()): Uint8Array {
  const result = encodeNodeDefinition(acceptedOrThrow(input).definition);
  if (!result.ok) throw new Error(result.issues.map((i) => `${i.code}@${i.layer}`).join(","));
  return result.bytes;
}

type Refusable = { readonly ok: true } | NodeAuthorityRefusal;

function expectRefusal(result: Refusable, code: string, layer: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => `${issue.code}@${issue.layer}`)).toContain(`${code}@${layer}`);
}

function everyValueFrozen(value: unknown, path = "$"): readonly string[] {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return [];
  const unfrozen = Object.isFrozen(value) ? [] : [path];
  return Object.entries(value as Record<string, unknown>).reduce<readonly string[]>(
    (found, [key, nested]) => [...found, ...everyValueFrozen(nested, `${path}.${key}`)],
    unfrozen,
  );
}

describe("node authority admission", () => {
  it("creates byte-identical authority from aligned graph-independent planning content", () => {
    const contentResult = createNodeDefinitionFromPlanningContent({
      acceptanceCriterionContent: criterionContent(),
      draft: authorityDraft(),
      planExecutionContent: planContent(),
      predicateRegistry: [registryEntry()],
    });
    expect(contentResult.ok).toBe(true);
    if (!contentResult.ok) return;
    const finalResult = acceptedOrThrow();
    expect(contentResult.value.definition).toStrictEqual(finalResult.definition);
    expect(contentResult.value.bytes).toStrictEqual(finalResult.bytes);
    expect(Object.keys(planContent())).not.toContain("planExecutionContentDigest");
    expect(Object.keys(planContent())).not.toContain("graphBinding");
    expect(Object.keys(criterionContent())).not.toContain("criteria");
    expect(Object.keys(criterionContent())).not.toContain("applicability");

    const extraApplicability = acceptanceDraft();
    extraApplicability.applicability = {
      ...extraApplicability.applicability, nodeIds: ["node-a", "node-z"],
    };
    const withUnrelatedNode = acceptedOrThrow(createInput({
      acceptanceContract: acceptanceOrThrow(extraApplicability),
    }));
    expect(withUnrelatedNode.bytes).toStrictEqual(finalResult.bytes);
  });

  it("requires the final node key in both planning applicability sources", () => {
    const planWithoutNode = planDraft();
    planWithoutNode.affectedNodeIds = ["node-b"];
    expectRefusal(createNodeDefinition(createInput({
      planRevision: planOrThrow(planWithoutNode),
    })), "NODE_AUTHORITY_APPLICABILITY_MISMATCH", "NODE_AUTHORITY_ADMISSION");

    const contractWithoutNode = acceptanceDraft();
    contractWithoutNode.applicability = {
      ...contractWithoutNode.applicability, nodeIds: ["node-b"],
    };
    expectRefusal(createNodeDefinition(createInput({
      acceptanceContract: acceptanceOrThrow(contractWithoutNode),
    })), "NODE_AUTHORITY_APPLICABILITY_MISMATCH", "NODE_AUTHORITY_ADMISSION");
  });

  it("refuses caller-stated content digests instead of trusting them", () => {
    expectRefusal(createNodeDefinitionFromPlanningContent({
      acceptanceCriterionContent: criterionContent(), draft: authorityDraft(),
      planExecutionContent: { ...planContent(), planExecutionContentDigest: hex("9") },
      predicateRegistry: [registryEntry()],
    }), "PLAN_REVISION_MALFORMED", "PLANNING_SOURCE");
    expectRefusal(createNodeDefinitionFromPlanningContent({
      acceptanceCriterionContent: { ...criterionContent(), criteria: [{
        contentDigest: hex("8"), criterionId: "criterion-a",
      }] },
      draft: authorityDraft(), planExecutionContent: planContent(),
      predicateRegistry: [registryEntry()],
    }), "ACCEPTANCE_CONTRACT_MALFORMED", "PLANNING_SOURCE");
  });
  it("covers every nonrecursive design-255 field with a closed, versioned roster", () => {
    const { definition } = acceptedOrThrow();
    // `declaredMigrations` is the one OPTIONAL roster member: absent here because
    // this fixture declares nothing, and absence is UNKNOWN, not an empty list.
    expect(Object.keys(definition).sort())
      .toEqual(NODE_DEFINITION_KEYS.filter((key) => key !== "declaredMigrations"));
    expect(NODE_DEFINITION_KEYS.length).toBeGreaterThanOrEqual(18);
    expect(NODE_DEFINITION_KEYS).toContain("declaredMigrations");
    // The UNDECLARED version, not the current one: this fixture declares nothing,
    // so promoting it would move its identity for a member it does not carry.
    expect(definition.schemaVersion).toBe(NODE_AUTHORITY_UNDECLARED_SCHEMA_VERSION);
    expect(definition.objective).toBe("Land the canonical node authority body.");
    expect(definition.capability).toBe("capability-implement");
    expect(definition.constraints).toEqual(["constraint-a", "constraint-b"]);
    expect(definition.resources).toEqual(["resource-a"]);
    expect(definition.admissionAmounts).toEqual(admissionAmounts());
    expect(definition.admissionGatePolicy).toBe("POLICY_ALLOWANCE");
    expect(definition.repositoryBaseTree).toBe(hex("4"));
    expect(definition.policySliceHash).toBe(hex("3"));
    expect(definition.verificationRecipeRevisions).toEqual(["recipe-a"]);
    expect(definition.nodeKey).toBe("node-a");
  });

  it("closes the join role vocabulary and pins completion linkage to it", () => {
    expect([...NODE_JOIN_ROLES]).toEqual(["COMPLETION", "JOIN", "NONE"]);
    const { definition } = acceptedOrThrow();
    expect(definition.joinRole).toBe("NONE");
    expect(definition.completionLinkage).toBeNull();
    const joined = acceptedOrThrow(withDraft((draft) => {
      draft.joinRole = "COMPLETION";
      draft.completionLinkage = "node-a";
    }));
    expect(joined.definition.completionLinkage).toBe("node-a");
    expectRefusal(
      createNodeDefinition(withDraft((draft) => { draft.joinRole = "COMPLETION"; })),
      "NODE_AUTHORITY_JOIN_LINKAGE_INVALID", "NODE_AUTHORITY_ADMISSION",
    );
    expectRefusal(
      createNodeDefinition(withDraft((draft) => { draft.joinRole = "ORCHESTRATE"; })),
      "NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION",
    );
  });

  it("binds the criterion roster the core derivation produces, never a local recomputation", () => {
    const contract = acceptanceOrThrow();
    const derived = deriveAcceptanceCriterionContent(contract);
    if (!derived.ok) throw new Error(`${derived.code}@${derived.layer}`);
    expect(derived.criteria.length).toBeGreaterThan(0);
    const { definition } = acceptedOrThrow(createInput({ acceptanceContract: contract }));
    expect(definition.criterionBindings).toEqual(derived.criteria);
  });

  it("binds the plan-execution digest the core derivation produces", () => {
    const revision = planOrThrow();
    const derived = derivePlanExecutionContent(revision);
    if (!derived.ok) throw new Error(`${derived.code}@${derived.layer}`);
    const { definition } = acceptedOrThrow(createInput({ planRevision: revision }));
    expect(definition.planExecutionContentDigest).toBe(derived.digest);
  });

  it("persists exactly the normalized contract the production validator returns", () => {
    const validated = validateDependencyContract(requirement(), [registryEntry()]);
    if (!validated.ok || validated.graphEdgeKind !== "HARD") throw new Error("control refused");
    const { definition } = acceptedOrThrow();
    expect(definition.directHardDependencies).toHaveLength(1);
    const stored = definition.directHardDependencies[0]!;
    expect(stored.edgeKey).toBe("edge-a");
    expect(JSON.stringify(stored.contract)).toBe(JSON.stringify(validated.contract));
    expect(stored.contract.stability).toBe("MONOTONIC");
  });

  it("normalizes scope separators to `/` without folding case", () => {
    const { definition } = acceptedOrThrow();
    expect(definition.readScopes).toEqual(["services/api/docs", "services/api/src"]);
    expect(definition.writeScopes).toEqual(["services/api/src/node"]);
    const cased = acceptedOrThrow(withDraft((draft) => {
      draft.readScopes = ["services/API/src", "services/api/src"];
    }));
    expect(cased.definition.readScopes).toEqual(["services/API/src", "services/api/src"]);
    for (const hostile of ["../escape", "/absolute", "C:/drive", "services/../../escape", ""]) {
      expectRefusal(
        createNodeDefinition(withDraft((draft) => { draft.readScopes = [hostile]; })),
        "NODE_AUTHORITY_SCOPE_INVALID", "NODE_AUTHORITY_SCOPES",
      );
    }
  });

  it("returns a deeply frozen, detached body carrying no execution affordance", () => {
    const accepted = acceptedOrThrow();
    expect(everyValueFrozen(accepted.definition)).toEqual([]);
    expect(Object.isFrozen(accepted)).toBe(true);
    const callable = Object.values(accepted.definition).filter((v) => typeof v === "function");
    expect(callable).toEqual([]);
    const first = bytesOrThrow(declaringInput());
    first.fill(0);
    expect(decoder.decode(bytesOrThrow(declaringInput()))).toContain(NODE_AUTHORITY_SCHEMA_TAG);
  });

  it("admits its own accepted definition back through the production reader", () => {
    const { definition } = acceptedOrThrow();
    const readmitted = admitNodeDefinition(definition);
    expect(readmitted.ok).toBe(true);
    if (!readmitted.ok) return;
    expect(readmitted.value.definition).toEqual(definition);
  });

  it("drafts caller-stated fields without deriving any planning identity", () => {
    const drafted = draftNodeAuthority(authorityDraft());
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    expect(Object.keys(drafted.draft)).not.toContain("criterionBindings");
    expect(Object.keys(drafted.draft)).not.toContain("planExecutionContentDigest");
    expect(drafted.draft.readScopes).toEqual(["services/api/docs", "services/api/src"]);
  });
});

function expectTypedAcceptance(input: unknown): ReturnType<typeof createNodeDefinition> | null {
  const result = createNodeDefinition(input);
  expect(result.ok).toBe(true);
  return result.ok ? result : null;
}

function amountsOf(definition: unknown): readonly AdmissionAmount[] {
  return (definition as Record<string, unknown>)["admissionAmounts"] as readonly AdmissionAmount[];
}

describe("typed budget authority", () => {
  it("closes the authority-side meter and gate-policy vocabularies", () => {
    const surface = nodeAuthorityContract as unknown as Record<string, unknown>;
    expect(surface["NODE_ADMISSION_METERS"]).toEqual(NODE_ADMISSION_METERS_EXPECTED);
    expect(surface["NODE_ADMISSION_GATE_POLICIES"])
      .toEqual(["HUMAN_APPROVAL", "POLICY_ALLOWANCE"]);
    expect(surface["NODE_ADMISSION_GATE_POLICY_WITNESS"]).toEqual({
      HUMAN_APPROVAL: "approval", POLICY_ALLOWANCE: "allowance",
    });
  });

  it("rotates the schema and digest domain for the typed authority body", () => {
    expect(NODE_AUTHORITY_SCHEMA_VERSION).toBe(3);
    expect(NODE_AUTHORITY_SCHEMA_TAG).toBe("MOE-NODE-AUTHORITY/3");
    expect(NODE_AUTHORITY_DIGEST_DOMAIN).toBe("MOE-NODE-AUTHORITY-BODY-HASH/3");
    // The SUPERSEDED pair is pinned too, and never rotated: a stored schema-2 body
    // frames and digests under these exact literals for as long as one exists.
    expect(new Set([
      NODE_AUTHORITY_SCHEMA_TAG,
      PRIOR_NODE_AUTHORITY_DIGEST_DOMAIN,
      NODE_AUTHORITY_DIGEST_DOMAIN,
      "MOE-NODE-AUTHORITY/2",
      "MOE-NODE-AUTHORITY-BODY-HASH/2",
    ]).size).toBe(5);
  });

  it("round-trips a deeply frozen five-purpose budget on one meter", () => {
    expect(PURPOSE_ORDER).toEqual([
      "CONTINGENCY", "EXECUTION", "FINAL_ACCEPTANCE", "INDEPENDENT_REVIEW", "VERIFICATION",
    ]);
    expect(admissionAmounts()).toHaveLength(5);
    const accepted = expectTypedAcceptance(typedInput());
    if (accepted === null || !accepted.ok) return;
    const { definition } = accepted.value;
    expect(amountsOf(definition)).toEqual(admissionAmounts());
    expect((definition as unknown as Record<string, unknown>)["admissionGatePolicy"])
      .toBe("POLICY_ALLOWANCE");
    expect(everyValueFrozen(definition)).toEqual([]);
    const encoded = encodeNodeDefinition(definition);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeNodeDefinitionBytes(encoded.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.definition).toEqual(definition);
  });

  it("retires the legacy scalar with its own budget-layer reason", () => {
    const draft = typedAuthorityDraft();
    draft["budgetRequest"] = 3;
    expect(NODE_DEFINITION_KEYS).not.toContain("budgetRequest");
    expectRefusal(
      createNodeDefinition(typedInput(draft)),
      "NODE_AUTHORITY_BUDGET_LEGACY_SCALAR", "NODE_AUTHORITY_BUDGET",
    );
  });

  it("sorts admission amounts by the canonical purpose-meter pair", () => {
    const draft = typedAuthorityDraft();
    draft["admissionAmounts"] = [
      ...admissionAmounts(),
      { purpose: "EXECUTION", meter: "provider.output_tokens", quantity: 9 },
      { purpose: "EXECUTION", meter: "attempt.count", quantity: 8 },
    ].reverse();
    const accepted = expectTypedAcceptance(typedInput(draft));
    if (accepted === null || !accepted.ok) return;
    expect(amountsOf(accepted.value.definition).map((amount) => `${amount.purpose}:${amount.meter}`))
      .toEqual([
        "CONTINGENCY:runner.authorized_ms",
        "EXECUTION:attempt.count",
        "EXECUTION:provider.output_tokens",
        "EXECUTION:runner.authorized_ms",
        "FINAL_ACCEPTANCE:runner.authorized_ms",
        "INDEPENDENT_REVIEW:runner.authorized_ms",
        "VERIFICATION:runner.authorized_ms",
      ]);
  });

  it("moves the digest for quantity, meter, purpose, and gate-policy changes", () => {
    const changes: readonly (readonly [
      string, () => readonly [Record<string, unknown>, Record<string, unknown>],
    ])[] = [
      ["quantity", () => {
        const control = typedAuthorityDraft();
        const changed = typedAuthorityDraft();
        const amounts = admissionAmounts();
        amounts[0] = { ...amounts[0]!, quantity: amounts[0]!.quantity + 1 };
        changed["admissionAmounts"] = amounts;
        return [control, changed];
      }],
      ["meter", () => {
        const control = typedAuthorityDraft();
        const changed = typedAuthorityDraft();
        const amounts = admissionAmounts();
        amounts[0] = { ...amounts[0]!, meter: "provider.input_tokens" };
        changed["admissionAmounts"] = amounts;
        return [control, changed];
      }],
      ["purpose", () => {
        const before = admissionAmounts();
        before[0] = { ...before[0]!, meter: "provider.input_tokens" };
        const after = before.map((amount) => ({ ...amount }));
        after[0] = { ...after[0]!, purpose: "EXECUTION" };
        const control = typedAuthorityDraft();
        control["admissionAmounts"] = before;
        const changed = typedAuthorityDraft();
        changed["admissionAmounts"] = after;
        return [control, changed];
      }],
      ["gate policy", () => {
        const control = typedAuthorityDraft();
        const changed = typedAuthorityDraft();
        changed["admissionGatePolicy"] = "HUMAN_APPROVAL";
        return [control, changed];
      }],
    ];
    expect(changes).toHaveLength(4);
    let swept = 0;
    for (const [name, build] of changes) {
      swept += 1;
      const [before, after] = build();
      const control = expectTypedAcceptance(typedInput(before));
      const changed = expectTypedAcceptance(typedInput(after));
      if (control === null || changed === null || !control.ok || !changed.ok) continue;
      expect(`${name}:${changed.value.bodyContentDigest}`)
        .not.toBe(`${name}:${control.value.bodyContentDigest}`);
    }
    expect(swept).toBe(changes.length);
  });

  it("keeps excluded planning fields byte-identical with typed budgets", () => {
    const otherPlan = planDraft();
    otherPlan.approvalState = "PENDING_APPROVAL";
    otherPlan.authorRef = "principal-z";
    otherPlan.revisionId = "plan-revision-z";
    const left = expectTypedAcceptance(typedInput());
    const right = expectTypedAcceptance(createInput({
      draft: typedAuthorityDraft(), planRevision: planOrThrow(otherPlan),
    }));
    if (left === null || right === null || !left.ok || !right.ok) return;
    expect(decoder.decode(right.value.bytes)).toBe(decoder.decode(left.value.bytes));
  });

  it("refuses an unknown meter with the exact budget-layer reason", () => {
    const draft = typedAuthorityDraft();
    draft["admissionAmounts"] = admissionAmounts("speculative.meter");
    expectRefusal(
      createNodeDefinition(typedInput(draft)),
      "NODE_AUTHORITY_BUDGET_METER_UNKNOWN", "NODE_AUTHORITY_BUDGET",
    );
  });

  it("accepts every unique purpose-meter pair at the bound and refuses one over", () => {
    const maximum = PURPOSE_ORDER.flatMap((purpose) =>
      NODE_ADMISSION_METERS_EXPECTED.map((meter, index) => ({
        purpose, meter, quantity: index + 1,
      })));
    expect(maximum).toHaveLength(35);
    expect((NODE_AUTHORITY_LIMITS as Record<string, number>)["maxAdmissionAmounts"]).toBe(35);
    const atLimit = typedAuthorityDraft();
    atLimit["admissionAmounts"] = maximum;
    expectTypedAcceptance(typedInput(atLimit));
    const over = typedAuthorityDraft();
    over["admissionAmounts"] = [...maximum, maximum[0]];
    expectRefusal(
      createNodeDefinition(typedInput(over)),
      "NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
    );
  });

  it("refuses a duplicate purpose-meter pair but accepts shared meters across purposes", () => {
    expectTypedAcceptance(typedInput());
    const duplicate = typedAuthorityDraft();
    const amounts = admissionAmounts();
    duplicate["admissionAmounts"] = [...amounts, { ...amounts[0]!, quantity: 99 }];
    expectRefusal(
      createNodeDefinition(typedInput(duplicate)),
      "NODE_AUTHORITY_BUDGET_DUPLICATE_PAIR", "NODE_AUTHORITY_BUDGET",
    );
  });

  it("refuses a pre-granted gate witness instead of persisting minted authority", () => {
    const draft = typedAuthorityDraft();
    draft["admissionGate"] = {
      allowance: null,
      approval: { approvalRef: "approval-a", decision: "APPROVE", validity: "CURRENT" },
    };
    expectRefusal(
      createNodeDefinition(typedInput(draft)),
      "NODE_AUTHORITY_BUDGET_GATE_WITNESS_FORBIDDEN", "NODE_AUTHORITY_BUDGET",
    );
  });

  it("refuses malformed amounts and gate policies with exact budget-layer reasons", () => {
    const hostile: readonly (readonly [string, unknown, string])[] = [
      ["zero quantity", [{ purpose: "EXECUTION", meter: "attempt.count", quantity: 0 }],
        "NODE_AUTHORITY_BUDGET_AMOUNT_INVALID"],
      ["unknown purpose", [{ purpose: "SIDE_QUEST", meter: "attempt.count", quantity: 1 }],
        "NODE_AUTHORITY_BUDGET_AMOUNT_INVALID"],
      ["extra amount field", [{ purpose: "EXECUTION", meter: "attempt.count", quantity: 1, unit: "ms" }],
        "NODE_AUTHORITY_BUDGET_AMOUNT_INVALID"],
      ["non-array", { purpose: "EXECUTION", meter: "attempt.count", quantity: 1 },
        "NODE_AUTHORITY_BUDGET_AMOUNT_INVALID"],
    ];
    expect(hostile).toHaveLength(4);
    let swept = 0;
    for (const [, amounts, code] of hostile) {
      swept += 1;
      const draft = typedAuthorityDraft();
      draft["admissionAmounts"] = amounts;
      expectRefusal(createNodeDefinition(typedInput(draft)), code, "NODE_AUTHORITY_BUDGET");
    }
    expect(swept).toBe(hostile.length);
    const gate = typedAuthorityDraft();
    gate["admissionGatePolicy"] = "EMBEDDED_APPROVAL";
    expectRefusal(
      createNodeDefinition(typedInput(gate)),
      "NODE_AUTHORITY_BUDGET_GATE_POLICY_INVALID", "NODE_AUTHORITY_BUDGET",
    );
  });
});

const FORBIDDEN_DIGEST_FIELDS: readonly (readonly [string, unknown])[] = Object.freeze([
  ["criteriaDigest", hex("9")],
  ["graphContentHash", hex("9")],
  ["graphHash", hex("9")],
  ["graphRevisionRef", "graph-revision-a"],
  ["nodeAuthorityHash", hex("9")],
  ["planHash", hex("9")],
  ["predecessorAuthorityHash", hex("9")],
  ["revisionId", "graph-revision-a"],
]);

const EXCLUDED_STATE_FIELDS: readonly (readonly [string, unknown])[] = Object.freeze([
  ["attemptState", "RUNNING"],
  ["inputBindingHash", hex("9")],
  ["lease", "lease-a"],
  ["lifecycle", "ACTIVE"],
  ["outgoingConsumers", ["node-z"]],
  ["result", "RESULT_SEALED"],
  ["selectedWitnesses", ["witness-a"]],
  ["status", "READY"],
  ["workspace", "workspace-a"],
]);

describe("caller-supplied identity authority", () => {
  it("refuses every enumerated digest, hash and revision id a caller could state", () => {
    expect(FORBIDDEN_DIGEST_FIELDS.length).toBeGreaterThanOrEqual(8);
    let swept = 0;
    for (const [field, value] of FORBIDDEN_DIGEST_FIELDS) {
      swept += 1;
      expectRefusal(
        createNodeDefinition(withDraft((draft) => {
          (draft as unknown as Record<string, unknown>)[field] = value;
        })),
        "NODE_AUTHORITY_CALLER_DIGEST_FORBIDDEN", "NODE_AUTHORITY_ADMISSION",
      );
      expectRefusal(
        draftNodeAuthority({ ...authorityDraft(), [field]: value }),
        "NODE_AUTHORITY_CALLER_DIGEST_FORBIDDEN", "NODE_AUTHORITY_ADMISSION",
      );
    }
    expect(swept).toBe(FORBIDDEN_DIGEST_FIELDS.length);
  });

  it("refuses every excluded lifecycle, workspace, result and consumer field", () => {
    expect(EXCLUDED_STATE_FIELDS.length).toBeGreaterThanOrEqual(9);
    let swept = 0;
    for (const [field, value] of EXCLUDED_STATE_FIELDS) {
      swept += 1;
      expectRefusal(
        draftNodeAuthority({ ...authorityDraft(), [field]: value }),
        "NODE_AUTHORITY_EXCLUDED_FIELD", "NODE_AUTHORITY_ADMISSION",
      );
    }
    expect(swept).toBe(EXCLUDED_STATE_FIELDS.length);
  });

  it("answers a stated digest with its own code even at the creation boundary", () => {
    expectRefusal(
      createNodeDefinition({ ...createInput(), nodeAuthorityHash: hex("9") }),
      "NODE_AUTHORITY_CALLER_DIGEST_FORBIDDEN", "NODE_AUTHORITY_ADMISSION",
    );
  });

  it("refuses an unrecognised extra field as malformed rather than ignoring it", () => {
    expectRefusal(
      draftNodeAuthority({ ...authorityDraft(), presentationLabel: "Node A" }),
      "NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
    );
  });
});

describe("design-255 exclusions", () => {
  it("keeps every excluded name out of the encoded bytes", () => {
    const encoded = decoder.decode(bytesOrThrow());
    for (const [field] of [...FORBIDDEN_DIGEST_FIELDS, ...EXCLUDED_STATE_FIELDS]) {
      expect(encoded).not.toContain(`"${field}"`);
    }
    expect(encoded).not.toContain("plan-revision-a");
    expect(encoded).not.toContain("acceptance-contract-a");
    expect(encoded).not.toContain("graph-revision-a");
  });

  it("encodes byte-identically when only excluded upstream fields differ", () => {
    const otherPlan = planDraft();
    otherPlan.approvalState = "PENDING_APPROVAL";
    otherPlan.authorRef = "principal-z";
    otherPlan.graphBinding = { graphContentHash: hex("7"), graphRevisionRef: "graph-revision-z" };
    otherPlan.parentRevisionId = "plan-revision-parent";
    otherPlan.rejectionRef = "rejection-z";
    otherPlan.revisionId = "plan-revision-z";
    const otherAcceptance = acceptanceDraft();
    otherAcceptance.applicability = {
      graphContentHash: hex("7"),
      graphRevisionRef: "graph-revision-z",
      nodeIds: ["node-a", "node-z"],
      nodeKind: "LEAF",
    };
    otherAcceptance.authorRef = "principal-z";
    otherAcceptance.contractId = "acceptance-contract-z";
    const shifted = bytesOrThrow(createInput({
      acceptanceContract: acceptanceOrThrow(otherAcceptance),
      planRevision: planOrThrow(otherPlan),
    }));
    expect(decoder.decode(shifted)).toBe(decoder.decode(bytesOrThrow()));
  });
});

describe("monotonic predicate proofs", () => {
  it("persists the exact registry proof a monotonic entry matched", () => {
    const { definition } = acceptedOrThrow();
    expect(definition.monotonicPredicateProofs).toEqual([registryEntry()]);
  });

  it("refuses a monotonic entry whose proof is absent instead of demoting it", () => {
    const result = createNodeDefinition(createInput({ predicateRegistry: [] }));
    expectRefusal(result, "NODE_AUTHORITY_MONOTONIC_PROOF_MISSING", "NODE_AUTHORITY_PROOFS");
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).not.toContain("NODE_AUTHORITY_MALFORMED");
  });

  it("passes the validator's own conflicting-witness code through unchanged", () => {
    const registry = registryEntry();
    registry.sourceOperationClass = "SCOPE_OBSERVATION";
    const direct = validateDependencyContract(requirement(), [registry]);
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.issues.map((issue) => issue.code))
        .toContain("DEPENDENCY_MONOTONIC_OPERATION_MISMATCH");
    }
    expectRefusal(
      createNodeDefinition(createInput({ predicateRegistry: [registry] })),
      "DEPENDENCY_MONOTONIC_OPERATION_MISMATCH", "DEPENDENCY_CONTRACT",
    );
  });

  it("passes the validator's own registry-malformed code through unchanged", () => {
    expectRefusal(
      createNodeDefinition(createInput({ predicateRegistry: [{ predicateRef: "predicate-a" }] })),
      "DEPENDENCY_PREDICATE_REGISTRY_MALFORMED", "DEPENDENCY_CONTRACT",
    );
  });

  it("passes a refused dependency contract's own code through at the dependency layer", () => {
    expectRefusal(
      createNodeDefinition(withDraft((draft) => {
        draft.directHardDependencies[0]!.requirement.contract.producer.kind = "STATE_PRECONDITION";
      })),
      "DEPENDENCY_CONTRACT_MALFORMED", "DEPENDENCY_CONTRACT",
    );
    expectRefusal(
      createNodeDefinition(withDraft((draft) => {
        draft.directHardDependencies[0]!.requirement.edgeKind = "RELATED";
      })),
      "DEPENDENCY_ADVISORY_CONTRACT_FORBIDDEN", "DEPENDENCY_CONTRACT",
    );
  });

  it("refuses a re-read body whose persisted proof no longer covers a monotonic entry", () => {
    const { definition } = acceptedOrThrow();
    const stripped = { ...definition, monotonicPredicateProofs: [] };
    expectRefusal(
      admitNodeDefinition(stripped),
      "NODE_AUTHORITY_MONOTONIC_PROOF_MISSING", "NODE_AUTHORITY_PROOFS",
    );
  });
});

describe("planning source refusals", () => {
  it("passes a core planning refusal through with its own code at the planning layer", () => {
    expectRefusal(
      createNodeDefinition(createInput({ planRevision: { revisionId: "plan-revision-a" } })),
      "PLAN_REVISION_MALFORMED", "PLANNING_SOURCE",
    );
    expectRefusal(
      createNodeDefinition(createInput({ acceptanceContract: { contractId: "c" } })),
      "ACCEPTANCE_CONTRACT_MALFORMED", "PLANNING_SOURCE",
    );
  });

  it("refuses a node the planning records do not make applicable", () => {
    expectRefusal(
      createNodeDefinition(withDraft((draft) => { draft.nodeKey = "node-unlisted"; })),
      "NODE_AUTHORITY_APPLICABILITY_MISMATCH", "NODE_AUTHORITY_ADMISSION",
    );
    expectRefusal(
      createNodeDefinition(withDraft((draft) => {
        draft.verificationRecipeRevisions = ["recipe-unlisted"];
      })),
      "NODE_AUTHORITY_APPLICABILITY_MISMATCH", "NODE_AUTHORITY_ADMISSION",
    );
  });
});

describe("refusal vocabulary", () => {
  it("keeps the code roster closed, sorted and free of any layer export", () => {
    expect([...NODE_AUTHORITY_CODES]).toEqual([...NODE_AUTHORITY_CODES].sort());
    expect(new Set(NODE_AUTHORITY_CODES).size).toBe(NODE_AUTHORITY_CODES.length);
    expect(NODE_AUTHORITY_CODES.length).toBeGreaterThanOrEqual(12);
    expect(NODE_AUTHORITY_DIGEST_DOMAIN).not.toBe(NODE_AUTHORITY_SCHEMA_TAG);
    expect(NODE_AUTHORITY_LIMITS.maxObjectiveBytes).toBeGreaterThan(0);
  });

  it("digests the canonical body under its own domain", () => {
    // A DECLARING mint, so this arm still covers the CURRENT digest domain: an
    // undeclared body digests under the legacy one, which arm (a) pins separately.
    const accepted = acceptedOrThrow(declaringInput());
    const body = decoder.decode(bytesOrThrow(declaringInput()));
    const canonical = JSON.parse(body) as { readonly body: unknown; readonly digest: string };
    const payload = JSON.stringify(canonical.body);
    expect(createHash("sha256")
      .update(`${NODE_AUTHORITY_DIGEST_DOMAIN}\n${payload.length}:`, "utf8")
      .update(payload, "utf8").digest("hex")).toBe(accepted.bodyContentDigest);
    expect(canonical.digest).toBe(accepted.bodyContentDigest);
    const round = decodeNodeDefinitionBytes(bytesOrThrow(declaringInput()));
    expect(round.ok).toBe(true);
  });
});

const reencode = (
  bytes: Uint8Array,
  change: (envelope: Record<string, unknown>) => void,
): Uint8Array => {
  const envelope = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
  change(envelope);
  return new TextEncoder().encode(JSON.stringify(envelope));
};

describe("canonical codec refusals", () => {
  it("refuses a non-record, hostile-prototype, proxied or accessor-backed draft", () => {
    // Defined, never spread: an object spread INVOKES the getter and would hand
    // admission an ordinary data property, testing nothing.
    const accessorDraft = (): unknown => {
      const draft = authorityDraft() as Record<string, unknown>;
      delete draft["objective"];
      Object.defineProperty(draft, "objective", {
        configurable: true, enumerable: true, get: () => "Objective.",
      });
      return draft;
    };
    const hostile: readonly unknown[] = [
      null, 7, "draft", [authorityDraft()], Object.create({ nodeKey: "node-a" }) as unknown,
      new Proxy(authorityDraft(), {}), accessorDraft(), { objective: "Objective." },
    ];
    expect(hostile.length).toBeGreaterThanOrEqual(8);
    let swept = 0;
    for (const value of hostile) {
      swept += 1;
      expectRefusal(
        draftNodeAuthority(value), "NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_ADMISSION",
      );
    }
    expect(swept).toBe(hostile.length);
  });

  it("refuses an unsupported schema version on the body and on the envelope", () => {
    const { definition } = acceptedOrThrow();
    expectRefusal(
      admitNodeDefinition({ ...definition, schemaVersion: 99 }),
      "NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_SCHEMA",
    );
    expectRefusal(
      decodeNodeDefinitionBytes(reencode(bytesOrThrow(), (envelope) => {
        envelope["schema"] = "MOE-NODE-AUTHORITY/99";
      })),
      "NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_CODEC",
    );
  });

  it("refuses a duplicate direct-hard edge key", () => {
    expectRefusal(
      createNodeDefinition(withDraft((draft) => {
        draft.directHardDependencies = [
          { edgeKey: "edge-a", requirement: requirement() },
          { edgeKey: "edge-a", requirement: requirement() },
        ];
      })),
      "NODE_AUTHORITY_DUPLICATE_EDGE", "NODE_AUTHORITY_DEPENDENCIES",
    );
  });

  it("refuses unsorted direct-hard entries because edge order is normative", () => {
    const unsorted = withDraft((draft) => {
      draft.directHardDependencies = [
        { edgeKey: "edge-b", requirement: requirement() },
        { edgeKey: "edge-a", requirement: requirement() },
      ];
    });
    expectRefusal(
      createNodeDefinition(unsorted),
      "NODE_AUTHORITY_EDGE_ORDER", "NODE_AUTHORITY_DEPENDENCIES",
    );
    const sorted = acceptedOrThrow(withDraft((draft) => {
      draft.directHardDependencies = [
        { edgeKey: "edge-a", requirement: requirement() },
        { edgeKey: "edge-b", requirement: requirement() },
      ];
    }));
    expect(sorted.definition.directHardDependencies.map((entry) => entry.edgeKey))
      .toEqual(["edge-a", "edge-b"]);
    expectRefusal(
      admitNodeDefinition({
        ...sorted.definition,
        directHardDependencies: [...sorted.definition.directHardDependencies].reverse(),
      }),
      "NODE_AUTHORITY_EDGE_ORDER", "NODE_AUTHORITY_DEPENDENCIES",
    );
  });

  it("accepts each bound at its limit and refuses one past it", () => {
    const pairs: readonly (readonly [number, (draft: AuthorityDraft, count: number) => void])[] = [
      [NODE_AUTHORITY_LIMITS.maxObjectiveBytes, (draft, count) => {
        draft.objective = "o".repeat(count);
      }],
      [NODE_AUTHORITY_LIMITS.maxListEntries, (draft, count) => {
        draft.constraints = Array.from(
          { length: count }, (_, index) => `constraint-${String(index).padStart(4, "0")}`,
        );
      }],
      [NODE_AUTHORITY_LIMITS.maxScopeEntries, (draft, count) => {
        draft.readScopes = Array.from(
          { length: count }, (_, index) => `services/api/s${String(index).padStart(4, "0")}`,
        );
      }],
      [NODE_AUTHORITY_LIMITS.maxDependencyEntries, (draft, count) => {
        draft.directHardDependencies = Array.from({ length: count }, () => null as never);
      }],
    ];
    expect(pairs.length).toBeGreaterThanOrEqual(4);
    let swept = 0;
    for (const [limit, apply] of pairs) {
      swept += 1;
      expect(limit).toBeGreaterThan(0);
      const over = authorityDraft();
      apply(over, limit + 1);
      expectRefusal(
        draftNodeAuthority(over), "NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
      );
      const at = authorityDraft();
      apply(at, limit === NODE_AUTHORITY_LIMITS.maxDependencyEntries ? 0 : limit);
      expect(draftNodeAuthority(at).ok).toBe(true);
    }
    expect(swept).toBe(pairs.length);
  });

  it("refuses to mint bytes it could not read back, with a positive control", () => {
    const heavy = (index: number) => {
      const contract = dependencyContract();
      contract.stability = "REVOCABLE";
      contract.satisfactionWitnesses = Array.from({ length: 128 }, (_, item) => ({
        sourceOperationClass: "ARTIFACT_SEAL", witnessDigest: hex("2"),
        witnessRef: `witness-${String(item).padStart(5, "0")}`, witnessVersion: 1,
      }));
      contract.invalidationFacts = Array.from({ length: 128 }, (_, item) => ({
        sourceFactDigest: hex("e"), sourceFactRef: `fact-${String(item).padStart(5, "0")}`,
        sourceFactVersion: 1,
      }));
      return { edgeKey: `edge-${String(index).padStart(3, "0")}`,
        requirement: { contract, edgeKind: "ARTIFACT_CONSUMPTION" } };
    };
    const withEdges = (count: number): Record<string, unknown> => withDraft((draft) => {
      draft.directHardDependencies = Array.from({ length: count }, (_, index) => heavy(index));
    });
    expect(encodeNodeDefinition(acceptedOrThrow(withEdges(4)).definition).ok).toBe(true);
    expectRefusal(
      createNodeDefinition(withEdges(40)),
      "NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
    );
  });

  it("refuses a rationale longer than the proof bound before persisting it", () => {
    const registry = registryEntry();
    registry.proofRationale = "r".repeat(NODE_AUTHORITY_LIMITS.maxRationaleBytes + 1);
    expectRefusal(
      createNodeDefinition(createInput({ predicateRegistry: [registry] })),
      "NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS",
    );
  });

  it("refuses input that is not bytes, is over the ceiling, or is unreadable", () => {
    expectRefusal(
      decodeNodeDefinitionBytes("bytes"), "NODE_AUTHORITY_NOT_BYTES", "NODE_AUTHORITY_CODEC",
    );
    expectRefusal(
      decodeNodeDefinitionBytes(new Uint8Array(NODE_AUTHORITY_LIMITS.maxBytes + 1)),
      "NODE_AUTHORITY_TOO_LARGE", "NODE_AUTHORITY_CODEC",
    );
    expectRefusal(
      decodeNodeDefinitionBytes(Uint8Array.of(0xff, 0xfe, 0xfd)),
      "NODE_AUTHORITY_UNREADABLE", "NODE_AUTHORITY_CODEC",
    );
    expectRefusal(
      decodeNodeDefinitionBytes(new TextEncoder().encode("[1,2,3]")),
      "NODE_AUTHORITY_MALFORMED", "NODE_AUTHORITY_CODEC",
    );
  });

  it("refuses a swapped digest before it refuses a respelled encoding", () => {
    expectRefusal(
      decodeNodeDefinitionBytes(reencode(bytesOrThrow(), (envelope) => {
        envelope["digest"] = hex("8");
      })),
      "NODE_AUTHORITY_DIGEST_MISMATCH", "NODE_AUTHORITY_IDENTITY",
    );
    expectRefusal(
      decodeNodeDefinitionBytes(reencode(bytesOrThrow(), (envelope) => {
        const body = envelope["body"] as Record<string, unknown>;
        const reordered: Record<string, unknown> = {};
        for (const key of Object.keys(body).reverse()) reordered[key] = body[key];
        envelope["body"] = reordered;
      })),
      "NODE_AUTHORITY_NONCANONICAL", "NODE_AUTHORITY_IDENTITY",
    );
    expectRefusal(
      decodeNodeDefinitionBytes(new TextEncoder().encode(`${decoder.decode(bytesOrThrow())} `)),
      "NODE_AUTHORITY_NONCANONICAL", "NODE_AUTHORITY_IDENTITY",
    );
  });

  it("detaches decoded bytes from the caller's buffer", () => {
    const source = bytesOrThrow();
    const decoded = decodeNodeDefinitionBytes(source);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const before = decoder.decode(decoded.value.bytes);
    source.fill(0);
    expect(decoder.decode(decoded.value.bytes)).toBe(before);
    expect(everyValueFrozen(decoded.value.definition)).toEqual([]);
  });
});

describe("byte stability", () => {
  it("encodes byte-identically for the same admitted inputs", () => {
    expect(decoder.decode(bytesOrThrow())).toBe(decoder.decode(bytesOrThrow()));
    expect(decoder.decode(bytesOrThrow())).toBe(decoder.decode(bytesOrThrow(createInput())));
  });

  it("changes the bytes when any included field family changes", () => {
    const widePlan = (): PlanDraft => {
      const plan = planDraft();
      plan.affectedNodeIds = ["node-a", "node-b"];
      return plan;
    };
    const wideAcceptance = (): AcceptanceDraft => {
      const contract = acceptanceDraft();
      contract.applicability = { ...contract.applicability, nodeIds: ["node-a", "node-b"] };
      return contract;
    };
    const wideInput = (overrides: Record<string, unknown> = {}) => createInput({
      acceptanceContract: acceptanceOrThrow(wideAcceptance()),
      planRevision: planOrThrow(widePlan()),
      ...overrides,
    });
    const wideDraft = (change: (draft: AuthorityDraft) => void): Record<string, unknown> => {
      const draft = authorityDraft();
      change(draft);
      return wideInput({ draft });
    };
    const control = decoder.decode(bytesOrThrow(wideInput()));
    const probes: readonly (readonly [string, () => Record<string, unknown>])[] = [
      ["nodeKey", () => wideDraft((d) => { d.nodeKey = "node-b"; })],
      ["objective", () => wideDraft((d) => { d.objective = "A different objective entirely."; })],
      ["capability", () => wideDraft((d) => { d.capability = "capability-review"; })],
      ["constraints", () => wideDraft((d) => { d.constraints = ["constraint-a"]; })],
      ["resources", () => wideDraft((d) => { d.resources = ["resource-b"]; })],
      ["admissionAmounts", () => wideDraft((d) => {
        d.admissionAmounts = admissionAmounts("provider.input_tokens");
      })],
      ["admissionGatePolicy", () => wideDraft((d) => { d.admissionGatePolicy = "HUMAN_APPROVAL"; })],
      ["readScopes", () => wideDraft((d) => { d.readScopes = ["services/api/src"]; })],
      ["writeScopes", () => wideDraft((d) => { d.writeScopes = ["services/api/src/other"]; })],
      ["repositoryBaseTree", () => wideDraft((d) => { d.repositoryBaseTree = hex("5"); })],
      ["policySliceHash", () => wideDraft((d) => { d.policySliceHash = hex("6"); })],
      ["verificationRecipeRevisions", () => wideDraft((d) => {
        d.verificationRecipeRevisions = ["recipe-b"];
      })],
      ["joinRole", () => wideDraft((d) => {
        d.joinRole = "COMPLETION";
        d.completionLinkage = "node-a";
      })],
      ["directHardDependencies", () => wideDraft((d) => {
        d.directHardDependencies[0]!.requirement.contract.graphBindingDigest = hex("7");
      })],
      ["criterionBindings", () => {
        const contract = wideAcceptance();
        contract.obligations[0]!.statement = "The node ships a different verification.";
        return wideInput({ acceptanceContract: acceptanceOrThrow(contract) });
      }],
      ["planExecutionContentDigest", () => {
        const plan = widePlan();
        plan.steps[0]!.description = "Analyse the node differently.";
        return wideInput({ planRevision: planOrThrow(plan) });
      }],
      ["monotonicPredicateProofs", () => {
        const registry = registryEntry();
        registry.proofRationale = "A different durable rationale.";
        return wideInput({ predicateRegistry: [registry] });
      }],
      ["declaredMigrations", () => wideDraft((d) => {
        (d as unknown as Record<string, unknown>)["declaredMigrations"] = ["migration-a"];
      })],
    ];
    expect(probes.length).toBeGreaterThanOrEqual(16);
    let swept = 0;
    for (const [name, build] of probes) {
      swept += 1;
      expect(`${name}:${decoder.decode(bytesOrThrow(build()))}`).not.toBe(`${name}:${control}`);
    }
    expect(swept).toBe(probes.length);
  });
});

/**
 * `declaredMigrations` — the schema-3 declaration this row adds.
 *
 * THE PINS BELOW WERE MEASURED AT THE PRE-CHANGE TREE and are literals on purpose:
 * a v2 body's digest is history, so a recomputation-based assertion would agree
 * with a preimage regression instead of catching it.
 */
const LEGACY_V2_BODY_DIGEST =
  "37e1154af358d0c0213d2efa0a6d4210ed84d45ce9786291002e9146e727c8ed";
const LEGACY_V2_SCHEMA_TAG = "MOE-NODE-AUTHORITY/2";
const LEGACY_V2_DIGEST_DOMAIN = "MOE-NODE-AUTHORITY-BODY-HASH/2";

const definitionOf = (input: unknown = createInput()): Record<string, unknown> =>
  ({ ...(acceptedOrThrow(input).definition as unknown as Record<string, unknown>) });

/** A STORED body from before this row: the same content, restated at schema 2. */
function legacyV2Body(): Record<string, unknown> {
  const body = definitionOf();
  delete body["declaredMigrations"];
  body["schemaVersion"] = 2;
  return body;
}

function declaringBody(declared: unknown): Record<string, unknown> {
  // `definitionOf()` now mints at the UNDECLARED version, so a body that states
  // the member must state the version that can carry it: a v2 body stating a
  // declaration is a forged pairing and arm (f) asserts it refuses.
  return { ...definitionOf(), declaredMigrations: declared, schemaVersion: 3 };
}

function encodeOrThrow(body: unknown): Uint8Array {
  const result = encodeNodeDefinition(body);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return result.bytes;
}

function admittedOrThrow(body: unknown) {
  const result = admitNodeDefinition(body);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => `${issue.code}@${issue.layer}`).join(","));
  }
  return result.value;
}

describe("declaredMigrations — the schema-3 declaration", () => {
  it("(a) re-encodes a stored v2 body byte-identically and mints no declaration", () => {
    const stored = legacyV2Body();
    const admitted = admittedOrThrow(stored);
    expect(admitted.bodyContentDigest).toBe(LEGACY_V2_BODY_DIGEST);
    expect(admitted.schemaVersion).toBe(2);
    // ABSENT, not `[]`: an empty list would be a declaration nobody authored.
    expect("declaredMigrations" in admitted.definition).toBe(false);
    const text = decoder.decode(admitted.bytes);
    expect(text).toContain(`"schema":"${LEGACY_V2_SCHEMA_TAG}"`);
    expect(text).not.toContain("declaredMigrations");
    const round = decodeNodeDefinitionBytes(admitted.bytes);
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(decoder.decode(round.value.bytes)).toBe(text);
    // The LEGACY domain, not the current one: a v2 body keeps digesting under /2.
    const payload = JSON.stringify((JSON.parse(text) as { readonly body: unknown }).body);
    expect(createHash("sha256")
      .update(`${LEGACY_V2_DIGEST_DOMAIN}\n${payload.length}:`, "utf8")
      .update(payload, "utf8").digest("hex")).toBe(LEGACY_V2_BODY_DIGEST);
  });

  it("(b) round-trips two declared identifiers by value, by count and in authored order", () => {
    const declared = ["1730000000002_add-orders", "1730000000001_add-users"];
    const bytes = encodeOrThrow(declaringBody(declared));
    const round = decodeNodeDefinitionBytes(bytes);
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    const readBack = round.value.definition.declaredMigrations;
    expect(readBack).toHaveLength(2);
    // AUTHORED ORDER, never sorted: migration identifiers are applied in sequence,
    // so reordering them would silently restate what the author declared.
    expect(readBack).toEqual(declared);
    expect(round.value.schemaVersion).toBe(3);
  });

  it("(c) keeps an explicit empty declaration present and distinct from a v2 body", () => {
    const empty = admittedOrThrow(declaringBody([]));
    expect("declaredMigrations" in empty.definition).toBe(true);
    expect(empty.definition.declaredMigrations).toEqual([]);
    expect(empty.schemaVersion).toBe(3);
    expect(empty.bodyContentDigest).not.toBe(LEGACY_V2_BODY_DIGEST);
    expect(decoder.decode(empty.bytes)).toContain("\"declaredMigrations\":[]");
  });

  it("(d) refuses a duplicate identifier with its OWN code rather than deduplicating", () => {
    const duplicate = admitNodeDefinition(declaringBody(["migration-a", "migration-a"]));
    expectRefusal(duplicate, "NODE_AUTHORITY_DUPLICATE_MIGRATION", "NODE_AUTHORITY_ADMISSION");
    // ANTI-VACUITY (global rail 1): a generic list refusal must NOT be what answered,
    // so the same shape through the generic id reader carries a DIFFERENT code.
    const generic = admitNodeDefinition({ ...definitionOf(), constraints: ["c-a", "c-a"] });
    expect(generic.ok).toBe(true);
    const twoAccepted = admittedOrThrow(declaringBody(["migration-a", "migration-b"]));
    expect(twoAccepted.definition.declaredMigrations).toHaveLength(2);
  });

  it("(e) refuses a malformed, inadmissible or oversized declaration by code and layer", () => {
    expectRefusal(admitNodeDefinition(declaringBody("migration-a")),
      "NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION");
    expectRefusal(admitNodeDefinition(declaringBody([7])),
      "NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION");
    expectRefusal(admitNodeDefinition(declaringBody(["a".repeat(129)])),
      "NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY_ADMISSION");
    const over = Array.from(
      { length: NODE_AUTHORITY_LIMITS.maxMigrationEntries + 1 },
      (_unused, index) => `migration-${index}`,
    );
    expectRefusal(admitNodeDefinition(declaringBody(over)),
      "NODE_AUTHORITY_LIMIT_EXCEEDED", "NODE_AUTHORITY_LIMITS");
  });

  it("(f) accepts a version SET, and the two schema gates must agree rather than merely pass", () => {
    expect(admitNodeDefinition(legacyV2Body()).ok).toBe(true);
    expect(admitNodeDefinition(definitionOf()).ok).toBe(true);
    // The v3 half of the SET: an undeclared mint is v2, so a declaring body is
    // what actually exercises the current version through the same gate.
    expect(admitNodeDefinition(declaringBody(["migration-a"])).ok).toBe(true);
    for (const version of [1, 4]) {
      expectRefusal(admitNodeDefinition({ ...definitionOf(), schemaVersion: version }),
        "NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_SCHEMA");
    }
    // A v2 body may not STATE the member: that pairing is refused at the SCHEMA layer,
    // not silently accepted and then caught as an alternate encoding.
    expectRefusal(
      admitNodeDefinition({ ...legacyV2Body(), declaredMigrations: ["migration-a"] }),
      "NODE_AUTHORITY_SCHEMA_MISMATCH", "NODE_AUTHORITY_SCHEMA");
    const unknownTag = reencode(encodeOrThrow(legacyV2Body()), (envelope) => {
      envelope["schema"] = "MOE-NODE-AUTHORITY/9";
    });
    expectRefusal(decodeNodeDefinitionBytes(unknownTag),
      "NODE_AUTHORITY_UNSUPPORTED_SCHEMA", "NODE_AUTHORITY_CODEC");
    // THE FORGED PAIRING: a v3 body inside an envelope tagged /2. Both gates pass
    // alone; only their agreement catches it.
    const forged = reencode(encodeOrThrow(declaringBody(["migration-a"])), (envelope) => {
      envelope["schema"] = LEGACY_V2_SCHEMA_TAG;
    });
    expectRefusal(decodeNodeDefinitionBytes(forged),
      "NODE_AUTHORITY_SCHEMA_MISMATCH", "NODE_AUTHORITY_CODEC");
  });

  it("(g) mints a fresh body at the LOWEST version that carries it, not the current one", () => {
    // THE REGRESSION THIS ARM EXISTS FOR. Every arm above hands a body to the
    // re-admit path, so all of them stayed green while the FRESH MINT stamped the
    // module's current version on a body that declares nothing. That moved four
    // pinned daemon digests, two of which are historical APPROVAL DECISIONS
    // (task rail 1: no silent rewrite of historical hashes).
    const undeclared = acceptedOrThrow();
    expect(undeclared.schemaVersion).toBe(2);
    expect("declaredMigrations" in undeclared.definition).toBe(false);
    // Byte-identical to the hand-built stored body of arm (a): the mint of a node
    // that declares nothing must be indistinguishable from what it minted before
    // this row existed, and the literal digest is what proves it.
    expect(undeclared.bodyContentDigest).toBe(LEGACY_V2_BODY_DIGEST);
    const text = decoder.decode(undeclared.bytes);
    expect(text).toContain(`"schema":"${LEGACY_V2_SCHEMA_TAG}"`);
    expect(text).not.toContain("declaredMigrations");
    // A draft that DOES declare mints at 3: the version is chosen by CONTENT, so
    // the promotion is exactly as wide as the declaration and no wider.
    const declared = acceptedOrThrow(withDraft((draft) => {
      (draft as unknown as Record<string, unknown>)["declaredMigrations"] = ["migration-a"];
    }));
    expect(declared.schemaVersion).toBe(3);
    expect(declared.definition.declaredMigrations).toEqual(["migration-a"]);
    expect(declared.bodyContentDigest).not.toBe(LEGACY_V2_BODY_DIGEST);
  });
});
