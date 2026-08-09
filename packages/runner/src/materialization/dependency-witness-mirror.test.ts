import { describe, expect, it } from "vitest";

import {
  MAX_MATERIALIZATION_CONTRACTS,
  MAX_MATERIALIZATION_WITNESSES,
} from "./materialization-kernel.js";
import {
  MIRRORED_DEPENDENCY_GATES,
  MIRRORED_DEPENDENCY_STABILITIES,
  MIRRORED_SOURCE_OPERATION_CLASSES,
  parseMirroredDependencyContract,
} from "./dependency-witness-mirror.js";
import {
  effectiveStability,
  recheckMaterializationSealWitnesses,
} from "./witness-recheck.js";

const digest = (character: string): string => character.repeat(64);

const WITNESS_A = "witness:alpha";
const WITNESS_B = "witness:bravo";

type Shape = Record<string, unknown>;

function witness(overrides: Shape = {}): Shape {
  return {
    witnessRef: WITNESS_A,
    witnessVersion: 3,
    witnessDigest: digest("a"),
    sourceOperationClass: "ARTIFACT_SEAL",
    ...overrides,
  };
}

function contract(overrides: Shape = {}): Shape {
  return {
    producerNodeKey: "node/producer",
    consumerNodeKey: "node/consumer",
    satisfactionPredicate: {
      predicateRef: "predicate:artifact-present",
      schemaId: "schema:artifact",
      schemaVersion: 1,
    },
    stability: "REVOCABLE",
    satisfactionWitnesses: [witness()],
    consumptionHorizon: "ACCEPTANCE_QUALIFICATION",
    invalidationFacts: [
      { sourceFactRef: "fact:alpha", sourceFactVersion: 2, sourceFactDigest: digest("b") },
    ],
    ...overrides,
  };
}

function proofEntry(overrides: Shape = {}): Shape {
  return {
    predicateRef: "predicate:artifact-present",
    schemaId: "schema:artifact",
    schemaVersion: 1,
    sourceOperationClass: "ARTIFACT_SEAL",
    ...overrides,
  };
}

function currentFact(overrides: Shape = {}): Shape {
  return { witnessRef: WITNESS_A, witnessVersion: 3, witnessDigest: digest("a"), ...overrides };
}

function recheck(
  contracts: unknown,
  monotonicRegistry: unknown = [],
  currentWitnessFacts: unknown = [currentFact()],
): ReturnType<typeof recheckMaterializationSealWitnesses> {
  return recheckMaterializationSealWitnesses({
    contracts,
    monotonicRegistry,
    currentWitnessFacts,
  });
}

function refusal(result: { readonly ok: boolean }): {
  readonly code: string;
  readonly layer: string;
  readonly detail: string | null;
} {
  expect(result.ok).toBe(false);
  const failure = result as unknown as { code: string; layer: string; detail: string | null };
  return { code: failure.code, layer: failure.layer, detail: failure.detail };
}

describe("mirrored vocabulary", () => {
  it("pins the scheduler's DEPENDENCY_GATES list with MATERIALIZATION_SEAL first", () => {
    // Hand-written expectation, not derived from the module under test: a list
    // compared against itself would stay green through any drift.
    expect([...MIRRORED_DEPENDENCY_GATES]).toEqual([
      "MATERIALIZATION_SEAL",
      "EXECUTOR_CLAIM",
      "EFFECT_ACTIVATE",
      "STEP_START",
      "CANDIDATE_SEAL",
      "RESULT_SEAL",
      "EVIDENCE_SEAL",
      "INTEGRATION_SEAL",
      "REVIEW_QUALIFICATION",
      "ACCEPTANCE_QUALIFICATION",
      "GOAL_COMPLETION",
    ]);
    expect(MIRRORED_DEPENDENCY_GATES[0]).toBe("MATERIALIZATION_SEAL");
  });

  it("pins the stability and source-operation unions", () => {
    expect([...MIRRORED_DEPENDENCY_STABILITIES]).toEqual(["MONOTONIC", "REVOCABLE"]);
    expect([...MIRRORED_SOURCE_OPERATION_CLASSES]).toEqual([
      "ARTIFACT_SEAL",
      "DAEMON_FACT_OBSERVATION",
      "SCOPE_OBSERVATION",
      "POLICY_RULE_EVALUATION",
    ]);
  });
});

describe("hostile contract shapes", () => {
  const hostile: readonly (readonly [string, () => unknown])[] = [
    ["custom prototype", () => Object.setPrototypeOf(contract(), { smuggled: true })],
    ["extra key", () => ({ ...contract(), extra: 1 })],
    ["missing key", () => {
      const partial = contract();
      delete partial["consumptionHorizon"];
      return partial;
    }],
    ["wrong type", () => contract({ satisfactionPredicate: {
      predicateRef: "predicate:artifact-present",
      schemaId: "schema:artifact",
      schemaVersion: "1",
    } })],
    ["getter-bearing", () => {
      let reads = 0;
      return Object.defineProperty(contract(), "stability", {
        enumerable: true,
        get: () => (reads++ === 0 ? "REVOCABLE" : "MONOTONIC"),
      });
    }],
    ["array in place of record", () => []],
    ["nested witness with an extra key", () => contract({ satisfactionWitnesses: [witness({ extra: 1 })] })],
    ["duplicate witnessRef", () => contract({ satisfactionWitnesses: [witness(), witness()] })],
    ["negative witness version", () => contract({ satisfactionWitnesses: [witness({ witnessVersion: -1 })] })],
    ["short witness digest", () => contract({ satisfactionWitnesses: [witness({ witnessDigest: "abc" })] })],
    ["empty witness list", () => contract({ satisfactionWitnesses: [] })],
    ["node key the graph cannot name", () => contract({ producerNodeKey: "node producer" })],
    ["unknown source operation", () => contract({ satisfactionWitnesses: [witness({ sourceOperationClass: "GUESS" })] })],
    ["unknown consumption horizon", () => contract({ consumptionHorizon: "SOMEDAY" })],
    ["stability with trailing space", () => contract({ stability: "MONOTONIC " })],
    ["lowercase stability", () => contract({ stability: "revocable" })],
    ["oversized witness list", () => contract({
      satisfactionWitnesses: Array.from({ length: MAX_MATERIALIZATION_WITNESSES + 1 }, (_unused, index) =>
        witness({ witnessRef: `witness:${index}` })),
    })],
  ];

  for (const [name, build] of hostile) {
    it(`refuses ${name} with RUNNER_MATERIALIZATION_CONTRACT_MALFORMED at layer WITNESS`, () => {
      expect(parseMirroredDependencyContract(build())).toBeNull();
      expect(refusal(recheck([build()]))).toEqual({
        code: "RUNNER_MATERIALIZATION_CONTRACT_MALFORMED",
        layer: "WITNESS",
        detail: null,
      });
    });
  }

  it("accepts a null-prototype record, matching the authority's own parser", () => {
    // Parity in the permissive direction too: the scheduler's isPlainRecord
    // accepts a null prototype, so a mirror that refused one would refuse
    // records the authority admits and quietly diverge.
    const bare = Object.assign(Object.create(null) as Shape, contract());
    expect(parseMirroredDependencyContract(bare)?.stability).toBe("REVOCABLE");
  });

  it("refuses a non-array contract list with RUNNER_MATERIALIZATION_CONTRACT_MALFORMED", () => {
    expect(refusal(recheck({ length: 1 }))).toEqual({
      code: "RUNNER_MATERIALIZATION_CONTRACT_MALFORMED",
      layer: "WITNESS",
      detail: null,
    });
  });

  it("refuses an oversized contract list on the bound, not on its contents", () => {
    // Every element is individually valid, so only the ceiling can refuse this.
    const contracts = Array.from({ length: MAX_MATERIALIZATION_CONTRACTS + 1 }, (_unused, index) =>
      contract({ consumerNodeKey: `node/consumer-${index}` }));
    expect(refusal(recheck(contracts))).toEqual({
      code: "RUNNER_MATERIALIZATION_CONTRACT_LIMIT",
      layer: "WITNESS",
      detail: null,
    });
  });

  it("refuses two registry proofs for one predicate rather than picking by order", () => {
    // dependency-contract.ts:189 dedupes on exactly this key and refuses a
    // duplicate. Without the same check, two disagreeing proofs would resolve by
    // list order and this mirror would accept a registry the authority rejects.
    const conflicting = [proofEntry(), proofEntry({ sourceOperationClass: "SCOPE_OBSERVATION" })];
    expect(refusal(recheck([contract()], conflicting))).toEqual({
      code: "RUNNER_MATERIALIZATION_REGISTRY_MALFORMED",
      layer: "WITNESS",
      detail: null,
    });
  });

  it("refuses one witness declared by two contracts at disagreeing versions", () => {
    // Keeping the last one seen would resolve a genuine conflict silently by
    // contract order and seal against a value the other contract never agreed to.
    const second = contract({
      consumerNodeKey: "node/other",
      satisfactionWitnesses: [witness({ witnessVersion: 9 })],
    });
    expect(refusal(recheck([contract(), second]))).toEqual({
      code: "RUNNER_MATERIALIZATION_CONTRACT_MALFORMED",
      layer: "WITNESS",
      detail: WITNESS_A,
    });
  });

  it("refuses one witness declared by two contracts at disagreeing digests", () => {
    const second = contract({
      consumerNodeKey: "node/other",
      satisfactionWitnesses: [witness({ witnessDigest: digest("c") })],
    });
    expect(refusal(recheck([contract(), second])).code).toBe(
      "RUNNER_MATERIALIZATION_CONTRACT_MALFORMED",
    );
  });

  it("accepts one witness declared identically by two contracts", () => {
    // The converse, so the conflict check cannot be satisfied by refusing every
    // repeated declaration.
    const second = contract({ consumerNodeKey: "node/other" });
    expect(recheck([contract(), second])).toEqual({
      ok: true,
      rechecked: [WITNESS_A],
      exempt: [],
    });
  });

  it("refuses a malformed monotonic registry with its own code", () => {
    expect(refusal(recheck([contract()], [proofEntry({ schemaVersion: "1" })]))).toEqual({
      code: "RUNNER_MATERIALIZATION_REGISTRY_MALFORMED",
      layer: "WITNESS",
      detail: null,
    });
  });

  it("refuses malformed current witness facts with their own code", () => {
    expect(refusal(recheck([contract()], [], [currentFact({ witnessDigest: "nope" })]))).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_FACTS_MALFORMED",
      layer: "WITNESS",
      detail: null,
    });
  });
});

describe("MONOTONIC normalization", () => {
  it("downgrades MONOTONIC to REVOCABLE when no registry proof is supplied", () => {
    // dependency-contract.ts:248. A mirror that skipped this would exempt from
    // recheck a witness the authority treats as revocable.
    const parsed = parseMirroredDependencyContract(contract({ stability: "MONOTONIC" }));
    expect(parsed?.stability).toBe("MONOTONIC");
    expect(effectiveStability(parsed!, [])).toEqual({ ok: true, stability: "REVOCABLE" });
  });

  it("keeps MONOTONIC when a matching registry proof is supplied", () => {
    const parsed = parseMirroredDependencyContract(contract({ stability: "MONOTONIC" }));
    expect(effectiveStability(parsed!, [proofEntry()])).toEqual({ ok: true, stability: "MONOTONIC" });
  });

  it("downgrades when the registry proof matches on ref but not on schema version", () => {
    const parsed = parseMirroredDependencyContract(contract({ stability: "MONOTONIC" }));
    expect(effectiveStability(parsed!, [proofEntry({ schemaVersion: 2 })])).toEqual({
      ok: true,
      stability: "REVOCABLE",
    });
  });

  it("rechecks a downgraded MONOTONIC contract instead of exempting it", () => {
    const result = recheck([contract({ stability: "MONOTONIC" })], [], [currentFact({ witnessVersion: 4 })]);
    expect(refusal(result)).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_VERSION_CHANGED",
      layer: "WITNESS",
      detail: WITNESS_A,
    });
  });

  it("exempts a proven MONOTONIC contract from recheck", () => {
    const result = recheck(
      [contract({ stability: "MONOTONIC" })],
      [proofEntry()],
      [currentFact({ witnessVersion: 4 })],
    );
    expect(result).toEqual({ ok: true, rechecked: [], exempt: [WITNESS_A] });
  });

  it("refuses a proven MONOTONIC contract whose witness operation class disagrees", () => {
    // Parity with dependency-contract.ts:245: a mirror that accepted this would
    // be more permissive than the authority it mirrors.
    const result = recheck(
      [contract({ stability: "MONOTONIC" })],
      [proofEntry({ sourceOperationClass: "SCOPE_OBSERVATION" })],
      [currentFact()],
    );
    expect(refusal(result)).toEqual({
      code: "RUNNER_MATERIALIZATION_MONOTONIC_OPERATION_MISMATCH",
      layer: "WITNESS",
      detail: WITNESS_A,
    });
  });
});

describe("MATERIALIZATION_SEAL recheck", () => {
  it("satisfies a revocable witness whose current fact is unchanged", () => {
    expect(recheck([contract()])).toEqual({ ok: true, rechecked: [WITNESS_A], exempt: [] });
  });

  it("refuses a witness with no current fact at all", () => {
    expect(refusal(recheck([contract()], [], []))).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_MISSING",
      layer: "WITNESS",
      detail: WITNESS_A,
    });
  });

  it("refuses a witness whose digest changed", () => {
    expect(refusal(recheck([contract()], [], [currentFact({ witnessDigest: digest("f") })]))).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_DIGEST_CHANGED",
      layer: "WITNESS",
      detail: WITNESS_A,
    });
  });

  it("names the lexicographically first failing witness regardless of input order", () => {
    const both = contract({
      satisfactionWitnesses: [
        witness({ witnessRef: WITNESS_B, witnessDigest: digest("c") }),
        witness({ witnessRef: WITNESS_A }),
      ],
    });
    const shuffled = contract({
      satisfactionWitnesses: [
        witness({ witnessRef: WITNESS_A }),
        witness({ witnessRef: WITNESS_B, witnessDigest: digest("c") }),
      ],
    });
    for (const input of [both, shuffled]) {
      expect(refusal(recheck([input], [], []))).toEqual({
        code: "RUNNER_MATERIALIZATION_WITNESS_MISSING",
        layer: "WITNESS",
        detail: WITNESS_A,
      });
    }
  });

  it("returns rechecked refs sorted, independent of contract order", () => {
    const first = contract({ satisfactionWitnesses: [witness({ witnessRef: WITNESS_B })] });
    const second = contract({ consumerNodeKey: "node/other" });
    const facts = [currentFact(), currentFact({ witnessRef: WITNESS_B })];
    expect(recheck([first, second], [], facts)).toEqual({
      ok: true,
      rechecked: [WITNESS_A, WITNESS_B],
      exempt: [],
    });
    expect(recheck([second, first], [], facts)).toEqual({
      ok: true,
      rechecked: [WITNESS_A, WITNESS_B],
      exempt: [],
    });
  });

  it("freezes the satisfied verdict", () => {
    const result = recheck([contract()]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen((result as { rechecked: readonly string[] }).rechecked)).toBe(true);
  });
});
