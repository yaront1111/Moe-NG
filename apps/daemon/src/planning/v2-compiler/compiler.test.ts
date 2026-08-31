import { createHash } from "node:crypto";

import {
  createCapabilityCatalogRevision, createDeliveryProfileQualification,
  createProductContractRevisionV2,
} from "@moe/core";
import { decodeGraphContent, type NodeDefinition } from "@moe/scheduler";
import { describe, expect, it } from "vitest";

import {
  createV2Compiler, type V2CompilerResolutionToken,
} from "./compiler.js";
import { sealCanonicalDag } from "./canonical.js";
import { materialIdentity, qualifiedIdentity } from "./material-identity.js";
import { compilerQualificationStatus } from "./compiler-profile-test-fixtures.js";
import { compilerResolutionMintInput } from "./compiler-resolution-test-fixtures.js";
import {
  compilerGraphAuthority, compilerNodeAdmissionAuthority, compilerNodeDefinition,
} from "./compiler-scheduler-test-fixtures.js";
import type {
  V2CompilerGraphAuthorityReader, V2CompilerNodeAdmissionAuthorityReader,
  V2CompilerNodeDefinitionReader,
} from "./authority-contracts.js";

const digest = (label: string): string => createHash("sha256").update(label).digest("hex");
const criterionIds = Object.freeze([
  "criterion-deployment", "criterion-keyboard", "criterion-latency",
  "criterion-login", "criterion-runtime", "criterion-session",
]);

const requirement = (requirementId: string, dependencies: readonly string[] = []) => ({
  dependsOnRequirementIds: [...dependencies], priority: "MUST" as const, requirementId,
  statement: `${requirementId} must hold.`, supersedesRequirementId: null,
});
const criterion = (criterionId: string, requirementId: string) => ({
  criterionId, requirementId, statement: `${criterionId} is observable.`,
  supersedesCriterionId: null, verification: `Run ${criterionId}.`,
});

function contract(transitive = false) {
  const result = createProductContractRevisionV2({
    assumptions: [{
      assumptionId: "assumption-browser", statement: "A supported browser is available.",
      validationCriterionId: "criterion-runtime",
    }],
    authorRef: "principal-product",
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "contract-v2", criteria: [
      criterion("criterion-deployment", "deployment-loopback"),
      criterion("criterion-keyboard", "ux-keyboard"),
      criterion("criterion-latency", "nfr-latency"),
      criterion("criterion-login", "requirement-login"),
      criterion("criterion-runtime", "technology-runtime"),
      criterion("criterion-session", "security-session"),
    ],
    deploymentRequirements: [requirement("deployment-loopback", ["technology-runtime"])],
    functionalRequirements: [requirement("requirement-login")],
    journeys: [{
      criterionIds: ["criterion-login", "criterion-session"], journeyId: "journey-login",
      statement: "An operator signs in.", userJobId: "job-access",
    }],
    lineage: null,
    materialDecisions: [{
      decisionId: "decision-stack", options: [
        { optionId: "option-next", statement: "Use the qualified Next.js profile." },
        { optionId: "option-rust", statement: "Use the qualified Rust profile." },
      ], question: "Which qualified profile is required?", selectedOptionId: "option-next",
    }],
    negativeScope: [{ scopeId: "scope-native", statement: "No native mobile client." }],
    nonFunctionalRequirements: [requirement("nfr-latency", ["requirement-login"])],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first-use success." }],
    productCompleteDefinition: {
      criterionIds: [...criterionIds], statement: "Every criterion is independently verified.",
    },
    retiredCriterionIds: [], retiredRequirementIds: [], revisionId: "contract-v2-r1",
    securityPrivacyRequirements: [requirement("security-session", ["requirement-login"])],
    sourceDocumentDigests: [digest("source-document")],
    successMetrics: [{
      measurement: "Count successful first sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Operators complete a first session.",
      target: "At least ten successful sessions.",
    }],
    technologyRequirements: [requirement(
      "technology-runtime", transitive ? ["requirement-login"] : [],
    )],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [requirement("ux-keyboard", ["requirement-login"])],
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

const RESOLUTION_MINT_INPUT = compilerResolutionMintInput();
interface CompilerOverrides {
  readonly clock?: () => number;
  readonly readGraphAuthority?: V2CompilerGraphAuthorityReader;
  readonly readNodeAdmissionAuthority?: V2CompilerNodeAdmissionAuthorityReader;
  readonly readNodeDefinition?: V2CompilerNodeDefinitionReader;
}
const createCompiler = (
  qualificationAuthority = RESOLUTION_MINT_INPUT.qualificationAuthority,
  overrides: CompilerOverrides = {},
) => createV2Compiler({
  clock: overrides.clock ?? (() => 1_500),
  qualificationAuthority,
  readGraphAuthority: overrides.readGraphAuthority ?? compilerGraphAuthority,
  readNodeAdmissionAuthority:
    overrides.readNodeAdmissionAuthority ?? compilerNodeAdmissionAuthority,
  readNodeDefinition: overrides.readNodeDefinition ?? compilerNodeDefinition,
});
const COMPILER = createCompiler();
const MINTED = COMPILER.mintResolutionToken(
  RESOLUTION_MINT_INPUT.catalog,
  {
    capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
    requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories,
  },
  RESOLUTION_MINT_INPUT.materials,
);
if (!MINTED.ok) throw new Error(`${MINTED.code}@${MINTED.layer}`);
const REAL_TOKEN = MINTED.token;
const compile = (
  value: unknown,
  tokens?: readonly V2CompilerResolutionToken[],
) => {
  if (tokens !== undefined) return COMPILER.compile(value, tokens);
  const minted = COMPILER.mintResolutionToken(
    RESOLUTION_MINT_INPUT.catalog, {
      capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
      requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories,
    }, RESOLUTION_MINT_INPUT.materials,
  );
  if (!minted.ok) return minted;
  return COMPILER.compile(value, [minted.token]);
};

function compileWithAuthority(value: unknown, overrides: CompilerOverrides = {}) {
  const compiler = createCompiler(RESOLUTION_MINT_INPUT.qualificationAuthority, overrides);
  const minted = compiler.mintResolutionToken(RESOLUTION_MINT_INPUT.catalog, {
    capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
    requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories,
  }, RESOLUTION_MINT_INPUT.materials);
  if (!minted.ok) return minted;
  return compiler.compile(value, [minted.token]);
}

function input(contractValue = contract()) {
  const resolutionRef = {
    builderCapabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
    catalogRevisionDigest: RESOLUTION_MINT_INPUT.catalog.revisionDigest,
  };
  return {
    contract: contractValue, graphId: "graph-v2-r1",
    nodes: [
      {
        authorityKind: "BUILDER", budgetRefs: [{ budgetId: "budget-delivery" }],
        capabilityId: "capability-web-build",
        criterionRefs: criterionIds.map((criterionId) => ({ criterionId })),
        dependsOn: [], nodeId: "node-build", resolutionRef,
      },
      {
        authorityKind: "VERIFIER", budgetRefs: [{ budgetId: "budget-delivery" }],
        capabilityId: "capability-web-verify",
        criterionRefs: criterionIds.map((criterionId) => ({ criterionId })),
        dependsOn: [{ nodeId: "node-build" }], nodeId: "node-verify",
        resolutionRef,
      },
    ],
  };
}

function secondCatalog(label: string) {
  const result = createCapabilityCatalogRevision({
    catalogId: `catalog-v2-${label}`, entries: RESOLUTION_MINT_INPUT.catalog.entries,
    lineage: null, revisionId: `catalog-${label}-r1`,
    sourceCommitSha256: digest(`source-commit-${label}`),
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function inputWithSecondResolution(catalogRevisionDigest: string) {
  const value = input();
  const builder = value.nodes[0]!; const verifier = value.nodes[1]!;
  const firstCriteria = ["criterion-login", "criterion-runtime"];
  const secondCriteria = criterionIds.filter((criterionId) => !firstCriteria.includes(criterionId));
  const secondResolutionRef = {
    builderCapabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
    catalogRevisionDigest,
  };
  value.nodes = [
    { ...builder, criterionRefs: firstCriteria.map((criterionId) => ({ criterionId })),
      nodeId: "node-base-build" },
    { ...verifier, criterionRefs: firstCriteria.map((criterionId) => ({ criterionId })),
      dependsOn: [{ nodeId: "node-base-build" }], nodeId: "node-base-verify" },
    { ...builder, criterionRefs: secondCriteria.map((criterionId) => ({ criterionId })),
      dependsOn: [{ nodeId: "node-base-verify" }], nodeId: "node-rest-build",
      resolutionRef: secondResolutionRef },
    { ...verifier, criterionRefs: secondCriteria.map((criterionId) => ({ criterionId })),
      dependsOn: [{ nodeId: "node-rest-build" }], nodeId: "node-rest-verify",
      resolutionRef: secondResolutionRef },
  ];
  return value;
}

function inputWithCriterionResolutions(catalogRevisionDigests: readonly string[]) {
  const value = input(); const builder = value.nodes[0]!; const verifier = value.nodes[1]!;
  const prerequisite: Readonly<Record<string, string>> = {
    "criterion-deployment": "criterion-runtime", "criterion-keyboard": "criterion-login",
    "criterion-latency": "criterion-login", "criterion-session": "criterion-login",
  };
  value.nodes = criterionIds.flatMap((criterionId, index) => {
    const label = criterionId.slice("criterion-".length);
    const resolutionRef = { builderCapabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
      catalogRevisionDigest: catalogRevisionDigests[index]! };
    const prerequisiteId = prerequisite[criterionId];
    return [
      { ...builder, criterionRefs: [{ criterionId }], dependsOn: prerequisiteId === undefined
        ? [] : [{ nodeId: `node-${prerequisiteId.slice("criterion-".length)}-verify` }],
      nodeId: `node-${label}-build`, resolutionRef },
      { ...verifier, criterionRefs: [{ criterionId }],
        dependsOn: [{ nodeId: `node-${label}-build` }], nodeId: `node-${label}-verify`,
        resolutionRef },
    ];
  });
  return value;
}

describe("compileV2Dag", () => {
  it("accepts a tierless planner graph and rejects planner-supplied policy tier authority", () => {
    const tierless = input();
    expect(compile(tierless).ok).toBe(true);
    const tiered = input();
    (tiered.nodes[0]! as Record<string, unknown>)["riskTier"] = "R2";
    expect(compile(tiered)).toEqual({
      code: "V2_COMPILER_INPUT_MALFORMED", layer: "V2_COMPILER_INPUT", ok: false,
    });
  });

  it("refuses cloned or copied resolution authority", () => {
    const copies = [structuredClone(REAL_TOKEN), { ...REAL_TOKEN }];
    for (const copy of copies) expect(compile(
      input(), [copy as V2CompilerResolutionToken],
    )).toEqual({
      code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
      layer: "V2_COMPILER_CAPABILITY_BINDING", ok: false,
    });
  });

  it("mints an opaque token and re-reads durable status exactly once at compile", () => {
    let statusReads = 0;
    const authority = Object.freeze({
      ...RESOLUTION_MINT_INPUT.qualificationAuthority,
      readDurableQualificationStatus: (binding: {
        qualificationDigest: string; qualificationId: string;
      }) => {
        statusReads += 1;
        return RESOLUTION_MINT_INPUT.qualificationAuthority
          .readDurableQualificationStatus(binding);
      },
    });
    const compiler = createCompiler(authority);
    const minted = compiler.mintResolutionToken(
      RESOLUTION_MINT_INPUT.catalog, {
        capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories,
      }, RESOLUTION_MINT_INPUT.materials,
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(statusReads).toBe(1);
    expect(Reflect.ownKeys(minted.token)).toEqual([]);
    expect(Object.isFrozen(minted.token)).toBe(true);
    expect(compiler.compile(input(), [minted.token])).toEqual(compile(input(), [REAL_TOKEN]));
    expect(statusReads).toBe(2);
  });

  it("revalidates qualification at compile and consumes each token once", () => {
    let statusReads = 0;
    const authority = Object.freeze({
      ...RESOLUTION_MINT_INPUT.qualificationAuthority,
      readDurableQualificationStatus: (binding: {
        qualificationDigest: string; qualificationId: string;
      }) => {
        statusReads += 1;
        return RESOLUTION_MINT_INPUT.qualificationAuthority
          .readDurableQualificationStatus(binding);
      },
    });
    const compiler = createCompiler(authority);
    const minted = compiler.mintResolutionToken(
      RESOLUTION_MINT_INPUT.catalog, {
        capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories,
      }, RESOLUTION_MINT_INPUT.materials,
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(compiler.compile(input(), [minted.token]).ok).toBe(true);
    expect(statusReads).toBe(2);
    expect(compiler.compile(input(), [minted.token])).toEqual({
      code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
      layer: "V2_COMPILER_CAPABILITY_BINDING",
      ok: false,
    });
    expect(statusReads).toBe(2);
  });

  it("refuses a token whose durable qualification was revoked after mint", () => {
    let revoked = false;
    const authority = Object.freeze({
      ...RESOLUTION_MINT_INPUT.qualificationAuthority,
      readDurableQualificationStatus: (binding: {
        qualificationDigest: string; qualificationId: string;
      }) => {
        const current = RESOLUTION_MINT_INPUT.qualificationAuthority
          .readDurableQualificationStatus(binding);
        return current === undefined || !revoked ? current : { ...current, status: "REVOKED" as const };
      },
    });
    const compiler = createCompiler(authority);
    const minted = compiler.mintResolutionToken(
      RESOLUTION_MINT_INPUT.catalog, {
        capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories,
      }, RESOLUTION_MINT_INPUT.materials,
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    revoked = true;
    expect(compiler.compile(input(), [minted.token])).toEqual({
      code: "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED",
      layer: "V2_COMPILER_CAPABILITY_BINDING",
      ok: false,
    });
  });

  it("freezes children even when a supplied parent container was already frozen", () => {
    const child = { nodeId: "node-unfrozen" };
    sealCanonicalDag({
      contractBinding: { contractId: "contract", revisionDigest: digest("contract"),
        revisionId: "contract-r1" },
      criteria: [], graphId: "graph", materialDigests: [],
      nodes: Object.freeze([child]) as any,
      qualificationFences: [],
      schedulerAuthority: { canonicalBytesBase64: "AA==", content: {},
        graphContentHash: digest("graph-content"), schemaVersion: 3,
        snapshotIdentity: digest("snapshot") },
    } as any);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("produces a canonical immutable multi-node DAG with exact owner and verifier bindings", () => {
    const value = input(); const result = compile(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dag.nodes).toHaveLength(2);
    expect(result.dag.criteria).toHaveLength(6);
    expect(result.dag.criteria[0]).toMatchObject({
      ownerNodeId: "node-build", verifierNodeId: "node-verify",
    });
    expect(result.graphDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.canonicalBytesBase64.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result.dag)).toBe(true);
    expect(Object.isFrozen(result.dag.nodes)).toBe(true);
    expect(result.dag.nodes.every((node) => !("riskTier" in node))).toBe(true);
    expect(Buffer.from(result.canonicalBytesBase64, "base64").toString("utf8"))
      .not.toContain("riskTier");
    const status = compilerQualificationStatus(
      RESOLUTION_MINT_INPUT.materials.deliveryProfileQualification,
    );
    expect(result.dag.materialDigests).toContainEqual({
      digest: status.statusDigest,
      kind: "DELIVERY_PROFILE_QUALIFICATION_STATUS",
      ref: materialIdentity("DELIVERY_PROFILE_QUALIFICATION_STATUS", [
        status.statusRef, status.statusDigest,
      ]),
    });
    expect(result.dag.nodes.every((node) => node.verificationRecipes.length > 0)).toBe(true);
    expect(result.dag.nodes.every((node) =>
      node.materialBinding.deliveryProfileQualificationStatusDigest
        === status.statusDigest)).toBe(true);

    const reordered = input();
    reordered.nodes.reverse();
    reordered.nodes[0]!.criterionRefs.reverse();
    expect(compile(reordered)).toEqual(result);
  });

  it("preserves a valid transitive requirement-owner chain", () => {
    const value = input(contract(true));
    value.nodes[0]!.criterionRefs = [
      { criterionId: "criterion-deployment" }, { criterionId: "criterion-keyboard" },
      { criterionId: "criterion-latency" }, { criterionId: "criterion-session" },
    ];
    value.nodes[0]!.dependsOn = [{ nodeId: "node-runtime-verify" }];
    const base = {
      ...value.nodes[0]!, criterionRefs: [{ criterionId: "criterion-login" }],
      dependsOn: [], nodeId: "node-base",
    };
    const baseVerifier = {
      ...value.nodes[1]!, criterionRefs: [{ criterionId: "criterion-login" }],
      dependsOn: [{ nodeId: "node-base" }], nodeId: "node-base-verify",
    };
    const runtime = {
      ...value.nodes[0]!, criterionRefs: [{ criterionId: "criterion-runtime" }],
      dependsOn: [{ nodeId: "node-base-verify" }], nodeId: "node-runtime",
    };
    const runtimeVerifier = {
      ...value.nodes[1]!, criterionRefs: [{ criterionId: "criterion-runtime" }],
      dependsOn: [{ nodeId: "node-runtime" }], nodeId: "node-runtime-verify",
    };
    value.nodes.splice(1, 0, base, baseVerifier, runtime, runtimeVerifier);
    value.nodes[5]!.criterionRefs = [...value.nodes[0]!.criterionRefs];
    value.nodes[5]!.dependsOn = [{ nodeId: "node-build" }];
    const result = compile(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dag.nodes).toHaveLength(6);
    expect(result.dag.nodes.find((node) => node.nodeId === "node-build")?.dependsOn)
      .toEqual([{ nodeId: "node-runtime-verify" }]);
  });

  it("orders canonical identifiers by UTF-16 code units, including Z before a", () => {
    const value = input();
    value.nodes[0]!.nodeId = "Z-builder";
    value.nodes[1]!.nodeId = "a-verifier";
    value.nodes[1]!.dependsOn = [{ nodeId: "Z-builder" }];
    const result = compile(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dag.nodes.map((node) => node.nodeId)).toEqual(["Z-builder", "a-verifier"]);
    expect(result.dag.criteria[0]).toMatchObject({
      ownerNodeId: "Z-builder", verifierNodeId: "a-verifier",
    });
  });

  it("refuses scheduler-incompatible node identifiers", () => {
    const value = input();
    value.nodes[0]!.nodeId = "node build";
    value.nodes[1]!.dependsOn = [{ nodeId: "node build" }];
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_INPUT_MALFORMED", layer: "V2_COMPILER_INPUT", ok: false,
    });
  });

  it.each([
    ["graph", (value: ReturnType<typeof input>) => { value.graphId = "graph id"; }],
    ["capability", (value: ReturnType<typeof input>) => {
      value.nodes[0]!.capabilityId = "capability id";
    }],
  ])("refuses a scheduler-incompatible %s identifier", (_name, mutate) => {
    const value = input(); mutate(value);
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_INPUT_MALFORMED", layer: "V2_COMPILER_INPUT", ok: false,
    });
  });

  it("refuses more than the scheduler absolute node ceiling before coverage", () => {
    const value = input();
    const builder = value.nodes[0]!; const verifier = value.nodes[1]!;
    value.nodes = Array.from({ length: 65 }, (_, index) => ({
      ...(index % 2 === 0 ? builder : verifier),
      dependsOn: index === 0 ? [] : [{ nodeId: `node-${index - 1}` }],
      nodeId: `node-${index}`,
    }));
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_GRAPH_LIMIT_EXCEEDED", layer: "V2_COMPILER_TOPOLOGY", ok: false,
    });
  });

  it("refuses more than the scheduler absolute hard-edge ceiling before coverage", () => {
    const value = input();
    const builder = value.nodes[0]!; const verifier = value.nodes[1]!;
    value.nodes = Array.from({ length: 64 }, (_, index) => ({
      ...(index % 2 === 0 ? builder : verifier),
      dependsOn: Array.from({ length: index }, (_unused, producer) => ({
        nodeId: `node-${producer}`,
      })),
      nodeId: `node-${index}`,
    }));
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_GRAPH_LIMIT_EXCEEDED", layer: "V2_COMPILER_TOPOLOGY", ok: false,
    });
  });

  it("requires a dependent requirement builder to wait for prerequisite verification", () => {
    const value = input(contract(true));
    const builder = value.nodes[0]!; const verifier = value.nodes[1]!;
    value.nodes = [
      { ...builder, criterionRefs: [
        { criterionId: "criterion-login" }, { criterionId: "criterion-session" },
      ], dependsOn: [], nodeId: "node-base-build" },
      { ...verifier, criterionRefs: [
        { criterionId: "criterion-login" }, { criterionId: "criterion-session" },
      ], dependsOn: [{ nodeId: "node-base-build" }], nodeId: "node-base-verify" },
      { ...builder, criterionRefs: [{ criterionId: "criterion-runtime" }],
        dependsOn: [{ nodeId: "node-base-build" }], nodeId: "node-runtime-build" },
      { ...verifier, criterionRefs: [{ criterionId: "criterion-runtime" }],
        dependsOn: [{ nodeId: "node-runtime-build" }], nodeId: "node-runtime-verify" },
      { ...builder, criterionRefs: [
        { criterionId: "criterion-deployment" }, { criterionId: "criterion-keyboard" },
        { criterionId: "criterion-latency" },
      ], dependsOn: [{ nodeId: "node-runtime-build" }], nodeId: "node-rest-build" },
      { ...verifier, criterionRefs: [
        { criterionId: "criterion-deployment" }, { criterionId: "criterion-keyboard" },
        { criterionId: "criterion-latency" },
      ], dependsOn: [{ nodeId: "node-rest-build" }], nodeId: "node-rest-verify" },
    ];
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_REQUIREMENT_ORDER_INVALID",
      layer: "V2_COMPILER_TOPOLOGY", ok: false,
    });
  });

  it.each([
    ["omits", false],
    ["reverses", true],
  ])("refuses a graph that %s contract requirement ordering", (_name, reversed) => {
    const value = input();
    value.nodes[0]!.criterionRefs = [
      { criterionId: "criterion-deployment" }, { criterionId: "criterion-keyboard" },
      { criterionId: "criterion-latency" }, { criterionId: "criterion-session" },
    ];
    const prerequisite = {
      ...value.nodes[0]!, criterionRefs: [
        { criterionId: "criterion-login" }, { criterionId: "criterion-runtime" },
      ], dependsOn: reversed ? [{ nodeId: "node-build" }] : [], nodeId: "node-prerequisite",
    };
    value.nodes.splice(1, 0, prerequisite);
    value.nodes[2]!.dependsOn = [{ nodeId: "node-build" }, { nodeId: "node-prerequisite" }];
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_REQUIREMENT_ORDER_INVALID",
      layer: "V2_COMPILER_TOPOLOGY",
      ok: false,
    });
  });

  it("refuses a plain fabricated CURRENT-status token", () => {
    const fabricated = Object.freeze({
      deliveryProfileQualificationStatus: compilerQualificationStatus(
        RESOLUTION_MINT_INPUT.materials.deliveryProfileQualification,
      ),
    }) as unknown as V2CompilerResolutionToken;
    expect(compile(input(), [fabricated])).toEqual({
      code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
      layer: "V2_COMPILER_CAPABILITY_BINDING", ok: false,
    });
  });

  it("refuses transport-embedded resolution facts", () => {
    const value = { ...input(), resolutionFacts: [{ status: "CURRENT" }] };
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_INPUT_MALFORMED", layer: "V2_COMPILER_INPUT", ok: false,
    });
  });

  it("rejects duplicate minted token authority", () => {
    expect(compile(input(), [REAL_TOKEN, REAL_TOKEN])).toEqual({
      code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
      layer: "V2_COMPILER_CAPABILITY_BINDING", ok: false,
    });
  });

  it.each([
    ["empty graph", (value: ReturnType<typeof input>) => { value.nodes = []; },
      "V2_COMPILER_GRAPH_EMPTY", "V2_COMPILER_TOPOLOGY"],
    ["duplicate node", (value: ReturnType<typeof input>) => {
      value.nodes.push({ ...value.nodes[0]! });
    }, "V2_COMPILER_NODE_DUPLICATE", "V2_COMPILER_TOPOLOGY"],
    ["duplicate dependency", (value: ReturnType<typeof input>) => {
      value.nodes[1]!.dependsOn.push({ nodeId: "node-build" });
    }, "V2_COMPILER_DEPENDENCY_DUPLICATE", "V2_COMPILER_TOPOLOGY"],
    ["prose dependency", (value: ReturnType<typeof input>) => {
      value.nodes[1]!.dependsOn = ["node-build"] as any;
    }, "V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT"],
    ["unknown dependency", (value: ReturnType<typeof input>) => {
      value.nodes[1]!.dependsOn = [{ nodeId: "node-ghost" }];
    }, "V2_COMPILER_DEPENDENCY_UNKNOWN", "V2_COMPILER_TOPOLOGY"],
    ["self dependency", (value: ReturnType<typeof input>) => {
      value.nodes[1]!.dependsOn = [{ nodeId: "node-verify" }];
    }, "V2_COMPILER_DEPENDENCY_SELF", "V2_COMPILER_TOPOLOGY"],
    ["cycle", (value: ReturnType<typeof input>) => {
      value.nodes[0]!.dependsOn = [{ nodeId: "node-verify" }];
    }, "V2_COMPILER_GRAPH_CYCLE", "V2_COMPILER_TOPOLOGY"],
    ["planner risk tier", (value: ReturnType<typeof input>) => {
      (value.nodes[0]! as Record<string, unknown>)["riskTier"] = "R9";
    }, "V2_COMPILER_INPUT_MALFORMED", "V2_COMPILER_INPUT"],
    ["missing node budget", (value: ReturnType<typeof input>) => {
      value.nodes[0]!.budgetRefs = [];
    }, "V2_COMPILER_BUDGET_MISSING", "V2_COMPILER_BUDGET"],
    ["unknown budget", (value: ReturnType<typeof input>) => {
      value.nodes[0]!.budgetRefs = [{ budgetId: "budget-ghost" }];
    }, "V2_COMPILER_BUDGET_INVALID", "V2_COMPILER_BUDGET"],
    ["unknown criterion", (value: ReturnType<typeof input>) => {
      value.nodes[0]!.criterionRefs.push({ criterionId: "criterion-ghost" });
    }, "V2_COMPILER_CRITERION_UNKNOWN", "V2_COMPILER_COVERAGE"],
    ["owner missing", (value: ReturnType<typeof input>) => {
      value.nodes[0]!.criterionRefs = value.nodes[0]!.criterionRefs.slice(1);
    }, "V2_COMPILER_CRITERION_OWNER_MISSING", "V2_COMPILER_COVERAGE"],
    ["owner duplicated in one node", (value: ReturnType<typeof input>) => {
      value.nodes[0]!.criterionRefs.push({ criterionId: criterionIds[0]! });
    }, "V2_COMPILER_CRITERION_OWNER_MULTIPLE", "V2_COMPILER_COVERAGE"],
    ["owner multiply covered", (value: ReturnType<typeof input>) => {
      value.nodes.push({
        ...value.nodes[0]!, criterionRefs: [{ criterionId: criterionIds[0]! }],
        nodeId: "node-build-two",
      });
    }, "V2_COMPILER_CRITERION_OWNER_MULTIPLE", "V2_COMPILER_COVERAGE"],
    ["verifier missing", (value: ReturnType<typeof input>) => {
      value.nodes[1]!.criterionRefs = value.nodes[1]!.criterionRefs.slice(1);
    }, "V2_COMPILER_CRITERION_VERIFIER_MISSING", "V2_COMPILER_COVERAGE"],
    ["verifier duplicated in one node", (value: ReturnType<typeof input>) => {
      value.nodes[1]!.criterionRefs.push({ criterionId: criterionIds[0]! });
    }, "V2_COMPILER_CRITERION_VERIFIER_MULTIPLE", "V2_COMPILER_COVERAGE"],
    ["verifier multiply covered", (value: ReturnType<typeof input>) => {
      value.nodes.push({
        ...value.nodes[1]!, criterionRefs: [{ criterionId: criterionIds[0]! }],
        nodeId: "node-verify-two",
      });
    }, "V2_COMPILER_CRITERION_VERIFIER_MULTIPLE", "V2_COMPILER_COVERAGE"],
    ["verifier unordered", (value: ReturnType<typeof input>) => {
      value.nodes[1]!.dependsOn = [];
    }, "V2_COMPILER_VERIFIER_ORDER_INVALID", "V2_COMPILER_COVERAGE"],
  ])("refuses %s at the exact named fence", (_name, mutate, code, layer) => {
    const value = input();
    mutate(value);
    expect(compile(value)).toEqual({ code, layer, ok: false });
  });

  it("refuses a digest-mutated contract rather than compiling advisory lookalike bytes", () => {
    const value = input();
    value.contract = { ...value.contract, revisionDigest: digest("forged-contract") };
    expect(compile(value)).toEqual({
      code: "V2_COMPILER_CONTRACT_INVALID", layer: "V2_COMPILER_CONTRACT", ok: false,
    });
  });

  it("snapshots hostile values without executing accessors or throwing", () => {
    let reads = 0;
    const accessor = input() as Record<string, unknown>;
    Object.defineProperty(accessor, "nodes", {
      enumerable: true, get: () => { reads += 1; throw new Error("must not execute"); },
    });
    expect(compile(accessor)).toEqual({
      code: "V2_COMPILER_INPUT_MALFORMED", layer: "V2_COMPILER_INPUT", ok: false,
    });
    expect(reads).toBe(0);

    const cyclic = input() as Record<string, unknown>;
    cyclic["cycle"] = cyclic;
    expect(compile(cyclic)).toEqual({
      code: "V2_COMPILER_INPUT_MALFORMED", layer: "V2_COMPILER_INPUT", ok: false,
    });
    const hostile = new Proxy(input(), { ownKeys: () => { throw new Error("proxy trap"); } });
    expect(() => compile(hostile)).not.toThrow();
    expect(compile(hostile)).toEqual({
      code: "V2_COMPILER_INPUT_MALFORMED", layer: "V2_COMPILER_INPUT", ok: false,
    });
  });

  it("embeds the exact admitted Scheduler GraphContent bytes and catalog authority", () => {
    const result = compileWithAuthority(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authority = result.dag.schedulerAuthority;
    const bytes = Buffer.from(authority.canonicalBytesBase64, "base64");
    const decoded = decodeGraphContent(new Uint8Array(bytes));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.graphContentHash).toBe(authority.graphContentHash);
    expect(decoded.value.snapshotIdentity).toBe(authority.snapshotIdentity);
    expect(decoded.value.content).toEqual(authority.content);
    expect(authority.content.nodeAuthority.definitions).toHaveLength(2);
    const status = compilerQualificationStatus(
      RESOLUTION_MINT_INPUT.materials.deliveryProfileQualification,
    );
    expect(result.dag.qualificationFences).toEqual([{
      qualificationDigest:
        RESOLUTION_MINT_INPUT.materials.deliveryProfileQualification.qualificationDigest,
      qualificationId:
        RESOLUTION_MINT_INPUT.materials.deliveryProfileQualification.qualificationId,
      statusDigest: status.statusDigest, statusRef: status.statusRef,
    }]);
    const builder = authority.content.nodeAuthority.definitions.find(
      (definition) => definition.nodeKey === "node-build",
    )!;
    const catalog = RESOLUTION_MINT_INPUT.catalog.entries.find(
      (entry) => entry.capabilityId === "capability-web-build",
    )!;
    const compiledBuilder = result.dag.nodes.find((node) => node.nodeId === "node-build")!;
    expect(builder.capability).toBe(catalog.capabilityId);
    expect(builder.readScopes).toEqual(catalog.readScopes);
    expect(builder.writeScopes).toEqual(catalog.writeScopes);
    expect(builder.resources).toHaveLength(catalog.resourceScopes.length + catalog.roles.length
      + catalog.requiredImageDigests.length + catalog.requiredToolDigests.length + 1);
    expect(builder.resources.every((value) => value.startsWith("moe.v2."))).toBe(true);
    expect(builder.resources).toContain(qualifiedIdentity("build-recipe", [
      compiledBuilder.buildRecipe!.recipeRef, compiledBuilder.buildRecipe!.recipeDigest,
      compiledBuilder.buildRecipe!.toolRef, ...compiledBuilder.buildRecipe!.argv,
    ]));
    expect(builder.verificationRecipeRevisions).toEqual(catalog.verificationRecipeRevisions.map(
      (recipe) => qualifiedIdentity("verification-recipe", [
        "verify-builder", recipe.recipeRevisionId, recipe.recipeRevisionDigest,
      ]),
    ));
    const material = compiledBuilder.materialBinding;
    expect(builder.admissionAmounts).toEqual([
      { meter: "attempt.count", purpose: "EXECUTION", quantity: 1 },
    ]);
    expect(builder.admissionGatePolicy).toBe("POLICY_ALLOWANCE");
    expect(builder.objective).toBe("Execute builder node-build for contract-v2@contract-v2-r1.");
    expect(builder.policySliceHash).toBe(authority.content.policyRevision);
    expect(builder.constraints).toEqual([
      qualifiedIdentity("contract-constraint", ["contract-v2", "contract-v2-r1",
        result.dag.contractBinding.revisionDigest]),
      qualifiedIdentity("budget-constraint", ["budget-delivery", "TIME", "30", "days"]),
      qualifiedIdentity("criteria-constraint", result.dag.criteria.flatMap((criterion) => [
        criterion.category, criterion.criterionId, criterion.requirementId,
        criterion.statement, criterion.verification,
      ])),
      qualifiedIdentity("node-intent-constraint", ["graph-v2-r1", "node-build", "BUILDER",
        "capability-web-build", material.catalogRevisionDigest,
        material.deliveryProfileQualificationDigest,
        material.deliveryProfileQualificationStatusDigest,
        material.deliveryProfileRevisionDigest, material.executionIsolationProfileRevisionDigest,
        material.sourceSnapshotDigest]),
    ].sort());
    const canonicalDag = Buffer.from(result.canonicalBytesBase64, "base64").toString("utf8");
    expect(canonicalDag).toContain(authority.graphContentHash);
    expect(canonicalDag).toContain(authority.canonicalBytesBase64);
  });

  it.each([
    ["author", (value: ReturnType<typeof compilerGraphAuthority>) => ({
      ...value, author: "principal:changed",
    })],
    ["decomposition budget", (value: ReturnType<typeof compilerGraphAuthority>) => ({
      ...value, decompositionBudget: 63,
    })],
    ["parent revision", (value: ReturnType<typeof compilerGraphAuthority>) => ({
      ...value, parentRevision: "graph:parent",
    })],
    ["policy revision", (value: ReturnType<typeof compilerGraphAuthority>) => ({
      ...value, policyRevision: digest("policy:changed"),
    })],
    ["repository base tree", (value: ReturnType<typeof compilerGraphAuthority>) => ({
      ...value, repositoryBaseTree: digest("changed-base-tree"),
    })],
  ])("binds Scheduler graph-author field %s into both authority and compiler digests",
    (_name, mutate) => {
      const baseline = compileWithAuthority(input());
      const changed = compileWithAuthority(input(), {
        readGraphAuthority: (request) => mutate(compilerGraphAuthority(request)),
      });
      expect(baseline.ok && changed.ok).toBe(true);
      if (!baseline.ok || !changed.ok) return;
      expect(changed.dag.schedulerAuthority.graphContentHash)
        .not.toBe(baseline.dag.schedulerAuthority.graphContentHash);
      expect(changed.graphDigest).not.toBe(baseline.graphDigest);
    });

  it.each([
    ["admission amounts", (body: any) => { body.admissionAmounts[0].quantity += 1; }],
    ["admission gate policy", (body: any) => { body.admissionGatePolicy = "HUMAN_APPROVAL"; }],
    ["constraints", (body: any) => { body.constraints = ["constraint.changed"]; }],
    ["objective", (body: any) => { body.objective = "Changed trusted objective."; }],
    ["policy slice", (body: any) => { body.policySliceHash = digest("changed-policy-slice"); }],
  ])("refuses a NodeDefinition with unrelated %s authority", (_name, mutate) => {
    const result = compileWithAuthority(input(), {
      readNodeDefinition: (request) => {
        const body = structuredClone(compilerNodeDefinition(request)) as NodeDefinition;
        mutate(body as any);
        return body;
      },
    });
    expect(result).toEqual({ code: "V2_COMPILER_NODE_AUTHORITY_INVALID",
      layer: "V2_COMPILER_SCHEDULER_AUTHORITY", ok: false });
  });

  it.each([
    ["dependency contract", (body: any) => {
      if (body.directHardDependencies.length > 0) {
        body.directHardDependencies[0].contract.producer.digest = digest("changed-artifact");
      }
    }],
    ["monotonic proof", (body: any) => {
      if (body.monotonicPredicateProofs.length > 0) {
        body.monotonicPredicateProofs[0].proofRationale = "A different durable monotonic proof.";
      }
    }],
  ])("binds trusted NodeDefinition %s into GraphContent and compiler digest", (_name, mutate) => {
    const baseline = compileWithAuthority(input());
    const changed = compileWithAuthority(input(), {
      readNodeDefinition: (request) => {
        const body = structuredClone(compilerNodeDefinition(request)) as NodeDefinition;
        mutate(body as any);
        return body;
      },
    });
    expect(baseline.ok && changed.ok).toBe(true);
    if (!baseline.ok || !changed.ok) return;
    expect(changed.dag.schedulerAuthority.graphContentHash)
      .not.toBe(baseline.dag.schedulerAuthority.graphContentHash);
    expect(changed.graphDigest).not.toBe(baseline.graphDigest);
  });

  it.each([
    ["capability", (body: any) => { body.capability = "capability-forged"; }],
    ["criterion roster", (body: any) => {
      body.criterionBindings[0].criterionId = "criterion-forged";
    }],
    ["read scope", (body: any) => { body.readScopes = ["packages/forged"]; }],
    ["write scope", (body: any) => { body.writeScopes = ["packages/forged"]; }],
    ["catalog resources roles images or tools", (body: any) => {
      body.resources = ["resource-forged"];
    }],
    ["verification recipes", (body: any) => {
      body.verificationRecipeRevisions = ["recipe-forged"];
    }],
    ["repository base", (body: any) => {
      body.repositoryBaseTree = digest("forged-repository-base");
    }],
    ["completion role", (body: any) => {
      if (body.joinRole === "COMPLETION") {
        body.joinRole = "NONE"; body.completionLinkage = null;
      }
    }],
    ["dependency endpoint", (body: any) => {
      if (body.directHardDependencies.length > 0) {
        body.directHardDependencies[0].contract.producerNodeKey = "node-forged";
      }
    }],
    ["dependency graph binding", (body: any) => {
      if (body.directHardDependencies.length > 0) {
        body.directHardDependencies[0].contract.graphBindingDigest = digest("forged-graph");
      }
    }],
  ])("refuses a trusted-reader NodeDefinition with mismatched %s", (_name, mutate) => {
    const result = compileWithAuthority(input(), {
      readNodeDefinition: (request) => {
        const body = structuredClone(compilerNodeDefinition(request)) as NodeDefinition;
        mutate(body as any);
        return body;
      },
    });
    expect(result).toEqual({ code: "V2_COMPILER_NODE_AUTHORITY_INVALID",
      layer: "V2_COMPILER_SCHEDULER_AUTHORITY", ok: false });
  });

  it("requires server admission authority to acknowledge the exact budget roster", () => {
    const result = compileWithAuthority(input(), { readNodeAdmissionAuthority: (request) => ({
      ...compilerNodeAdmissionAuthority(request),
      budgetBindingDigest: qualifiedIdentity("budget-bindings", ["stale-budget"]),
    }) });
    expect(result).toEqual({ code: "V2_COMPILER_NODE_AUTHORITY_INVALID",
      layer: "V2_COMPILER_SCHEDULER_AUTHORITY", ok: false });
  });

  it("rejects authority-reader proxies without invoking traps", () => {
    let graphTraps = 0;
    const graphResult = compileWithAuthority(input(), { readGraphAuthority: (request) =>
      new Proxy(compilerGraphAuthority(request), { ownKeys: (target) => {
        graphTraps += 1; return Reflect.ownKeys(target);
      } }) });
    expect(graphResult).toEqual({ code: "V2_COMPILER_GRAPH_AUTHORITY_UNAVAILABLE",
      layer: "V2_COMPILER_SCHEDULER_AUTHORITY", ok: false });
    expect(graphTraps).toBe(0);
    let admissionTraps = 0;
    const admissionResult = compileWithAuthority(input(), {
      readNodeAdmissionAuthority: (request) => new Proxy(
        compilerNodeAdmissionAuthority(request), { ownKeys: (target) => {
          admissionTraps += 1; return Reflect.ownKeys(target);
        } },
      ),
    });
    expect(admissionResult).toEqual({ code: "V2_COMPILER_NODE_AUTHORITY_INVALID",
      layer: "V2_COMPILER_SCHEDULER_AUTHORITY", ok: false });
    expect(admissionTraps).toBe(0);
    let nodeTraps = 0;
    const nodeResult = compileWithAuthority(input(), { readNodeDefinition: (request) =>
      new Proxy(compilerNodeDefinition(request), { ownKeys: (target) => {
        nodeTraps += 1; return Reflect.ownKeys(target);
      } }) });
    expect(nodeResult).toEqual({ code: "V2_COMPILER_NODE_AUTHORITY_INVALID",
      layer: "V2_COMPILER_SCHEDULER_AUTHORITY", ok: false });
    expect(nodeTraps).toBe(0);
  });

  it("rejects a proxied token roster without invoking traps", () => {
    const compiler = createCompiler();
    const minted = compiler.mintResolutionToken(RESOLUTION_MINT_INPUT.catalog,
      { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
      RESOLUTION_MINT_INPUT.materials);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    let traps = 0;
    const tokens = new Proxy([minted.token], { getPrototypeOf: (target) => {
      traps += 1; return Reflect.getPrototypeOf(target);
    } });
    expect(compiler.compile(input(), tokens)).toEqual({
      code: "V2_COMPILER_CAPABILITY_UNRESOLVED",
      layer: "V2_COMPILER_CAPABILITY_BINDING", ok: false,
    });
    expect(traps).toBe(0);
  });

  it("adds one deterministic completion join for otherwise independent verifier sinks", () => {
    const value = input(contract(false));
    value.nodes[0]!.criterionRefs = value.nodes[0]!.criterionRefs.filter(
      (item) => item.criterionId !== "criterion-runtime"
        && item.criterionId !== "criterion-deployment",
    );
    value.nodes[1]!.criterionRefs = [...value.nodes[0]!.criterionRefs];
    value.nodes.push({ ...value.nodes[0]!, criterionRefs: [
      { criterionId: "criterion-deployment" }, { criterionId: "criterion-runtime" },
    ],
      dependsOn: [], nodeId: "node-runtime-build" });
    value.nodes.push({ ...value.nodes[1]!, criterionRefs: [
      { criterionId: "criterion-deployment" }, { criterionId: "criterion-runtime" },
    ],
      dependsOn: [{ nodeId: "node-runtime-build" }], nodeId: "node-runtime-verify" });
    const result = compileWithAuthority(value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { snapshot, nodeAuthority } = result.dag.schedulerAuthority.content;
    expect(snapshot.completionNodeKey).toBe("node-runtime-verify");
    expect(nodeAuthority.definitions.filter((body) => body.joinRole === "COMPLETION"))
      .toHaveLength(1);
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      consumerNodeKey: "node-runtime-verify", kind: "HARD",
      producerNodeKey: "node-verify",
    }));
    expect(snapshot.edges.some(
      (edge) => edge.producerNodeKey === snapshot.completionNodeKey,
    )).toBe(false);
  });

  it("uses collision-resistant ASCII length-framed identities", () => {
    const left = qualifiedIdentity("material-test", ["a:b", "c"]);
    const right = qualifiedIdentity("material-test", ["a", "b:c"]);
    expect(left).not.toBe(right);
    expect(left).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._:@/+~-]*$/u);
    expect(left.length).toBeLessThanOrEqual(128);
  });

  it("rejects separately minted but unused duplicate resolution authority", () => {
    const compiler = createCompiler();
    const minted = [0, 1].map(() => compiler.mintResolutionToken(
      RESOLUTION_MINT_INPUT.catalog, { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
      RESOLUTION_MINT_INPUT.materials,
    ));
    expect(minted.every((item) => item.ok)).toBe(true);
    const first = minted[0]!; const second = minted[1]!;
    if (!first.ok || !second.ok) return;
    expect(compiler.compile(input(), [first.token, second.token])).toEqual({
      code: "V2_COMPILER_MATERIAL_DIGEST_UNBOUND",
      layer: "V2_COMPILER_MATERIAL_BINDING", ok: false,
    });
  });

  it("emits one fence for many used resolutions sharing exact qualification authority", () => {
    const compiler = createCompiler();
    const catalogs = [RESOLUTION_MINT_INPUT.catalog,
      ...Array.from({ length: criterionIds.length - 1 }, (_, index) =>
        secondCatalog(`shared-authority-${index}`))];
    const minted = catalogs.map((catalog) => compiler.mintResolutionToken(catalog,
      { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
      RESOLUTION_MINT_INPUT.materials));
    expect(minted.every((item) => item.ok)).toBe(true);
    if (minted.some((item) => !item.ok)) return;
    const tokens = minted.map((item) => item.ok ? item.token : undefined)
      .filter((token): token is V2CompilerResolutionToken => token !== undefined);
    const result = compiler.compile(inputWithCriterionResolutions(
      catalogs.map((catalog) => catalog.revisionDigest)), tokens);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dag.qualificationFences).toHaveLength(1);
  });

  it("refuses two otherwise valid resolutions with distinct qualification authority", () => {
    const catalog = secondCatalog("distinct-authority");
    const qualificationDraft = structuredClone(
      RESOLUTION_MINT_INPUT.materials.deliveryProfileQualification,
    ) as unknown as Record<string, unknown>;
    delete qualificationDraft["qualificationDigest"]; delete qualificationDraft["version"];
    qualificationDraft["qualificationId"] = "qualification-profile-next-r2";
    const created = createDeliveryProfileQualification(qualificationDraft);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const materials = { ...RESOLUTION_MINT_INPUT.materials,
      deliveryProfileQualification: created.qualification };
    const compiler = createCompiler();
    const first = compiler.mintResolutionToken(RESOLUTION_MINT_INPUT.catalog,
      { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
      RESOLUTION_MINT_INPUT.materials);
    const second = compiler.mintResolutionToken(catalog,
      { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
      materials);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(compiler.compile(inputWithSecondResolution(catalog.revisionDigest),
      [first.token, second.token])).toEqual({
      code: "V2_COMPILER_QUALIFICATION_AUTHORITY_MISMATCH",
      layer: "V2_COMPILER_MATERIAL_BINDING", ok: false,
    });
  });

  it("bounds qualification no-event fence inputs to the store decision-leg ceiling", () => {
    const compiler = createCompiler();
    const tokens: V2CompilerResolutionToken[] = [];
    for (let index = 0; index < 9; index += 1) {
      const minted = compiler.mintResolutionToken(RESOLUTION_MINT_INPUT.catalog,
        { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
          requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
        RESOLUTION_MINT_INPUT.materials);
      expect(minted.ok).toBe(true);
      if (minted.ok) tokens.push(minted.token);
    }
    expect(compiler.compile(input(), tokens)).toEqual({
      code: "V2_COMPILER_QUALIFICATION_FENCE_LIMIT_EXCEEDED",
      layer: "V2_COMPILER_MATERIAL_BINDING", ok: false,
    });
  });

  it("revalidates qualification expiry using the factory clock", () => {
    let now = 1_500;
    const compiler = createCompiler(RESOLUTION_MINT_INPUT.qualificationAuthority,
      { clock: () => now });
    const minted = compiler.mintResolutionToken(RESOLUTION_MINT_INPUT.catalog,
      { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
      RESOLUTION_MINT_INPUT.materials);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    now = 2_000;
    expect(compiler.compile(input(), [minted.token])).toEqual({
      code: "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED",
      layer: "V2_COMPILER_CAPABILITY_BINDING", ok: false,
    });
  });

  it("revalidates durable status after scheduler authority assembly and before sealing", () => {
    let revoked = false; let statusReads = 0;
    const authority = Object.freeze({ ...RESOLUTION_MINT_INPUT.qualificationAuthority,
      readDurableQualificationStatus: (binding: {
        qualificationDigest: string; qualificationId: string;
      }) => {
        statusReads += 1;
        const current = RESOLUTION_MINT_INPUT.qualificationAuthority
          .readDurableQualificationStatus(binding);
        return revoked && current !== undefined
          ? { ...current, status: "REVOKED" as const, statusDigest: digest("revoked-at-seal") }
          : current;
      } });
    const compiler = createCompiler(authority, { readGraphAuthority: (request) => {
      revoked = true; return compilerGraphAuthority(request);
    } });
    const minted = compiler.mintResolutionToken(RESOLUTION_MINT_INPUT.catalog,
      { capabilityId: RESOLUTION_MINT_INPUT.request.capabilityId,
        requiredCriterionCategories: RESOLUTION_MINT_INPUT.request.requiredCriterionCategories },
      RESOLUTION_MINT_INPUT.materials);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(compiler.compile(input(), [minted.token])).toEqual({
      code: "V2_COMPILER_DELIVERY_PROFILE_UNQUALIFIED",
      layer: "V2_COMPILER_CAPABILITY_BINDING", ok: false,
    });
    expect(statusReads).toBe(2);
  });
});
