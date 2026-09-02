import { createAcceptanceCriterionContent, createPlanExecutionContent } from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  NODE_PLANNING_SOURCE_SCHEMA_VERSION,
  createNodePlanningSourceContent,
  decodeNodePlanningSourceContentBytes,
  encodeNodePlanningSourceContent,
} from "./node-planning-source-codec.js";
import { NODE_AUTHORITY_LIMITS } from "./node-authority-contract.js";

const hex = (digit: string): string => digit.repeat(64);

const planContent = () => {
  const created = createPlanExecutionContent({
    affectedCriterionIds: ["criterion-a"],
    affectedNodeIds: ["node-consumer"],
    steps: [{
      description: "Consume the producer artifact.",
      kind: "IMPLEMENTATION",
      stepId: "step-consume",
    }],
    verificationRecipeRefs: ["recipe-a"],
  });
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.content;
};

const criterionContent = () => {
  const created = createAcceptanceCriterionContent({
    nodeKind: "LEAF",
    obligations: [{
      criterionId: "criterion-a",
      evidenceRequirements: [{
        evidenceRef: "artifact-a",
        kind: "ARTIFACT",
        requirementId: "requirement-a",
      }],
      statement: "The consumer uses the sealed producer artifact.",
      verificationRecipeRefs: ["recipe-a"],
    }],
  });
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.content;
};

const predicate = () => ({
  parameterSchema: { digest: hex("1"), kind: "JSON_SCHEMA" },
  predicateRef: "predicate-artifact-sealed",
  proofRationale: "An immutable artifact seal remains sealed.",
  schemaId: "schema-artifact-sealed",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
});

const dependencyContract = () => ({
  alternateProducers: [] as string[],
  alternativeRuling: { kind: "NOT_APPLICABLE", reason: "No alternate producer exists." },
  consumer: {
    contractHash: hex("2"), criterionRef: "criterion-a", kind: "PRECONDITION",
  },
  consumerNodeKey: "node-consumer",
  consumptionHorizon: "RESULT_SEAL",
  edgeKind: "ARTIFACT_CONSUMPTION",
  graphBindingDigest: hex("3"),
  invalidationFacts: [{
    sourceFactDigest: hex("4"), sourceFactRef: "fact-artifact-a", sourceFactVersion: 1,
  }],
  minimumQualifyingMilestone: "RESULT_SEALED",
  necessity: {
    failedConsumerCriterionRef: "criterion-a",
    failureKind: "MISSING_ARTIFACT",
    truthClass: "OBSERVED",
  },
  producer: {
    artifactOrInterfaceRef: "artifact-a", digest: hex("5"), kind: "ARTIFACT_CONSUMPTION",
  },
  producerNodeKey: "node-producer",
  recheckPredicateRef: "predicate-artifact-sealed",
  satisfactionPredicate: {
    parametersDigest: hex("6"),
    predicateRef: "predicate-artifact-sealed",
    schemaId: "schema-artifact-sealed",
    schemaVersion: 1,
  },
  satisfactionWitnesses: [{
    sourceOperationClass: "ARTIFACT_SEAL",
    witnessDigest: hex("7"),
    witnessRef: "witness-artifact-a",
    witnessVersion: 1,
  }],
  stability: "MONOTONIC",
  truthClass: "OBSERVED",
});

const source = () => ({
  acceptanceCriterionContent: criterionContent(),
  directHardDependencies: [{
    edgeKey: "edge-producer-consumer",
    requirement: {
      contract: dependencyContract(),
      edgeKind: "ARTIFACT_CONSUMPTION",
    },
  }],
  planExecutionContent: planContent(),
  predicateRegistry: [predicate()],
});

function accepted(value: unknown = source()) {
  const result = createNodePlanningSourceContent(value);
  if (!result.ok) throw new Error(result.issues.map(
    ({ code, layer }) => `${code}@${layer}`,
  ).join(","));
  return result;
}

const refusal = (value: unknown) => {
  const result = createNodePlanningSourceContent(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected planning-source refusal");
  return result;
};

describe("NodePlanningSourceContent codec", () => {
  it("admits exactly the four graph-free source fields and derives one content identity", () => {
    const result = accepted();

    expect(Object.keys(result.content)).toEqual([
      "acceptanceCriterionContent",
      "directHardDependencies",
      "planExecutionContent",
      "predicateRegistry",
      "version",
    ]);
    expect(result.content.version).toBe(NODE_PLANNING_SOURCE_SCHEMA_VERSION);
    expect(result.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.content.planExecutionContent.affectedNodeIds).toEqual(["node-consumer"]);
    expect(Object.isFrozen(result.content)).toBe(true);
    expect(Object.isFrozen(result.content.directHardDependencies[0]?.requirement)).toBe(true);
  });

  it("round-trips only canonical bytes and recomputes the same digest", () => {
    const created = accepted();
    const encoded = encodeNodePlanningSourceContent(created.content);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeNodePlanningSourceContentBytes(encoded.bytes);
    expect(decoded).toStrictEqual(created);

    const alternate = new TextEncoder().encode(
      `${new TextDecoder().decode(encoded.bytes)} `,
    );
    expect(decodeNodePlanningSourceContentBytes(alternate)).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_NONCANONICAL",
        layer: "NODE_PLANNING_SOURCE_IDENTITY",
      }],
      ok: false,
    });
  });

  it("distinguishes unsupported object and wire schemas from malformed content", () => {
    const content = accepted().content;
    expect(createNodePlanningSourceContent({ ...content, version: 2 })).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_UNSUPPORTED_SCHEMA",
        layer: "NODE_PLANNING_SOURCE_SCHEMA",
      }],
      ok: false,
    });
    const encoded = encodeNodePlanningSourceContent(content);
    if (!encoded.ok) throw new Error("planning source did not encode");
    const envelope = JSON.parse(new TextDecoder().decode(encoded.bytes));
    const foreignWire = new TextEncoder().encode(JSON.stringify({
      ...envelope, schema: "MOE-NODE-PLANNING-SOURCE/2",
    }));
    expect(decodeNodePlanningSourceContentBytes(foreignWire)).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_UNSUPPORTED_SCHEMA",
        layer: "NODE_PLANNING_SOURCE_SCHEMA",
      }],
      ok: false,
    });
  });

  it("refuses oversized dependency text before canonical allocation", () => {
    const sentinel = "x".repeat(NODE_AUTHORITY_LIMITS.maxBytes + 1);
    const value = structuredClone(source()) as any;
    value.directHardDependencies[0].requirement.contract.alternativeRuling.reason = sentinel;
    const stringify = JSON.stringify;
    let sentinelCanonicalizations = 0;
    JSON.stringify = ((input: unknown, ...args: unknown[]) => {
      if (input === sentinel) {
        sentinelCanonicalizations += 1;
        throw new Error("oversized dependency reached canonical allocation");
      }
      return Reflect.apply(stringify, JSON, [input, ...args]) as string | undefined;
    }) as typeof JSON.stringify;
    let result: ReturnType<typeof createNodePlanningSourceContent>;
    try {
      result = createNodePlanningSourceContent(value);
    } finally {
      JSON.stringify = stringify;
    }
    expect(result).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_LIMIT_EXCEEDED",
        layer: "NODE_PLANNING_SOURCE_LIMITS",
      }],
      ok: false,
    });
    expect(sentinelCanonicalizations).toBe(0);
  });

  it.each([
    ["plan", (value: any) => {
      value.planExecutionContent.steps[0].description = "A different admitted action.";
    }],
    ["criteria", (value: any) => {
      value.acceptanceCriterionContent.obligations[0].statement =
        "A different admitted criterion.";
    }],
    ["dependency", (value: any) => {
      value.directHardDependencies[0].requirement.contract.producer.digest = hex("8");
    }],
    ["proof", (value: any) => {
      value.predicateRegistry[0].proofRationale = "A different monotonic proof.";
    }],
  ])("digest-binds %s content", (_name, mutate) => {
    const baseline = accepted();
    const changed = structuredClone(source());
    mutate(changed);
    expect(accepted(changed).sourceDigest).not.toBe(baseline.sourceDigest);
  });

  it("normalizes dependency ordering through the dependency authority", () => {
    const reordered = source();
    reordered.directHardDependencies[0]!.requirement.contract.alternateProducers = [
      "node-z", "node-a",
    ];
    const result = accepted(reordered);
    expect(result.content.directHardDependencies[0]?.requirement.contract.alternateProducers)
      .toEqual(["node-a", "node-z"]);
  });

  it.each([
    ["extra top-level authority", () => ({ ...source(), graphId: "graph-forged" }),
      "NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION"],
    ["caller digest", () => ({ ...source(), sourceDigest: hex("9") }),
      "NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION"],
    ["malformed plan content", () => ({ ...source(), planExecutionContent: {} }),
      "PLAN_REVISION_MALFORMED", "PLAN_EXECUTION_CONTENT"],
    ["malformed acceptance content", () => ({ ...source(), acceptanceCriterionContent: {} }),
      "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CRITERIA_CONTENT"],
    ["multiple affected nodes", () => ({
      ...source(),
      planExecutionContent: {
        ...planContent(), affectedNodeIds: ["node-consumer", "node-forged"],
      },
    }), "NODE_PLANNING_SOURCE_NODE_ROSTER_INVALID", "NODE_PLANNING_SOURCE_ADMISSION"],
    ["noncanonical affected node", () => ({
      ...source(),
      planExecutionContent: { ...planContent(), affectedNodeIds: [" node-consumer "] },
    }), "NODE_PLANNING_SOURCE_NODE_ROSTER_INVALID", "NODE_PLANNING_SOURCE_ADMISSION"],
    ["plan-only verification recipe", () => ({
      ...source(),
      planExecutionContent: {
        ...planContent(), verificationRecipeRefs: ["recipe-a", "recipe-unbound"],
      },
    }), "NODE_PLANNING_SOURCE_RECIPE_MISMATCH", "NODE_PLANNING_SOURCE_ADMISSION"],
    ["unused predicate proof", () => ({
      ...source(), predicateRegistry: [...source().predicateRegistry, {
        ...predicate(), predicateRef: "predicate-unused",
      }],
    }), "NODE_PLANNING_SOURCE_PROOF_ROSTER_INVALID", "NODE_PLANNING_SOURCE_PROOFS"],
    ["advisory direct dependency", () => ({
      ...source(), directHardDependencies: [{
        edgeKey: "edge-advisory", requirement: { edgeKind: "PREFERRED_ORDER" },
      }], predicateRegistry: [],
    }), "NODE_AUTHORITY_FIELD_INVALID", "NODE_AUTHORITY"],
    ["foreign dependency consumer", () => {
      const value = structuredClone(source());
      value.directHardDependencies[0]!.requirement.contract.consumerNodeKey = "node-foreign";
      return value;
    }, "NODE_PLANNING_SOURCE_DEPENDENCY_CONSUMER_MISMATCH",
      "NODE_PLANNING_SOURCE_DEPENDENCIES"],
    ["foreign consumer criterion", () => {
      const value = structuredClone(source());
      value.directHardDependencies[0]!.requirement.contract.consumer.criterionRef =
        "criterion-foreign";
      return value;
    }, "NODE_PLANNING_SOURCE_DEPENDENCY_CRITERIA_MISMATCH",
      "NODE_PLANNING_SOURCE_DEPENDENCIES"],
    ["foreign necessity criterion", () => {
      const value = structuredClone(source());
      value.directHardDependencies[0]!.requirement.contract.necessity
        .failedConsumerCriterionRef = "criterion-foreign";
      return value;
    }, "NODE_PLANNING_SOURCE_DEPENDENCY_CRITERIA_MISMATCH",
      "NODE_PLANNING_SOURCE_DEPENDENCIES"],
  ])("refuses %s", (_name, make, code, layer) => {
    expect(refusal(make()).issues).toEqual([expect.objectContaining({ code, layer })]);
  });

  it("refuses hostile values without invoking accessors or proxy traps", () => {
    let getterReads = 0;
    const accessor = structuredClone(source()) as any;
    Object.defineProperty(accessor.planExecutionContent.steps[0], "description", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "hostile";
      },
    });
    expect(refusal(accessor).issues).toEqual([expect.objectContaining({
      code: "PLAN_REVISION_MALFORMED",
      layer: "PLAN_EXECUTION_CONTENT",
    })]);
    expect(getterReads).toBe(0);

    let proxyTraps = 0;
    const proxied = structuredClone(source());
    proxied.predicateRegistry = new Proxy(proxied.predicateRegistry, {
      ownKeys: (target) => {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(refusal(proxied).issues).toEqual([expect.objectContaining({
      code: "NODE_PLANNING_SOURCE_MALFORMED",
      layer: "NODE_PLANNING_SOURCE_ADMISSION",
    })]);
    expect(proxyTraps).toBe(0);

    let dependencyReads = 0;
    const dependencyAccessor = structuredClone(source());
    Object.defineProperty(dependencyAccessor.directHardDependencies, "0", {
      enumerable: true,
      get: () => {
        dependencyReads += 1;
        return source().directHardDependencies[0];
      },
    });
    expect(refusal(dependencyAccessor).issues).toEqual([expect.objectContaining({
      code: "NODE_AUTHORITY_MALFORMED",
      layer: "NODE_AUTHORITY",
    })]);
    expect(dependencyReads).toBe(0);

    let dependencyProxyTraps = 0;
    const dependencyProxy = structuredClone(source());
    dependencyProxy.directHardDependencies = new Proxy(
      dependencyProxy.directHardDependencies,
      { ownKeys: (target) => {
        dependencyProxyTraps += 1;
        return Reflect.ownKeys(target);
      } },
    );
    expect(refusal(dependencyProxy).issues).toEqual([expect.objectContaining({
      code: "NODE_AUTHORITY_FIELD_INVALID",
      layer: "NODE_AUTHORITY",
    })]);
    expect(dependencyProxyTraps).toBe(0);

    const sparseDependencies = structuredClone(source());
    delete sparseDependencies.directHardDependencies[0];
    expect(refusal(sparseDependencies).issues).toEqual([expect.objectContaining({
      code: "NODE_AUTHORITY_MALFORMED",
      layer: "NODE_AUTHORITY",
    })]);

    const sparseRegistry = structuredClone(source());
    delete sparseRegistry.predicateRegistry[0];
    expect(refusal(sparseRegistry).issues).toEqual([expect.objectContaining({
      code: "NODE_PLANNING_SOURCE_MALFORMED",
      layer: "NODE_PLANNING_SOURCE_ADMISSION",
    })]);

    const coreRefusal = refusal({ ...source(), planExecutionContent: {} });
    expect(Object.keys(coreRefusal.issues[0]!).sort()).toEqual(["code", "layer", "message"]);
  });
});
