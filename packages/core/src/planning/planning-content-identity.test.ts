/**
 * Graph-independent planning content identities. A nodeAuthorityHash covering a target
 * graphContentHash cannot embed planHash or criteriaDigest, which already cover that same hash; the
 * exclusion assertions below are that cycle break. They assert BYTE IDENTITY under excluded-field
 * mutation, with the full digest as the witness that the mutation actually landed on the record.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_CONTRACT_VERSION } from "./acceptance-contract.js";
import { ACCEPTANCE_CONTRACT_DIGEST_DOMAIN, ACCEPTANCE_CRITERION_CONTENT_DOMAIN, createAcceptanceContract, deriveAcceptanceCriterionContent, encodeAcceptanceContract } from "./acceptance-contract-codec.js";
import { PLAN_REVISION_VERSION } from "./plan-revision-contract.js";
import { createPlanRevision, derivePlanExecutionContent, encodePlanRevision, PLAN_EXECUTION_CONTENT_DOMAIN, PLAN_REVISION_DIGEST_DOMAIN } from "./plan-revision-codec.js";

/** Harvested from production output at baseline HEAD 3a6b462, before either derivation existed. */
const PINNED_PLAN_HASH = "4db58f66100439cc65b8226505846b4a2bb75d57049d0b1e4a30b6a9e69c0779";
const PINNED_CRITERIA_DIGEST = "279e5d238d3732723c9ee6a9a49fd413241e1095d97c10a779d5202488ef22bd";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (digit: string): string => digit.repeat(64);
const PLAN_KEYS = Object.freeze(["affectedCriterionIds", "affectedNodeIds", "steps", "verificationRecipeRefs", "version"]);
const CRITERION_KEYS = Object.freeze(["evidenceRequirements", "nodeKind", "statement", "verificationRecipeRefs", "version"]);
const CRITERION_IDS = Object.freeze(["criterion-a", "criterion-b"]);

const planDraft = () => ({
  affectedCriterionIds: ["criterion-a", "criterion-b"], affectedNodeIds: ["node-a", "node-b"],
  approvalState: "APPROVED", authorRef: "principal-a",
  graphBinding: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a" },
  parentRevisionId: null as string | null, rejectionRef: null as string | null,
  revisionId: "plan-revision-a", verificationRecipeRefs: ["verify-a", "verify-b"],
  steps: [{ description: "Analyse the graph.", kind: "ANALYSIS", stepId: "step-a" },
    { description: "Implement the change.", kind: "IMPLEMENTATION", stepId: "step-b" }],
});
const obligation = (id: string, statement: string, kind: string) => ({
  criterionId: `criterion-${id}`, statement, verificationRecipeRefs: [`recipe-${id}`],
  evidenceRequirements: [{ evidenceRef: `evidence-${id}`, kind, requirementId: `requirement-${id}` }],
});
const contractDraft = () => ({
  applicability: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a", nodeIds: ["node-a", "node-b"], nodeKind: "LEAF" },
  authorRef: "principal-a", contractId: "contract-a",
  obligations: [obligation("a", "The focused suite passes.", "ARTIFACT"),
    obligation("b", "The repository typecheck passes.", "VERIFICATION_RECEIPT")],
});
type PlanDraft = ReturnType<typeof planDraft>;
type ContractDraft = ReturnType<typeof contractDraft>;
type PlanMutator = readonly [string, (draft: PlanDraft) => void];
type ContractMutator = readonly [string, (draft: ContractDraft) => void];
const withPlan = (mutate: (draft: PlanDraft) => void): PlanDraft => { const draft = planDraft(); mutate(draft); return draft; };
const withContract = (mutate: (draft: ContractDraft) => void): ContractDraft => { const draft = contractDraft(); mutate(draft); return draft; };
const names = (mutators: readonly PlanMutator[] | readonly ContractMutator[]): readonly string[] => mutators.map(([name]) => name);
const planRevision = (draft: unknown = planDraft()) => { const r = createPlanRevision(draft); if (!r.ok) throw new Error(`${r.code}@${r.layer}`); return r.revision; };
const contractOf = (draft: unknown = contractDraft()) => { const r = createAcceptanceContract(draft); if (!r.ok) throw new Error(`${r.code}@${r.layer}`); return r.contract; };
const executionDigest = (revision: unknown): string => { const r = derivePlanExecutionContent(revision); if (!r.ok) throw new Error(`${r.code}@${r.layer}`); return r.digest; };
const roster = (contract: unknown) => { const r = deriveAcceptanceCriterionContent(contract); if (!r.ok) throw new Error(`${r.code}@${r.layer}`); return r.criteria; };
const criterionDigest = (contract: unknown, criterionId: string): string => { const entry = roster(contract).find((item) => item.criterionId === criterionId); if (entry === undefined) throw new Error(`absent ${criterionId}`); return entry.contentDigest; };
const rosterDigests = (contract: unknown): readonly string[] => CRITERION_IDS.map((id) => criterionDigest(contract, id));
const refusalOf = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }): readonly (string | undefined)[] => { expect(result.ok).toBe(false); if (result.ok) throw new Error("expected refusal"); return [result.code, result.layer]; };
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every((key) => deeplyFrozen((value as Readonly<Record<PropertyKey, unknown>>)[key]));
}
/** Preimage taken from the PRODUCTION canonical encoding, never hand-spelled. */
function project(source: Readonly<Record<string, unknown>>, keys: readonly string[]): Uint8Array {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) if (keys.includes(key)) body[key] = source[key];
  expect(Object.keys(body)).toStrictEqual([...keys]);
  return encoder.encode(JSON.stringify(body));
}
const digestOver = (domain: string, body: Uint8Array): string => createHash("sha256").update(domain, "utf8").update(Uint8Array.of(0)).update(body).digest("hex");
const encodedPlan = (revision: unknown): Readonly<Record<string, unknown>> => { const r = encodePlanRevision(revision); if (!r.ok) throw new Error(`${r.code}@${r.layer}`); return JSON.parse(decoder.decode(r.bytes)) as Readonly<Record<string, unknown>>; };
const encodedContract = (contract: unknown): Readonly<Record<string, unknown>> => { const r = encodeAcceptanceContract(contract); if (!r.ok) throw new Error(`${r.code}@${r.layer}`); return JSON.parse(decoder.decode(r.bytes)) as Readonly<Record<string, unknown>>; };
function criterionPreimage(source: Readonly<Record<string, unknown>>, index: number): Uint8Array {
  const obligations = source["obligations"] as readonly Readonly<Record<string, unknown>>[];
  const applicability = source["applicability"] as Readonly<Record<string, unknown>>;
  const entry = obligations[index]!;
  return project({ evidenceRequirements: entry["evidenceRequirements"], nodeKind: applicability["nodeKind"], statement: entry["statement"], verificationRecipeRefs: entry["verificationRecipeRefs"], version: source["version"] }, CRITERION_KEYS);
}

const INCLUDED_PLAN: readonly PlanMutator[] = [
  ["step kind", (d) => { d.steps[0]!.kind = "VERIFICATION"; }],
  ["step description", (d) => { d.steps[0]!.description = "Analyse the graph twice."; }],
  ["step id", (d) => { d.steps[0]!.stepId = "step-c"; }],
  ["step order", (d) => { d.steps.reverse(); }],
  ["affected node ids", (d) => { d.affectedNodeIds[1] = "node-c"; }],
  ["affected criterion ids", (d) => { d.affectedCriterionIds[1] = "criterion-c"; }],
  ["verification recipe refs", (d) => { d.verificationRecipeRefs[1] = "verify-c"; }],
];
const EXCLUDED_PLAN: readonly PlanMutator[] = [
  ["graphContentHash", (d) => { d.graphBinding.graphContentHash = hex("b"); }],
  ["graphRevisionRef", (d) => { d.graphBinding.graphRevisionRef = "graph-revision-z"; }],
  ["approvalState", (d) => { d.approvalState = "PENDING_APPROVAL"; }],
  ["authorRef", (d) => { d.authorRef = "principal-z"; }],
  ["parentRevisionId", (d) => { d.parentRevisionId = "plan-revision-parent"; }],
  ["rejectionRef", (d) => { d.rejectionRef = "rejection-a"; }],
  ["revisionId", (d) => { d.revisionId = "plan-revision-z"; }],
];

describe("plan execution-content identity", () => {
  it("pins its own domain, the plan version and exactly the execution projection", () => {
    const revision = planRevision();
    const result = derivePlanExecutionContent(revision);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a digest");
    expect(deeplyFrozen(result)).toBe(true);
    const text = decoder.decode(project(encodedPlan(revision), PLAN_KEYS));
    expect(text).toContain(`"version":"${PLAN_REVISION_VERSION}"`);
    expect(text).not.toContain("graphContentHash");
    expect(text).not.toContain("approvalState");
    expect(result.digest).toBe(digestOver(PLAN_EXECUTION_CONTENT_DOMAIN, encoder.encode(text)));
    expect(executionDigest(revision)).toBe(result.digest);
  });
  it("changes for every included execution field", () => {
    const base = executionDigest(planRevision());
    expect(INCLUDED_PLAN.length).toBe(7);
    const moved = INCLUDED_PLAN.filter(([, mutate]) => executionDigest(planRevision(withPlan(mutate))) !== base);
    expect(names(moved)).toStrictEqual(names(INCLUDED_PLAN));
  });
  it("stays byte-identical across every excluded authoritative field", () => {
    const base = planRevision();
    const baseDigest = executionDigest(base);
    expect(EXCLUDED_PLAN.length).toBe(7);
    for (const [name, mutate] of EXCLUDED_PLAN) {
      const mutated = planRevision(withPlan(mutate));
      expect(mutated.planHash, `${name} must move the full plan digest`).not.toBe(base.planHash);
      expect(executionDigest(mutated), `${name} must not enter the execution identity`).toBe(baseDigest);
    }
  });
  it("ignores a forged planHash rather than folding it into the identity", () => {
    const base = planRevision();
    const forged = { ...base, planHash: hex("f") };
    expect(forged.planHash).not.toBe(base.planHash);
    expect(executionDigest(forged)).toBe(executionDigest(base));
  });
  it("refuses through the existing admission with the upstream code and layer", () => {
    expect(refusalOf(derivePlanExecutionContent({}))).toStrictEqual(["PLAN_REVISION_MALFORMED", "PLAN_REVISION_ADMISSION"]);
    expect(refusalOf(derivePlanExecutionContent({ ...planRevision(), version: "moe-plan-revision/2" })))
      .toStrictEqual(["PLAN_REVISION_VERSION_UNSUPPORTED", "PLAN_REVISION_VERSION"]);
    expect(refusalOf(derivePlanExecutionContent({ ...planRevision(), affectedNodeIds: ["node-a", "node-a"] })))
      .toStrictEqual(["PLAN_REVISION_DUPLICATE_ID", "PLAN_REVISION_LIMITS"]);
    expect(refusalOf(derivePlanExecutionContent({ ...planRevision(), authorRef: "a".repeat(513) })))
      .toStrictEqual(["PLAN_REVISION_LIMIT_EXCEEDED", "PLAN_REVISION_LIMITS"]);
    expect(derivePlanExecutionContent.length).toBe(1);
  });
});

const INCLUDED_CRITERION: readonly ContractMutator[] = [
  ["statement", (d) => { d.obligations[0]!.statement = "The focused suite fails."; }],
  ["evidence ref", (d) => { d.obligations[0]!.evidenceRequirements[0]!.evidenceRef = "evidence-z"; }],
  ["evidence kind", (d) => { d.obligations[0]!.evidenceRequirements[0]!.kind = "WITNESS"; }],
  ["requirement id", (d) => { d.obligations[0]!.evidenceRequirements[0]!.requirementId = "requirement-z"; }],
  ["recipe refs", (d) => { d.obligations[0]!.verificationRecipeRefs[0] = "recipe-z"; }],
  ["node kind", (d) => { d.applicability.nodeKind = "INTEGRATION"; }],
];
const EXCLUDED_CONTRACT: readonly ContractMutator[] = [
  ["graphContentHash", (d) => { d.applicability.graphContentHash = hex("b"); }],
  ["graphRevisionRef", (d) => { d.applicability.graphRevisionRef = "graph-revision-z"; }],
  ["nodeIds", (d) => { d.applicability.nodeIds[1] = "node-c"; }],
  ["authorRef", (d) => { d.authorRef = "principal-z"; }],
  ["contractId", (d) => { d.contractId = "contract-z"; }],
];

describe("acceptance criterion content roster", () => {
  it("pins its own domain, the contract version and the node kind per criterion", () => {
    const contract = contractOf();
    const result = deriveAcceptanceCriterionContent(contract);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a roster");
    expect(deeplyFrozen(result)).toBe(true);
    expect(result.criteria.length).toBe(2);
    const ids = result.criteria.map((entry) => entry.criterionId);
    expect(ids).toStrictEqual([...CRITERION_IDS]);
    expect(ids).toStrictEqual([...ids].sort());
    const source = encodedContract(contract);
    for (const [index, entry] of result.criteria.entries()) {
      const text = decoder.decode(criterionPreimage(source, index));
      expect(text).toContain(`"version":"${ACCEPTANCE_CONTRACT_VERSION}"`);
      expect(text).toContain('"nodeKind":"LEAF"');
      expect(text).not.toContain("graphContentHash");
      expect(text).not.toContain("contractId");
      expect(entry.contentDigest).toBe(digestOver(ACCEPTANCE_CRITERION_CONTENT_DOMAIN, encoder.encode(text)));
    }
  });
  it("changes the affected criterion for every included content field", () => {
    const base = criterionDigest(contractOf(), "criterion-a");
    expect(INCLUDED_CRITERION.length).toBe(6);
    const moved = INCLUDED_CRITERION.filter(([, mutate]) => criterionDigest(contractOf(withContract(mutate)), "criterion-a") !== base);
    expect(names(moved)).toStrictEqual(names(INCLUDED_CRITERION));
  });
  it("stays byte-identical across every excluded contract field", () => {
    const base = contractOf();
    const baseDigests = rosterDigests(base);
    expect(EXCLUDED_CONTRACT.length).toBe(5);
    for (const [name, mutate] of EXCLUDED_CONTRACT) {
      const mutated = contractOf(withContract(mutate));
      expect(mutated.criteriaDigest, `${name} must move the full contract digest`).not.toBe(base.criteriaDigest);
      expect(rosterDigests(mutated), `${name} must not enter any criterion identity`).toStrictEqual(baseDigests);
    }
  });
  it("isolates one criterion's content from its sibling", () => {
    const base = contractOf();
    const mutated = contractOf(withContract((draft) => { draft.obligations[0]!.statement = "The focused suite fails."; }));
    expect(criterionDigest(mutated, "criterion-a")).not.toBe(criterionDigest(base, "criterion-a"));
    expect(criterionDigest(mutated, "criterion-b")).toBe(criterionDigest(base, "criterion-b"));
  });
  it("refuses through the existing admission with the upstream code and layer", () => {
    expect(refusalOf(deriveAcceptanceCriterionContent({})))
      .toStrictEqual(["ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION"]);
    expect(refusalOf(deriveAcceptanceCriterionContent({ ...contractOf(), obligations: [] })))
      .toStrictEqual(["ACCEPTANCE_CONTRACT_EMPTY_OBLIGATIONS", "ACCEPTANCE_CONTRACT_LIMITS"]);
    expect(refusalOf(deriveAcceptanceCriterionContent({ ...contractOf(), version: "moe-acceptance-contract/2" })))
      .toStrictEqual(["ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED", "ACCEPTANCE_CONTRACT_VERSION"]);
    expect(refusalOf(deriveAcceptanceCriterionContent({ ...contractOf(), obligations: [{ ...contractDraft().obligations[0]!, statement: "" }] })))
      .toStrictEqual(["ACCEPTANCE_CONTRACT_CRITERION_CONTENT_REQUIRED", "ACCEPTANCE_CONTRACT_ADMISSION"]);
    // The roster is sorted jointly: admission refuses unsorted obligations (here), and the
    // projector sorts what it admits. Without this half, no honest fixture can reach the sort.
    expect(refusalOf(deriveAcceptanceCriterionContent({ ...contractOf(), obligations: [...contractDraft().obligations].reverse() })))
      .toStrictEqual(["ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION"]);
    expect(deriveAcceptanceCriterionContent.length).toBe(1);
  });
});

describe("domain separation and byte compatibility", () => {
  it("keeps four pairwise-distinct versioned digest domains", () => {
    const domains = [PLAN_REVISION_DIGEST_DOMAIN, PLAN_EXECUTION_CONTENT_DOMAIN, ACCEPTANCE_CONTRACT_DIGEST_DOMAIN, ACCEPTANCE_CRITERION_CONTENT_DOMAIN];
    expect(new Set(domains).size).toBe(4);
    expect(domains.filter((domain) => /\/\d+$/u.test(domain))).toStrictEqual(domains);
  });
  it("yields pairwise-distinct full, execution and criterion identities", () => {
    const revision = planRevision();
    const digests = [revision.planHash, executionDigest(revision), criterionDigest(contractOf(), "criterion-a")];
    expect(new Set(digests).size).toBe(3);
  });
  it("leaves the existing planHash and criteriaDigest byte-identical", () => {
    expect(planRevision().planHash).toBe(PINNED_PLAN_HASH);
    expect(contractOf().criteriaDigest).toBe(PINNED_CRITERIA_DIGEST);
  });
});
