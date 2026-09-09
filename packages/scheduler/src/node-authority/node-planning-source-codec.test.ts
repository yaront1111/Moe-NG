import { createAcceptanceCriterionContent, createPlanExecutionContent } from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  NODE_PLANNING_SOURCE_SCHEMA_VERSION,
  NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION,
  createNodePlanningSourceContent,
  decodeNodePlanningSourceContentBytes,
  encodeNodePlanningSourceContent,
} from "./node-planning-source-codec.js";
import { NODE_AUTHORITY_LIMITS } from "./node-authority-contract.js";
import { sameNodePlanningSourceBytes } from "./node-planning-source-format.js";

const hex = (digit: string): string => digit.repeat(64);

/**
 * Captured from this fixture BEFORE the declaration member existed, so it is a
 * pre-change golden rather than a re-grading of whatever the code now produces.
 * A source that declares nothing must keep exactly this identity forever: every
 * stored planning-source revision digest is derived from it.
 */
const LEGACY_SOURCE_DIGEST =
  "e02e1dde54e8ea5f5cdf02d084b0095885f8d48f709879e6c41a6e6da82b4c51";

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
    // The UNDECLARED version, not the module's current one: this fixture states no
    // declaration, and version is chosen by content. Reading the current constant
    // here would promote every legacy source the moment the module version moves.
    expect(result.content.version).toBe(NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION);
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
    // 3, not 2: version 2 is now the DECLARING schema and a stated 2 over a
    // declaration-free content is a MISMATCH, asserted by its own arm below. This
    // arm keeps testing the genuinely unsupported case, which 3 still is.
    expect(createNodePlanningSourceContent({ ...content, version: 3 })).toMatchObject({
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
      ...envelope, schema: "MOE-NODE-PLANNING-SOURCE/3",
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

/**
 * The migration declaration one layer up from the node authority. Every arm here
 * exists because the authored source is the ONLY place a declaration can be stated:
 * `readDeclaredMigrations` (node-authority-fields.ts:98-118) can refuse a bad one,
 * but nothing below this layer can notice a good one that was never carried.
 */
describe("NodePlanningSourceContent declared migrations", () => {
  const declaring = (identifiers: readonly string[]) => ({
    ...source(), declaredMigrations: [...identifiers],
  });

  it("leaves a source that declares nothing byte-identical and version-1", () => {
    const created = accepted();

    // ABSENT, not `[]`. A defaulted empty list would mint a declaration nobody
    // authored AND move the digest of every source already in the store.
    expect("declaredMigrations" in created.content).toBe(false);
    expect(Object.keys(created.content)).toEqual([
      "acceptanceCriterionContent",
      "directHardDependencies",
      "planExecutionContent",
      "predicateRegistry",
      "version",
    ]);
    expect(created.content.version).toBe(NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION);
    // The historical value, pinned as a literal: a later bump of the module's
    // current version must not promote a source that declares nothing.
    expect(created.content.version).toBe(1);
    // The v1 wire, byte for byte: the same four envelope keys and the same tag it
    // has always carried, with the digest fixed against a pre-change capture.
    const encoded = encodeNodePlanningSourceContent(created.content);
    if (!encoded.ok) throw new Error("planning source did not encode");
    const envelope = JSON.parse(new TextDecoder().decode(encoded.bytes));
    expect(Object.keys(envelope).sort()).toEqual([
      "acceptanceCriterionContentBytesBase64",
      "dependencyContentBytesBase64",
      "planExecutionContentBytesBase64",
      "schema",
    ]);
    expect(envelope.schema).toBe("MOE-NODE-PLANNING-SOURCE/1");
    expect(created.sourceDigest).toBe(LEGACY_SOURCE_DIGEST);

    // AND THE DECODE SIDE, which the encode assertions above cannot see. A
    // reconstruction that defaults the member to `[]` re-admits at version 2 with a
    // v2 digest, so without this the whole arm is blind to the single most likely
    // well-meaning refactor — measured, not assumed: the mutation drill for it first
    // red-lined a DIFFERENT arm, which is what proved the gap.
    const decoded = decodeNodePlanningSourceContentBytes(encoded.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect("declaredMigrations" in decoded.content).toBe(false);
    expect(decoded.content.version).toBe(NODE_PLANNING_SOURCE_UNDECLARED_SCHEMA_VERSION);
    expect(decoded.sourceDigest).toBe(LEGACY_SOURCE_DIGEST);
  });

  it("round-trips two identifiers by value, by count and in authored order", () => {
    const created = accepted(declaring(["migration-b", "migration-a"]));

    // AUTHORED ORDER, not sorted and not set-compared: the landed authority
    // preserves order as content (node-authority-fields.ts:93-96), so `b` before
    // `a` is a different declaration from `a` before `b`, and a path that keeps
    // only the first entry passes every single-identifier fixture.
    expect(created.content.declaredMigrations).toEqual(["migration-b", "migration-a"]);
    expect(created.content.declaredMigrations?.length).toBe(2);
    expect(created.content.version).toBe(NODE_PLANNING_SOURCE_SCHEMA_VERSION);
    expect(created.content.version).toBe(2);

    const encoded = encodeNodePlanningSourceContent(created.content);
    if (!encoded.ok) throw new Error("declaring planning source did not encode");
    const decoded = decodeNodePlanningSourceContentBytes(encoded.bytes);
    expect(decoded).toStrictEqual(created);
    if (!decoded.ok) return;
    expect(decoded.content.declaredMigrations).toEqual(["migration-b", "migration-a"]);
    expect(accepted(declaring(["migration-a", "migration-b"])).sourceDigest)
      .not.toBe(created.sourceDigest);
  });

  it("keeps an explicit empty declaration distinct from an absent one", () => {
    const empty = accepted(declaring([]));

    expect("declaredMigrations" in empty.content).toBe(true);
    expect(empty.content.declaredMigrations).toEqual([]);
    expect(empty.content.version).toBe(2);
    expect(empty.sourceDigest).not.toBe(accepted().sourceDigest);
    const encoded = encodeNodePlanningSourceContent(empty.content);
    if (!encoded.ok) throw new Error("empty declaration did not encode");
    const envelope = JSON.parse(new TextDecoder().decode(encoded.bytes));
    expect(envelope.schema).toBe("MOE-NODE-PLANNING-SOURCE/2");
    expect(Object.hasOwn(envelope, "declaredMigrationsBytesBase64")).toBe(true);
  });

  it.each([
    ["a non-list declaration", () => ({ ...source(), declaredMigrations: "migration-a" }),
      "NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations is not a list"],
    ["a noncanonical entry", () => ({ ...source(), declaredMigrations: [" migration-a "] }),
      "NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations holds an inadmissible entry"],
    ["a non-string entry", () => ({ ...source(), declaredMigrations: [1] }),
      "NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations holds an inadmissible entry"],
    ["a duplicated identifier", () => declaring(["migration-a", "migration-a"]),
      "NODE_PLANNING_SOURCE_DUPLICATE_MIGRATION", "NODE_PLANNING_SOURCE_ADMISSION",
      "declaredMigrations states one identifier twice"],
    ["an over-bound declaration", () => declaring(Array.from(
      { length: NODE_AUTHORITY_LIMITS.maxMigrationEntries + 1 },
      (_unused, index) => `migration-${index}`,
    )), "NODE_PLANNING_SOURCE_LIMIT_EXCEEDED", "NODE_PLANNING_SOURCE_LIMITS",
      "declaredMigrations exceeds its bound"],
    ["an unknown key beside the declaration", () => ({
      ...declaring(["migration-a"]), graphId: "graph-forged",
    }), "NODE_PLANNING_SOURCE_MALFORMED", "NODE_PLANNING_SOURCE_ADMISSION",
      "planning source is not an exact source record"],
  ])("refuses %s at the source layer, not the authority layer",
    (_name, make, code, layer, message) => {
      // THE LAYER IS THE POINT. Both layers can call a declaration bad; an arm that
      // pins only the code cannot tell which one answered, and the source layer is
      // the one that has to, because the authority never sees an unadmitted source.
      //
      // THE MESSAGE IS PINNED FOR THE SAME REASON ONE LEVEL DOWN. Before this row
      // the exact-key roster refused `declaredMigrations` as an UNRECOGNISED KEY
      // with the very code and layer four of these cases expect, so a code-and-layer
      // arm alone stays green whether the member is admitted-then-refused or never
      // admitted at all — the roster-widening half of the change would be untested.
      expect(refusal(make()).issues).toEqual([{ code, layer, message }]);
    });

  it("refuses a stated version the content does not imply, either way", () => {
    // The version is chosen by CONTENT, never stated by a caller — the pattern the
    // landed authority codec uses at node-authority-codec.ts:127-128. A caller that
    // could state it could frame a declaring source with the old tag.
    expect(createNodePlanningSourceContent({
      ...accepted().content, version: 2,
    })).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_SCHEMA_MISMATCH",
        layer: "NODE_PLANNING_SOURCE_SCHEMA",
      }],
      ok: false,
    });
    expect(createNodePlanningSourceContent({
      ...accepted(declaring(["migration-a"])).content, version: 1,
    })).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_SCHEMA_MISMATCH",
        layer: "NODE_PLANNING_SOURCE_SCHEMA",
      }],
      ok: false,
    });
  });

  it("refuses a wire whose schema tag disagrees with its envelope roster", () => {
    const legacy = encodeNodePlanningSourceContent(accepted().content);
    if (!legacy.ok) throw new Error("planning source did not encode");
    const envelope = JSON.parse(new TextDecoder().decode(legacy.bytes));
    // A v2 tag over a v1 envelope: the declaration key is the whole reason the
    // version moved, so a tag that claims v2 without one is not merely
    // noncanonical, it is a schema the reader must name.
    expect(decodeNodePlanningSourceContentBytes(new TextEncoder().encode(JSON.stringify({
      ...envelope, schema: "MOE-NODE-PLANNING-SOURCE/2",
    })))).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_SCHEMA_MISMATCH",
        layer: "NODE_PLANNING_SOURCE_SCHEMA",
      }],
      ok: false,
    });
    expect(decodeNodePlanningSourceContentBytes(new TextEncoder().encode(JSON.stringify({
      ...envelope, schema: "MOE-NODE-PLANNING-SOURCE/3",
    })))).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_UNSUPPORTED_SCHEMA",
        layer: "NODE_PLANNING_SOURCE_SCHEMA",
      }],
      ok: false,
    });
  });

  it("keeps sameNodePlanningSourceBytes answering across the declaration", () => {
    const bytesOf = (value: unknown) => {
      const encoded = encodeNodePlanningSourceContent(accepted(value).content);
      if (!encoded.ok) throw new Error("planning source did not encode");
      return encoded.bytes;
    };
    const declared = bytesOf(declaring(["migration-a", "migration-b"]));

    expect(sameNodePlanningSourceBytes(
      declared, bytesOf(declaring(["migration-a", "migration-b"])),
    )).toBe(true);
    expect(sameNodePlanningSourceBytes(
      declared, bytesOf(declaring(["migration-b", "migration-a"])),
    )).toBe(false);
    // Declared-none is not absent, and the comparator must not blur them.
    expect(sameNodePlanningSourceBytes(bytesOf(declaring([])), bytesOf(source()))).toBe(false);
  });
});
