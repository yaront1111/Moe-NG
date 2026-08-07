import { describe, expect, it } from "vitest";
import {
  validateDependencyContract,
  type DependencyContract,
  type DependencyRequirement,
  type MonotonicPredicateRegistryEntry,
} from "./dependency-contract.js";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const registryEntry: MonotonicPredicateRegistryEntry = {
  predicateRef: "predicate:artifact-present",
  schemaId: "moe.predicate.artifact-present",
  schemaVersion: 1,
  parameterSchema: { kind: "JSON_SCHEMA", digest: DIGEST_A },
  sourceOperationClass: "ARTIFACT_SEAL",
  proofRationale: "sealed artifact identities cannot regress",
};

type ContractOverrides = Partial<Omit<DependencyContract, "edgeKind" | "producer">> & {
  readonly edgeKind?: DependencyContract["edgeKind"];
  readonly producer?: DependencyContract["producer"];
};
function validContract(overrides: ContractOverrides = {}): DependencyContract {
  return {
    producerNodeKey: "producer-a",
    consumerNodeKey: "consumer-b",
    edgeKind: "ARTIFACT_CONSUMPTION",
    graphBindingDigest: DIGEST_A,
    producer: {
      kind: "ARTIFACT_CONSUMPTION",
      artifactOrInterfaceRef: "artifact:api",
      digest: DIGEST_B,
    },
    consumer: {
      kind: "PRECONDITION",
      criterionRef: "criterion:uses-api",
      contractHash: DIGEST_A,
    },
    minimumQualifyingMilestone: "RESULT_SEALED",
    satisfactionPredicate: {
      predicateRef: registryEntry.predicateRef,
      schemaId: registryEntry.schemaId,
      schemaVersion: registryEntry.schemaVersion,
      parametersDigest: DIGEST_B,
    },
    stability: "MONOTONIC",
    satisfactionWitnesses: [
      {
        witnessRef: "witness:artifact-api",
        witnessVersion: 3,
        witnessDigest: DIGEST_A,
        sourceOperationClass: "ARTIFACT_SEAL",
      },
    ],
    consumptionHorizon: "GOAL_COMPLETION",
    necessity: {
      failedConsumerCriterionRef: "criterion:uses-api",
      failureKind: "MISSING_ARTIFACT",
      truthClass: "DAEMON_VERIFIED",
    },
    alternativeRuling: {
      kind: "INTERFACE_AVAILABLE",
      ref: "interface:api",
      digest: DIGEST_B,
    },
    alternateProducers: ["producer-fallback"],
    truthClass: "DAEMON_VERIFIED",
    invalidationFacts: [
      {
        sourceFactRef: "fact:artifact-api",
        sourceFactVersion: 3,
        sourceFactDigest: DIGEST_A,
      },
    ],
    recheckPredicateRef: "predicate:artifact-present",
    ...overrides,
  } as DependencyContract;
}

function requirement(
  edgeKind: DependencyRequirement["edgeKind"] = "ARTIFACT_CONSUMPTION",
  contract: unknown = validContract({ edgeKind: "ARTIFACT_CONSUMPTION" }),
): DependencyRequirement {
  return { edgeKind, contract } as DependencyRequirement;
}

function codesOf(value: unknown): readonly string[] {
  const result = value as { readonly ok: boolean; readonly issues?: readonly { code: string }[] };
  return result.issues?.map((issue) => issue.code) ?? [];
}

describe("dependency contract completeness", () => {
  it("accepts one exact graph-bound contract and projects it to HARD", () => {
    const contract = validContract();
    const result = validateDependencyContract(requirement(undefined, contract), [
      registryEntry,
    ]);

    expect(result).toEqual({ ok: true, graphEdgeKind: "HARD", contract });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok && result.graphEdgeKind === "HARD") expect(Object.isFrozen(result.contract.producer)).toBe(true);
    expect(Object.isFrozen(contract)).toBe(false);
    expect(validateDependencyContract(requirement(undefined, validContract({ alternateProducers: [] })), [
      registryEntry,
    ]).ok).toBe(true);
  });

  it("refuses every missing required contract field with one stable issue", () => {
    for (const field of Object.keys(validContract())) {
      const contract = { ...validContract() } as Record<string, unknown>;
      delete contract[field];
      const result = validateDependencyContract(
        requirement("ARTIFACT_CONSUMPTION", contract),
        [registryEntry],
      );
      expect(result, field).toEqual({
        ok: false,
        issues: [
          {
            code: "DEPENDENCY_CONTRACT_MALFORMED",
            message: "dependency contract is malformed or incomplete",
            nodeKeys: [],
            edgeKeys: [],
          },
        ],
      });
    }
  });

  it("refuses extra contract keys and malformed nested values", () => {
    const cases: unknown[] = [
      { ...validContract(), extra: true },
      validContract({ graphBindingDigest: "not-a-digest" }),
      validContract({ minimumQualifyingMilestone: "DONE" as never }),
      validContract({ truthClass: "TRUST_ME" as never }),
      validContract({ invalidationFacts: [] }),
      validContract({ satisfactionWitnesses: [] }),
      validContract({ alternativeRuling: undefined as never }),
    ];

    for (const contract of cases) {
      expect(
        codesOf(
          validateDependencyContract(requirement("ARTIFACT_CONSUMPTION", contract), [
            registryEntry,
          ]),
        ),
      ).toEqual(["DEPENDENCY_CONTRACT_MALFORMED"]);
    }
  });

  it("requires the producer discriminant to match the hard edge kind", () => {
    const contract = validContract({
      producer: {
        kind: "STATE_PRECONDITION",
        daemonFactRef: "fact:ready",
        digest: DIGEST_A,
      },
    });
    const result = validateDependencyContract(requirement(undefined, contract), [
      registryEntry,
    ]);

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "DEPENDENCY_PRODUCER_KIND_MISMATCH",
          message: "producer fact kind must match edgeKind",
          nodeKeys: ["producer-a", "consumer-b"],
          edgeKeys: [],
        },
      ],
    });
  });

  it("accepts all four matching producer arms", () => {
    const cases = [
      ["ARTIFACT_CONSUMPTION", { kind: "ARTIFACT_CONSUMPTION", artifactOrInterfaceRef: "artifact:x", digest: DIGEST_A }],
      ["STATE_PRECONDITION", { kind: "STATE_PRECONDITION", daemonFactRef: "fact:x", digest: DIGEST_A }],
      ["SCOPE_SERIALIZATION", { kind: "SCOPE_SERIALIZATION", scopeCollisionObservationRef: "scope:x", digest: DIGEST_A }],
      ["POLICY_SEQUENCE", { kind: "POLICY_SEQUENCE", policyRuleId: "rule:x", policyHash: DIGEST_A }],
    ] as const;

    for (const [edgeKind, producer] of cases) {
      const contract = validContract({ edgeKind, producer });
      const result = validateDependencyContract({ edgeKind, contract }, [registryEntry]);
      expect(result.ok, edgeKind).toBe(true);
      if (result.ok) {
        expect(result.graphEdgeKind).toBe("HARD");
      }
    }
  });
});

describe("hard versus advisory dependency requirements", () => {
  const hardKinds = [
    "ARTIFACT_CONSUMPTION",
    "STATE_PRECONDITION",
    "SCOPE_SERIALIZATION",
    "POLICY_SEQUENCE",
  ] as const;
  const advisoryKinds = ["RELATED", "CONTAINS", "CONTEXT", "PREFERRED_ORDER"] as const;

  it("requires a contract for every hard edge kind", () => {
    for (const edgeKind of hardKinds) {
      expect(codesOf(validateDependencyContract({ edgeKind }, []))).toEqual([
        "DEPENDENCY_HARD_CONTRACT_REQUIRED",
      ]);
    }
  });

  it("distinguishes omitted contracts from an explicit undefined property", () => {
    expect(codesOf(validateDependencyContract({ edgeKind: "ARTIFACT_CONSUMPTION", contract: undefined }, []))).toEqual([
      "DEPENDENCY_CONTRACT_MALFORMED",
    ]);
    expect(codesOf(validateDependencyContract({ edgeKind: "RELATED", contract: undefined }, []))).toEqual([
      "DEPENDENCY_ADVISORY_CONTRACT_FORBIDDEN",
    ]);
  });

  it("projects contract-free non-blocking relations to ADVISORY", () => {
    for (const edgeKind of advisoryKinds) {
      expect(validateDependencyContract({ edgeKind }, [])).toEqual({
        ok: true,
        graphEdgeKind: "ADVISORY",
      });
    }
  });

  it("refuses a contract on every non-blocking relation", () => {
    for (const edgeKind of advisoryKinds) {
      expect(codesOf(validateDependencyContract({ edgeKind, contract: validContract() }, []))).toEqual([
        "DEPENDENCY_ADVISORY_CONTRACT_FORBIDDEN",
      ]);
    }
  });
});

describe("MONOTONIC proof registry", () => {
  it("requires a matching source operation when registry proof exists", () => {
    const mismatch = validContract({
      satisfactionWitnesses: [
        {
          witnessRef: "witness:x",
          witnessVersion: 1,
          witnessDigest: DIGEST_A,
          sourceOperationClass: "DAEMON_FACT_OBSERVATION",
        },
      ],
    });
    expect(
      codesOf(validateDependencyContract(requirement(undefined, mismatch), [registryEntry])),
    ).toEqual(["DEPENDENCY_MONOTONIC_OPERATION_MISMATCH"]);
  });

  it("defaults uncertain predicates to explicit REVOCABLE without registry proof", () => {
    const contract = validContract();
    const result = validateDependencyContract(requirement(undefined, contract), []);
    expect(result.ok).toBe(true);
    if (result.ok && result.graphEdgeKind === "HARD") {
      expect(result.contract.stability).toBe("REVOCABLE");
    }
  });

  it("rejects bare monotonic booleans and malformed registry entries", () => {
    const bareBoolean = { ...registryEntry, provenMonotonic: true };
    const result = validateDependencyContract(requirement(), [bareBoolean]);
    expect(codesOf(result)).toEqual(["DEPENDENCY_PREDICATE_REGISTRY_MALFORMED"]);
    const proxiedRegistry = new Proxy([registryEntry], {});
    expect(codesOf(validateDependencyContract(requirement(), proxiedRegistry))).toEqual(["DEPENDENCY_PREDICATE_REGISTRY_MALFORMED"]);
  });
});

describe("hostile dependency inputs", () => {
  it("refuses proxies, accessors, symbols, and prototype tricks without invoking traps", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "edgeKind", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "ARTIFACT_CONSUMPTION";
      },
    });
    const symbolKey = { edgeKind: "RELATED", [Symbol("hidden")]: true };
    const inherited = Object.create({ edgeKind: "RELATED" }) as object;
    const proxy = new Proxy({ edgeKind: "RELATED" }, { ownKeys: () => { throw new Error("trap"); } });
    const revoked = Proxy.revocable({ edgeKind: "RELATED" }, {});
    revoked.revoke();

    for (const input of [accessor, symbolKey, inherited, proxy, revoked.proxy]) {
      expect(() => validateDependencyContract(input, [])).not.toThrow();
      expect(codesOf(validateDependencyContract(input, []))).toEqual([
        "DEPENDENCY_REQUIREMENT_MALFORMED",
      ]);
    }
    expect(getterCalls).toBe(0);
  });
});
