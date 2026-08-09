import { describe, expect, it } from "vitest";

import {
  MAX_ENVIRONMENT_REQUIREMENTS,
  NODE_INPUT_MANIFEST_VERSION,
} from "./materialization-kernel.js";
import {
  sealNodeInputManifest,
  type NodeInputManifest,
  type SealNodeInputManifestInput,
} from "./input-manifest-seal.js";
import { revalidateSealedManifest } from "./manifest-staleness.js";
import { selectPredecessorInputs, type PredecessorSelection } from "./predecessor-selection.js";

const BASE = "0".repeat(40);
const OTHER_BASE = "1".repeat(40);
const AUTHORITY = "e".repeat(64);
const RUNTIME = "f".repeat(64);
const WITNESS_A = "witness:alpha";
const WITNESS_B = "witness:bravo";

const digest = (character: string): string => character.repeat(64);

type Shape = Record<string, unknown>;

function makeSelection(
  candidateOverrides: Shape = {},
  artifactOverrides: Shape = {},
  baseIdentity: string = BASE,
): PredecessorSelection {
  const result = selectPredecessorInputs({
    baseIdentity,
    requiredMilestone: "ACCEPTED",
    candidates: [
      {
        nodeKey: "node/alpha",
        topologicalIndex: 0,
        resultRef: "result:alpha",
        attemptRef: "attempt:alpha",
        epoch: 1,
        adoptionRef: "adoption:alpha",
        milestone: "ACCEPTED",
        artifacts: [
          { artifactIdentity: "art:one", sha256: digest("a"), byteLength: 12, ...artifactOverrides },
        ],
        ...candidateOverrides,
      },
    ],
  });
  if (!("selection" in result)) {
    throw new Error("fixture selection refused, which would make every seal test vacuous");
  }
  return result.selection;
}

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
    producerNodeKey: "node/alpha",
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

function currentFact(overrides: Shape = {}): Shape {
  return { witnessRef: WITNESS_A, witnessVersion: 3, witnessDigest: digest("a"), ...overrides };
}

function epoch(overrides: Shape = {}): Shape {
  return { graphRevisionRef: "graph:r1", graphEpoch: 4, bindingVersion: 2, ...overrides };
}

function sealInput(overrides: Shape = {}): SealNodeInputManifestInput {
  return {
    selection: makeSelection(),
    contracts: [contract()],
    monotonicRegistry: [],
    currentWitnessFacts: [currentFact()],
    environmentRequirements: ["env:node@24"],
    nodeAuthorityHash: AUTHORITY,
    providerRuntimeSha256: RUNTIME,
    graphEpoch: epoch(),
    ...overrides,
  } as SealNodeInputManifestInput;
}

function seal(overrides: Shape = {}): ReturnType<typeof sealNodeInputManifest> {
  return sealNodeInputManifest(sealInput(overrides));
}

function manifestOf(overrides: Shape = {}): NodeInputManifest {
  const result = seal(overrides);
  expect(result.ok).toBe(true);
  return (result as { manifest: NodeInputManifest }).manifest;
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

describe("sealed manifest", () => {
  it("carries the pinned version and every bound field", () => {
    const manifest = manifestOf();
    expect(manifest.manifestVersion).toBe(NODE_INPUT_MANIFEST_VERSION);
    expect(manifest.baseIdentity).toBe(BASE);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.witnessBindings).toEqual([
      { witnessRef: WITNESS_A, witnessVersion: 3, witnessDigest: digest("a") },
    ]);
    expect(manifest.environmentRequirements).toEqual(["env:node@24"]);
    expect(manifest.graphEpoch).toEqual({
      graphRevisionRef: "graph:r1",
      graphEpoch: 4,
      bindingVersion: 2,
    });
  });

  it("freezes the manifest and its nested records", () => {
    const manifest = manifestOf();
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    expect(Object.isFrozen(manifest.entries[0])).toBe(true);
    expect(Object.isFrozen(manifest.witnessBindings)).toBe(true);
    expect(Object.isFrozen(manifest.witnessBindings[0])).toBe(true);
    expect(Object.isFrozen(manifest.graphEpoch)).toBe(true);
    expect(Object.isFrozen(manifest.environmentRequirements)).toBe(true);
  });

  it("re-seals identical inputs to identical digests", () => {
    // The converse of the mutation sweep: a digest seeded by anything ambient
    // would differ here even though nothing about the inputs did.
    const first = manifestOf();
    const second = manifestOf();
    expect(second.inputTreeDigest).toBe(first.inputTreeDigest);
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(second.inputBindingHash).toBe(first.inputBindingHash);
  });

  it("does not let the manifest digest cover itself", () => {
    const manifest = manifestOf();
    expect(manifest.manifestSha256).not.toBe(manifest.inputBindingHash);
    expect(manifest.manifestSha256).not.toBe(manifest.inputTreeDigest);
  });
});

describe("input binding hash", () => {
  // Design line 256, one mutation per assertion. A test that changed several
  // fields at once could not tell a digest that binds all of them from one that
  // binds only the first.
  const MUTATIONS: readonly (readonly [string, Shape])[] = [
    ["a selected result identity", { selection: makeSelection({ resultRef: "result:other" }) }],
    ["a producer adoption identity", { selection: makeSelection({ adoptionRef: "adoption:other" }) }],
    ["a producer attempt identity", { selection: makeSelection({ attemptRef: "attempt:other" }) }],
    ["a producer epoch", { selection: makeSelection({ epoch: 2 }) }],
    ["an artifact identity", { selection: makeSelection({}, { artifactIdentity: "art:other" }) }],
    ["an artifact digest", { selection: makeSelection({}, { sha256: digest("d") }) }],
    ["an artifact byte length", { selection: makeSelection({}, { byteLength: 13 }) }],
    ["the graph base", { selection: makeSelection({}, {}, OTHER_BASE) }],
    [
      "a witness ref",
      {
        contracts: [contract({ satisfactionWitnesses: [witness({ witnessRef: WITNESS_B })] })],
        currentWitnessFacts: [currentFact({ witnessRef: WITNESS_B })],
      },
    ],
    [
      "a witness version",
      {
        contracts: [contract({ satisfactionWitnesses: [witness({ witnessVersion: 9 })] })],
        currentWitnessFacts: [currentFact({ witnessVersion: 9 })],
      },
    ],
    [
      "a witness digest",
      {
        contracts: [contract({ satisfactionWitnesses: [witness({ witnessDigest: digest("c") })] })],
        currentWitnessFacts: [currentFact({ witnessDigest: digest("c") })],
      },
    ],
    ["an environment-manifest requirement", { environmentRequirements: ["env:node@25"] }],
    ["the node authority hash", { nodeAuthorityHash: digest("9") }],
    ["the provider runtime observation", { providerRuntimeSha256: digest("8") }],
    ["an absent provider runtime observation", { providerRuntimeSha256: null }],
    ["the graph revision", { graphEpoch: epoch({ graphRevisionRef: "graph:r2" }) }],
    ["the graph epoch", { graphEpoch: epoch({ graphEpoch: 5 }) }],
    ["the binding version", { graphEpoch: epoch({ bindingVersion: 3 }) }],
  ];

  const baseline = () => manifestOf().inputBindingHash;

  for (const [name, mutation] of MUTATIONS) {
    it(`changes when ${name} changes`, () => {
      expect(manifestOf(mutation).inputBindingHash).not.toBe(baseline());
    });
  }

  it("gives every mutation a distinct binding hash", () => {
    // A sweep that generated zero cases would pass while testing nothing.
    expect(MUTATIONS.length).toBeGreaterThan(0);
    const hashes = new Set([baseline(), ...MUTATIONS.map(([, m]) => manifestOf(m).inputBindingHash)]);
    expect(hashes.size).toBe(MUTATIONS.length + 1);
  });
});

describe("witness recheck at seal", () => {
  it("rechecks a REVOCABLE witness and refuses a changed one at layer WITNESS", () => {
    expect(refusal(seal({ currentWitnessFacts: [currentFact({ witnessVersion: 4 })] }))).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_VERSION_CHANGED",
      layer: "WITNESS",
      detail: WITNESS_A,
    });
  });

  it("exempts a MONOTONIC witness backed by a registry proof", () => {
    const result = seal({
      contracts: [contract({ stability: "MONOTONIC" })],
      monotonicRegistry: [
        {
          predicateRef: "predicate:artifact-present",
          schemaId: "schema:artifact",
          schemaVersion: 1,
          sourceOperationClass: "ARTIFACT_SEAL",
        },
      ],
      currentWitnessFacts: [currentFact({ witnessVersion: 4 })],
    });
    expect(result.ok).toBe(true);
  });

  it("rechecks a MONOTONIC witness with no registry proof", () => {
    // The :248 downgrade, asserted through the seal rather than only through the
    // mirror: skipping it here would exempt a witness the authority calls revocable.
    expect(
      refusal(
        seal({
          contracts: [contract({ stability: "MONOTONIC" })],
          currentWitnessFacts: [currentFact({ witnessVersion: 4 })],
        }),
      ),
    ).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_VERSION_CHANGED",
      layer: "WITNESS",
      detail: WITNESS_A,
    });
  });

  it("produces no manifest and no dispatch affordance when it refuses", () => {
    // Checked by KEY SET, not by a boolean: a refused seal must not be able to
    // hand a caller anything dispatchable at all (design line 799).
    const result = seal({ currentWitnessFacts: [] });
    expect(Object.keys(result).sort()).toEqual(["code", "detail", "layer", "message", "ok"]);
  });
});

describe("seal input validation", () => {
  const cases: readonly (readonly [string, Shape, string])[] = [
    ["a selection that is not one", { selection: { baseIdentity: BASE, entries: [] } }, "RUNNER_MATERIALIZATION_SELECTION_INVALID"],
    ["a node authority hash that is not a digest", { nodeAuthorityHash: "nope" }, "RUNNER_MATERIALIZATION_AUTHORITY_INVALID"],
    ["a provider runtime observation that is neither a digest nor absent", { providerRuntimeSha256: "nope" }, "RUNNER_MATERIALIZATION_PROVIDER_RUNTIME_INVALID"],
    ["a non-array environment requirement list", { environmentRequirements: "env:node@24" }, "RUNNER_MATERIALIZATION_ENVIRONMENT_INVALID"],
    ["a duplicated environment requirement", { environmentRequirements: ["env:a", "env:a"] }, "RUNNER_MATERIALIZATION_ENVIRONMENT_INVALID"],
    ["an oversized environment requirement list", { environmentRequirements: Array.from({ length: MAX_ENVIRONMENT_REQUIREMENTS + 1 }, (_u, i) => `env:${i}`) }, "RUNNER_MATERIALIZATION_ENVIRONMENT_INVALID"],
    ["a malformed graph epoch", { graphEpoch: epoch({ bindingVersion: "2" }) }, "RUNNER_MATERIALIZATION_EPOCH_INVALID"],
    ["a graph epoch with an extra key", { graphEpoch: { ...epoch(), extra: 1 } }, "RUNNER_MATERIALIZATION_EPOCH_INVALID"],
  ];

  for (const [name, mutation, code] of cases) {
    it(`refuses ${name} at layer SEAL`, () => {
      expect(refusal(seal(mutation))).toEqual({ code, layer: "SEAL", detail: null });
    });
  }

  it("refuses a forged selection binding one artifact identity twice", () => {
    // A caller can hand the sealer a record that never went through
    // selectPredecessorInputs. If the seal trusted its type, the fail-closed
    // ambiguity refusal would be bypassable by simply not using the selector.
    const entry = {
      artifactIdentity: "art:one",
      sha256: digest("a"),
      byteLength: 12,
      producerNodeKey: "node/alpha",
      producerResultRef: "result:alpha",
      producerAttemptRef: "attempt:alpha",
      producerEpoch: 1,
      producerAdoptionRef: "adoption:alpha",
    };
    const forged = {
      baseIdentity: BASE,
      requiredMilestone: "ACCEPTED",
      entries: [entry, { ...entry, producerNodeKey: "node/bravo" }],
    };
    expect(refusal(seal({ selection: forged }))).toEqual({
      code: "RUNNER_MATERIALIZATION_SELECTION_INVALID",
      layer: "SEAL",
      detail: null,
    });
  });
});

describe("staleness revalidation of a sealed manifest", () => {
  const current = (overrides: Shape = {}): Shape => ({
    manifest: manifestOf(),
    currentWitnessFacts: [currentFact()],
    currentPredecessors: [
      { artifactIdentity: "art:one", sha256: digest("a"), producerAdoptionRef: "adoption:alpha" },
    ],
    currentGraphEpoch: epoch(),
    ...overrides,
  });

  const check = (overrides: Shape = {}): ReturnType<typeof revalidateSealedManifest> =>
    revalidateSealedManifest(
      current(overrides) as unknown as Parameters<typeof revalidateSealedManifest>[0],
    );

  it("passes an unchanged manifest", () => {
    expect(check()).toBeNull();
  });

  it("refuses a manifest sealed against witness version N once the witness is N+1", () => {
    expect(refusal({ ok: false, ...check({ currentWitnessFacts: [currentFact({ witnessVersion: 4 })] }) })).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_STALE",
      layer: "STALENESS",
      detail: WITNESS_A,
    });
  });

  it("refuses a witness whose digest moved", () => {
    expect(refusal({ ok: false, ...check({ currentWitnessFacts: [currentFact({ witnessDigest: digest("c") })] }) })).toEqual({
      code: "RUNNER_MATERIALIZATION_WITNESS_STALE",
      layer: "STALENESS",
      detail: WITNESS_A,
    });
  });

  it("refuses a witness that disappeared", () => {
    expect(refusal({ ok: false, ...check({ currentWitnessFacts: [] }) }).code).toBe(
      "RUNNER_MATERIALIZATION_WITNESS_STALE",
    );
  });

  it("refuses a changed predecessor digest", () => {
    const moved = [
      { artifactIdentity: "art:one", sha256: digest("d"), producerAdoptionRef: "adoption:alpha" },
    ];
    expect(refusal({ ok: false, ...check({ currentPredecessors: moved }) })).toEqual({
      code: "RUNNER_MATERIALIZATION_PREDECESSOR_STALE",
      layer: "STALENESS",
      detail: "art:one",
    });
  });

  it("refuses a stale adoption even when the bytes still match", () => {
    const readopted = [
      { artifactIdentity: "art:one", sha256: digest("a"), producerAdoptionRef: "adoption:other" },
    ];
    expect(refusal({ ok: false, ...check({ currentPredecessors: readopted }) })).toEqual({
      code: "RUNNER_MATERIALIZATION_PREDECESSOR_STALE",
      layer: "STALENESS",
      detail: "art:one",
    });
  });

  it("refuses a predecessor whose bytes are gone", () => {
    expect(refusal({ ok: false, ...check({ currentPredecessors: [] }) }).code).toBe(
      "RUNNER_MATERIALIZATION_PREDECESSOR_STALE",
    );
  });

  it("refuses a moved graph epoch", () => {
    expect(refusal({ ok: false, ...check({ currentGraphEpoch: epoch({ graphEpoch: 5 }) }) })).toEqual({
      code: "RUNNER_MATERIALIZATION_EPOCH_STALE",
      layer: "STALENESS",
      detail: null,
    });
  });

  it("refuses a manifest whose own digest no longer covers its body", () => {
    const tampered = { ...manifestOf(), baseIdentity: OTHER_BASE };
    expect(refusal({ ok: false, ...check({ manifest: tampered }) })).toEqual({
      code: "RUNNER_MATERIALIZATION_MANIFEST_TAMPERED",
      layer: "STALENESS",
      detail: null,
    });
  });

  it("refuses a manifest that is not a sealed manifest at all", () => {
    expect(refusal({ ok: false, ...check({ manifest: { baseIdentity: BASE } }) }).code).toBe(
      "RUNNER_MATERIALIZATION_MANIFEST_TAMPERED",
    );
  });
});
