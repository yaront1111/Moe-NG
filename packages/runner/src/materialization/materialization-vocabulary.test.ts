import { expect, it } from "vitest";

import {
  MATERIALIZATION_REFUSAL_LAYERS,
  MAX_ARTIFACTS_PER_PREDECESSOR,
  MAX_ENVIRONMENT_REQUIREMENTS,
  MAX_MATERIALIZATION_CONTRACTS,
  MAX_PREDECESSOR_CANDIDATES,
  MAX_SELECTED_INPUTS,
  RUNNER_MATERIALIZATION_ERROR_CODES,
} from "./materialization-kernel.js";
import { sealNodeInputManifest, type SealNodeInputManifestInput } from "./input-manifest-seal.js";
import { revalidateSealedManifest } from "./manifest-staleness.js";
import { selectPredecessorInputs } from "./predecessor-selection.js";
import { recheckMaterializationSealWitnesses } from "./witness-recheck.js";

/**
 * The vocabulary is closed only if it is also exhausted. A code no production
 * path can emit is dead weight that a reader will branch on; a path that emits a
 * code the list does not declare is worse. This sweep pins BOTH directions by
 * asserting set equality, so either drift fails the suite.
 */
const BASE = "0".repeat(40);
const AUTHORITY = "e".repeat(64);
const WITNESS = "witness:alpha";
const digest = (character: string): string => character.repeat(64);

type Shape = Record<string, unknown>;

const artifact = (identity: string, overrides: Shape = {}): Shape => ({
  artifactIdentity: identity,
  sha256: digest("a"),
  byteLength: 12,
  ...overrides,
});

const candidate = (overrides: Shape = {}): Shape => ({
  nodeKey: "node/alpha",
  topologicalIndex: 0,
  resultRef: "result:alpha",
  attemptRef: "attempt:alpha",
  epoch: 1,
  adoptionRef: "adoption:alpha",
  milestone: "ACCEPTED",
  artifacts: [artifact("art:one")],
  ...overrides,
});

const witness = (overrides: Shape = {}): Shape => ({
  witnessRef: WITNESS,
  witnessVersion: 3,
  witnessDigest: digest("a"),
  sourceOperationClass: "ARTIFACT_SEAL",
  ...overrides,
});

const contract = (overrides: Shape = {}): Shape => ({
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
});

const currentFact = (overrides: Shape = {}): Shape => ({
  witnessRef: WITNESS,
  witnessVersion: 3,
  witnessDigest: digest("a"),
  ...overrides,
});

const proof = (overrides: Shape = {}): Shape => ({
  predicateRef: "predicate:artifact-present",
  schemaId: "schema:artifact",
  schemaVersion: 1,
  sourceOperationClass: "ARTIFACT_SEAL",
  ...overrides,
});

const epoch = (overrides: Shape = {}): Shape => ({
  graphRevisionRef: "graph:r1",
  graphEpoch: 4,
  bindingVersion: 2,
  ...overrides,
});

const select = (candidates: unknown, milestone: unknown = "ACCEPTED", base: unknown = BASE): unknown =>
  selectPredecessorInputs({ baseIdentity: base, requiredMilestone: milestone, candidates });

const recheck = (contracts: unknown, registry: unknown = [], facts: unknown = [currentFact()]): unknown =>
  recheckMaterializationSealWitnesses({
    contracts,
    monotonicRegistry: registry,
    currentWitnessFacts: facts,
  });

function goodSelection(): unknown {
  const result = select([candidate()]) as { selection?: unknown };
  if (result.selection === undefined) throw new Error("fixture selection refused");
  return result.selection;
}

const seal = (overrides: Shape = {}): unknown =>
  sealNodeInputManifest({
    selection: goodSelection(),
    contracts: [contract()],
    monotonicRegistry: [],
    currentWitnessFacts: [currentFact()],
    environmentRequirements: ["env:node@24"],
    nodeAuthorityHash: AUTHORITY,
    providerRuntimeSha256: null,
    graphEpoch: epoch(),
    ...overrides,
  } as unknown as SealNodeInputManifestInput);

function sealedManifest(): unknown {
  const result = seal() as { manifest?: unknown };
  if (result.manifest === undefined) throw new Error("fixture seal refused");
  return result.manifest;
}

const revalidate = (overrides: Shape = {}): unknown =>
  revalidateSealedManifest({
    manifest: sealedManifest(),
    currentWitnessFacts: [currentFact()],
    currentPredecessors: [
      { artifactIdentity: "art:one", sha256: digest("a"), producerAdoptionRef: "adoption:alpha" },
    ],
    currentGraphEpoch: epoch(),
    ...overrides,
  } as unknown as Parameters<typeof revalidateSealedManifest>[0]);

const rival = candidate({
  nodeKey: "node/bravo",
  resultRef: "result:bravo",
  attemptRef: "attempt:bravo",
  adoptionRef: "adoption:bravo",
});

const REFUSALS: readonly (readonly [string, () => unknown])[] = [
  ["closure malformed", () => select({ length: 1 })],
  ["closure limit", () => select(Array.from({ length: MAX_PREDECESSOR_CANDIDATES + 1 }, (_u, i) =>
    candidate({ nodeKey: `node/n${i}`, artifacts: [artifact(`art:${i}`)] })))],
  ["candidate malformed", () => select([{ ...candidate(), extra: 1 }])],
  ["artifact limit", () => select([candidate({
    artifacts: Array.from({ length: MAX_ARTIFACTS_PER_PREDECESSOR + 1 }, (_u, i) => artifact(`art:${i}`)),
  })])],
  ["base invalid", () => select([candidate()], "ACCEPTED", "nope")],
  ["milestone unqualified", () => select([candidate({ milestone: "RESULT_SEALED" })])],
  ["producer ambiguous", () => select([candidate(), rival])],
  ["selection limit", () => select(
    Array.from({ length: Math.floor(MAX_SELECTED_INPUTS / MAX_ARTIFACTS_PER_PREDECESSOR) + 1 }, (_u, n) =>
      candidate({
        nodeKey: `node/n${n}`,
        topologicalIndex: n,
        artifacts: Array.from({ length: MAX_ARTIFACTS_PER_PREDECESSOR }, (_i, a) => artifact(`art:${n}-${a}`)),
      })),
  )],
  ["contract malformed", () => recheck([{ ...contract(), extra: 1 }])],
  ["contract limit", () => recheck(Array.from({ length: MAX_MATERIALIZATION_CONTRACTS + 1 }, (_u, i) =>
    contract({ consumerNodeKey: `node/c${i}` })))],
  ["registry malformed", () => recheck([contract()], [proof({ schemaVersion: "1" })])],
  ["monotonic operation mismatch", () => recheck(
    [contract({ stability: "MONOTONIC" })],
    [proof({ sourceOperationClass: "SCOPE_OBSERVATION" })],
  )],
  ["witness facts malformed", () => recheck([contract()], [], [currentFact({ witnessDigest: "nope" })])],
  ["witness missing", () => recheck([contract()], [], [])],
  ["witness version changed", () => recheck([contract()], [], [currentFact({ witnessVersion: 9 })])],
  ["witness digest changed", () => recheck([contract()], [], [currentFact({ witnessDigest: digest("c") })])],
  ["selection invalid", () => seal({ selection: { baseIdentity: BASE, entries: [] } })],
  ["authority invalid", () => seal({ nodeAuthorityHash: "nope" })],
  ["environment invalid", () => seal({
    environmentRequirements: Array.from({ length: MAX_ENVIRONMENT_REQUIREMENTS + 1 }, (_u, i) => `env:${i}`),
  })],
  ["epoch invalid", () => seal({ graphEpoch: epoch({ bindingVersion: "2" }) })],
  ["provider runtime invalid", () => seal({ providerRuntimeSha256: "nope" })],
  ["manifest tampered", () => revalidate({ manifest: { baseIdentity: BASE } })],
  ["witness stale", () => revalidate({ currentWitnessFacts: [currentFact({ witnessVersion: 9 })] })],
  ["predecessor stale", () => revalidate({ currentPredecessors: [] })],
  ["epoch stale", () => revalidate({ currentGraphEpoch: epoch({ graphEpoch: 9 }) })],
];

function observe(result: unknown): { readonly code: string; readonly layer: string } {
  const failure = result as { ok?: unknown; code?: unknown; layer?: unknown } | null;
  expect(failure).not.toBeNull();
  expect(typeof failure?.code).toBe("string");
  expect(typeof failure?.layer).toBe("string");
  return { code: failure?.code as string, layer: failure?.layer as string };
}

it("reaches every declared error code from a real production surface", () => {
  // A sweep that generated zero cases would pass while testing nothing.
  expect(REFUSALS.length).toBeGreaterThan(0);
  const observed = new Set(REFUSALS.map(([, produce]) => observe(produce()).code));
  expect([...observed].sort()).toEqual([...RUNNER_MATERIALIZATION_ERROR_CODES].sort());
});

it("reaches every declared refusal layer from a real production surface", () => {
  const observed = new Set(REFUSALS.map(([, produce]) => observe(produce()).layer));
  expect([...observed].sort()).toEqual([...MATERIALIZATION_REFUSAL_LAYERS].sort());
});

it("gives each swept case a distinct name so a duplicated fixture is visible", () => {
  expect(new Set(REFUSALS.map(([name]) => name)).size).toBe(REFUSALS.length);
});
