import {
  exactRecord,
  isCount,
  isDigest,
  isRef,
  oneOf,
} from "../supervisor/effect-shape.js";
import {
  MAX_MATERIALIZATION_CONTRACTS,
  MAX_MATERIALIZATION_WITNESSES,
  isMirroredGraphKey,
  readBoundedList,
} from "./materialization-kernel.js";

/**
 * The dependency witness surface, re-derived over a structurally mirrored record.
 *
 * `@moe/runner` depends only on `@moe/contracts`, so `@moe/scheduler`'s
 * `validateDependencyContract` cannot be called. This is a clone, exactly as
 * `supervisor/lease-mirror.ts` clones the lease fence, and it carries the same
 * rule: it is a RE-VALIDATION, never a shape cast. Reading `stability` off an
 * unparsed object would accept records the authority's own parser refuses, and a
 * gate that admits what the authority rejects is a bypass, not a convenience.
 *
 * Where the two can differ safely they differ only in the closed direction: the
 * ref and counter guards here are tighter than the authority's, so this mirror
 * can refuse a contract the scheduler accepts but can never accept one it
 * refuses.
 *
 * The verdict-EQUALITY drift test against the real `validateDependencyContract`
 * cannot live in this package. It is deferred to a package that depends on both,
 * the same deferral `lease-mirror.ts` records. What ships here is hostile-fixture
 * parity plus the two normalizations `witness-recheck.ts` applies.
 *
 * This module owns the mirrored SHAPE only. Every parser returns `null` on a
 * hostile record and the caller picks the code and the layer — the
 * `effect-parse.ts` convention — so no refusal vocabulary is declared here.
 */

/** String-identical to `@moe/scheduler` `DependencyContractBase["stability"]`. */
export const MIRRORED_DEPENDENCY_STABILITIES = Object.freeze(["MONOTONIC", "REVOCABLE"] as const);

/** String-identical to `@moe/scheduler` `DEPENDENCY_GATES`; this task implements element 0. */
export const MIRRORED_DEPENDENCY_GATES = Object.freeze([
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
] as const);

/** String-identical to `@moe/scheduler` `SourceOperationClass`. */
export const MIRRORED_SOURCE_OPERATION_CLASSES = Object.freeze([
  "ARTIFACT_SEAL",
  "DAEMON_FACT_OBSERVATION",
  "SCOPE_OBSERVATION",
  "POLICY_RULE_EVALUATION",
] as const);

export type MirroredStability = (typeof MIRRORED_DEPENDENCY_STABILITIES)[number];
export type MirroredDependencyGate = (typeof MIRRORED_DEPENDENCY_GATES)[number];
export type MirroredSourceOperationClass = (typeof MIRRORED_SOURCE_OPERATION_CLASSES)[number];

/** Structural mirror of `@moe/scheduler` `DependencyWitnessBinding`. */
export interface MirroredWitnessBinding {
  readonly witnessRef: string;
  readonly witnessVersion: number;
  readonly witnessDigest: string;
  readonly sourceOperationClass: MirroredSourceOperationClass;
}

/** Structural mirror of `@moe/scheduler` `DependencyFactBinding`. */
export interface MirroredFactBinding {
  readonly sourceFactRef: string;
  readonly sourceFactVersion: number;
  readonly sourceFactDigest: string;
}

export interface MirroredSatisfactionPredicate {
  readonly predicateRef: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
}

/** The witness-bearing slice of `DependencyContract`; no other field is mirrored. */
export interface MirroredDependencyContract {
  readonly producerNodeKey: string;
  readonly consumerNodeKey: string;
  readonly satisfactionPredicate: MirroredSatisfactionPredicate;
  readonly stability: MirroredStability;
  readonly satisfactionWitnesses: readonly MirroredWitnessBinding[];
  readonly consumptionHorizon: MirroredDependencyGate;
  readonly invalidationFacts: readonly MirroredFactBinding[];
}

/** Structural mirror of `@moe/scheduler` `MonotonicPredicateRegistryEntry`'s proof-bearing fields. */
export interface MirroredMonotonicProof {
  readonly predicateRef: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly sourceOperationClass: MirroredSourceOperationClass;
}

/** The witness facts as they stand right now, supplied by the caller that owns the source. */
export interface CurrentWitnessFact {
  readonly witnessRef: string;
  readonly witnessVersion: number;
  readonly witnessDigest: string;
}

const CONTRACT_KEYS = [
  "producerNodeKey",
  "consumerNodeKey",
  "satisfactionPredicate",
  "stability",
  "satisfactionWitnesses",
  "consumptionHorizon",
  "invalidationFacts",
] as const;

/** Byte-order string comparison; exported so every ordering in this area uses one rule. */
export const byWitnessText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function parseWitnesses(value: unknown): MirroredWitnessBinding[] | null {
  const read = readBoundedList(value, MAX_MATERIALIZATION_WITNESSES);
  if (read.kind !== "OK" || read.items.length === 0) {
    return null;
  }
  const output: MirroredWitnessBinding[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    const item = exactRecord(entry, [
      "witnessRef",
      "witnessVersion",
      "witnessDigest",
      "sourceOperationClass",
    ]);
    if (item === null || !isRef(item["witnessRef"]) || seen.has(item["witnessRef"])) return null;
    if (!isCount(item["witnessVersion"]) || !isDigest(item["witnessDigest"])) return null;
    if (!oneOf(item["sourceOperationClass"], MIRRORED_SOURCE_OPERATION_CLASSES)) return null;
    seen.add(item["witnessRef"]);
    output.push(Object.freeze(item) as unknown as MirroredWitnessBinding);
  }
  return output.sort((left, right) => byWitnessText(left.witnessRef, right.witnessRef));
}

function parseFacts(value: unknown): MirroredFactBinding[] | null {
  const read = readBoundedList(value, MAX_MATERIALIZATION_WITNESSES);
  if (read.kind !== "OK" || read.items.length === 0) {
    return null;
  }
  const output: MirroredFactBinding[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    const item = exactRecord(entry, ["sourceFactRef", "sourceFactVersion", "sourceFactDigest"]);
    if (item === null || !isRef(item["sourceFactRef"]) || seen.has(item["sourceFactRef"])) return null;
    if (!isCount(item["sourceFactVersion"]) || !isDigest(item["sourceFactDigest"])) return null;
    seen.add(item["sourceFactRef"]);
    output.push(Object.freeze(item) as unknown as MirroredFactBinding);
  }
  return output.sort((left, right) => byWitnessText(left.sourceFactRef, right.sourceFactRef));
}

export function parseMirroredDependencyContract(
  value: unknown,
): MirroredDependencyContract | null {
  const item = exactRecord(value, CONTRACT_KEYS);
  if (item === null) return null;
  const predicate = exactRecord(item["satisfactionPredicate"], [
    "predicateRef",
    "schemaId",
    "schemaVersion",
  ]);
  const witnesses = parseWitnesses(item["satisfactionWitnesses"]);
  const facts = parseFacts(item["invalidationFacts"]);
  if (predicate === null || witnesses === null || facts === null) return null;
  if (!isRef(predicate["predicateRef"]) || !isRef(predicate["schemaId"])) return null;
  if (!isCount(predicate["schemaVersion"])) return null;
  if (!isMirroredGraphKey(item["producerNodeKey"])) return null;
  if (!isMirroredGraphKey(item["consumerNodeKey"])) return null;
  if (!oneOf(item["stability"], MIRRORED_DEPENDENCY_STABILITIES)) return null;
  if (!oneOf(item["consumptionHorizon"], MIRRORED_DEPENDENCY_GATES)) return null;
  return Object.freeze({
    producerNodeKey: item["producerNodeKey"],
    consumerNodeKey: item["consumerNodeKey"],
    satisfactionPredicate: Object.freeze(predicate as unknown as MirroredSatisfactionPredicate),
    stability: item["stability"],
    satisfactionWitnesses: Object.freeze(witnesses),
    consumptionHorizon: item["consumptionHorizon"],
    invalidationFacts: Object.freeze(facts),
  });
}

export function parseMonotonicRegistry(value: unknown): MirroredMonotonicProof[] | null {
  const read = readBoundedList(value, MAX_MATERIALIZATION_CONTRACTS);
  if (read.kind !== "OK") return null;
  const output: MirroredMonotonicProof[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    const item = exactRecord(entry, [
      "predicateRef",
      "schemaId",
      "schemaVersion",
      "sourceOperationClass",
    ]);
    if (item === null || !isRef(item["predicateRef"]) || !isRef(item["schemaId"])) return null;
    if (!isCount(item["schemaVersion"])) return null;
    if (!oneOf(item["sourceOperationClass"], MIRRORED_SOURCE_OPERATION_CLASSES)) return null;
    // The authority dedupes on exactly this key (dependency-contract.ts:189).
    // Without it, two proofs for one predicate would resolve by list order and
    // this mirror would accept a registry the scheduler refuses.
    const key = JSON.stringify([item["predicateRef"], item["schemaId"], item["schemaVersion"]]);
    if (seen.has(key)) return null;
    seen.add(key);
    output.push(Object.freeze(item) as unknown as MirroredMonotonicProof);
  }
  return output;
}

export function parseCurrentWitnessFacts(value: unknown): CurrentWitnessFact[] | null {
  const read = readBoundedList(value, MAX_MATERIALIZATION_WITNESSES);
  if (read.kind !== "OK") return null;
  const output: CurrentWitnessFact[] = [];
  const seen = new Set<string>();
  for (const entry of read.items) {
    const item = exactRecord(entry, ["witnessRef", "witnessVersion", "witnessDigest"]);
    if (item === null || !isRef(item["witnessRef"]) || seen.has(item["witnessRef"])) return null;
    if (!isCount(item["witnessVersion"]) || !isDigest(item["witnessDigest"])) return null;
    seen.add(item["witnessRef"]);
    output.push(item as unknown as CurrentWitnessFact);
  }
  return output;
}
