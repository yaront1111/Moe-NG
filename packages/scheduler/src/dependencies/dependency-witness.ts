/**
 * Immutable dependency-witness and invalidation-event records only. Cascades,
 * blocker/frontier state, holds, drains, slot release, and execution transitions
 * remain outside this zero-authority scheduler-local kernel.
 */
import {
  DEPENDENCY_GATES,
  validateDependencyContract,
  type DependencyGate,
  type DependencyTruthClass,
  type SourceOperationClass,
} from "./dependency-contract.js";
import {
  hasExactDenseArrayShape,
  hasOnlyOwnStringKeys,
  isPlainArray,
  isPlainRecord,
  readOwnArrayElement,
  readOwnDataProperty,
  readPlainArrayLength,
} from "../runtime-shape.js";

export interface DependencyWitness {
  readonly witnessRef: string;
  readonly witnessVersion: number;
  readonly witnessDigest: string;
  readonly sourceOperationClass: SourceOperationClass;
  readonly truthClass: DependencyTruthClass;
}
export interface DependencyInvalidationEvent {
  readonly witnessRef: string;
  readonly sourceFactVersions: readonly { readonly sourceFactRef: string; readonly version: number }[];
  readonly flippedAt: { readonly gate: DependencyGate; readonly contextRef: string; readonly contextVersion: number };
  readonly truthClass: DependencyTruthClass;
}
export type DependencyWitnessIssueCode =
  | "DEPENDENCY_WITNESS_MALFORMED"
  | "DEPENDENCY_WITNESS_CONTRACT_INVALID"
  | "DEPENDENCY_WITNESS_BINDING_MISMATCH"
  | "DEPENDENCY_WITNESS_MONOTONIC_PROOF_INVALID"
  | "DEPENDENCY_INVALIDATION_MALFORMED"
  | "DEPENDENCY_INVALIDATION_MONOTONIC_FORBIDDEN"
  | "DEPENDENCY_INVALIDATION_WITNESS_MISMATCH";
export interface DependencyWitnessIssue {
  readonly code: DependencyWitnessIssueCode;
  readonly message: string;
  readonly nodeKeys: readonly string[];
  readonly edgeKeys: readonly string[];
}
export type DependencyWitnessValidationResult =
  | { readonly ok: true; readonly outcome: "WITNESS_VALIDATED"; readonly stability: "MONOTONIC" | "REVOCABLE"; readonly witness: DependencyWitness }
  | { readonly ok: false; readonly issues: readonly DependencyWitnessIssue[] };
export type DependencyInvalidationResult =
  | { readonly ok: true; readonly outcome: "INVALIDATION_RECORDED"; readonly event: DependencyInvalidationEvent }
  | { readonly ok: false; readonly outcome: "NO_OP_AFTER_HORIZON"; readonly code: "DEPENDENCY_INVALIDATION_AFTER_HORIZON" }
  | { readonly ok: false; readonly issues: readonly DependencyWitnessIssue[] };

const TRUTHS = ["OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN"] as const;
const OPERATIONS = ["ARTIFACT_SEAL", "DAEMON_FACT_OBSERVATION", "SCOPE_OBSERVATION", "POLICY_RULE_EVALUATION"] as const;
const HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_FACTS = 128;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
function isRef(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function isDigest(value: unknown): value is string { return typeof value === "string" && HEX_64.test(value); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, keys)) return null;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) return null;
    output[key] = read.value;
  }
  return output;
}
function issue(code: DependencyWitnessIssueCode, message: string): DependencyWitnessIssue {
  return deepFreeze({ code, message, nodeKeys: [], edgeKeys: [] });
}
function fail(value: DependencyWitnessIssue): DependencyWitnessValidationResult {
  return deepFreeze({ ok: false, issues: [value] });
}
function invalid(value: DependencyWitnessIssue): DependencyInvalidationResult {
  return deepFreeze({ ok: false, issues: [value] });
}

function parseWitness(value: unknown): DependencyWitness | null {
  const item = record(value, ["witnessRef", "witnessVersion", "witnessDigest", "sourceOperationClass", "truthClass"]);
  if (item === null || !isRef(item.witnessRef) || !isVersion(item.witnessVersion) || !isDigest(item.witnessDigest) ||
    !oneOf(item.sourceOperationClass, OPERATIONS) || !oneOf(item.truthClass, TRUTHS)) return null;
  return item as unknown as DependencyWitness;
}
function validateExpectedContract(value: unknown, registry: unknown) {
  if (!isPlainRecord(value)) return null;
  const edgeKind = readOwnDataProperty(value, "edgeKind");
  if (!edgeKind.ok || !edgeKind.present) return null;
  return validateDependencyContract({ edgeKind: edgeKind.value, contract: value }, registry);
}

/** Validate one witness without granting readiness, execution, or mutation authority. */
export function validateDependencyWitness(
  input: unknown,
  expectedContract: unknown,
  registry: unknown = [],
): DependencyWitnessValidationResult {
  const witness = parseWitness(input);
  if (witness === null) return fail(issue("DEPENDENCY_WITNESS_MALFORMED", "dependency witness is malformed"));
  const checked = validateExpectedContract(expectedContract, registry);
  if (checked === null || !checked.ok || checked.graphEdgeKind !== "HARD") {
    const proofInvalid = checked !== null && !checked.ok && checked.issues.some((entry) =>
      entry.code === "DEPENDENCY_MONOTONIC_OPERATION_MISMATCH" || entry.code === "DEPENDENCY_PREDICATE_REGISTRY_MALFORMED");
    return fail(issue(proofInvalid ? "DEPENDENCY_WITNESS_MONOTONIC_PROOF_INVALID" : "DEPENDENCY_WITNESS_CONTRACT_INVALID",
      proofInvalid ? "monotonic witness proof is invalid" : "expected dependency contract is invalid"));
  }
  const binding = checked.contract.satisfactionWitnesses.find((entry) => entry.witnessRef === witness.witnessRef);
  if (binding === undefined || binding.witnessVersion !== witness.witnessVersion || binding.witnessDigest !== witness.witnessDigest ||
    binding.sourceOperationClass !== witness.sourceOperationClass)
    return fail(issue("DEPENDENCY_WITNESS_BINDING_MISMATCH", "witness does not match the contract binding"));
  return deepFreeze({ ok: true, outcome: "WITNESS_VALIDATED", stability: checked.contract.stability, witness: { ...witness } });
}

export function isWithinHorizon(gate: unknown, horizon: unknown): boolean {
  const gateRank = (DEPENDENCY_GATES as readonly unknown[]).indexOf(gate);
  const horizonRank = (DEPENDENCY_GATES as readonly unknown[]).indexOf(horizon);
  return gateRank >= 0 && horizonRank >= 0 && gateRank <= horizonRank;
}
function parseFactVersions(value: unknown): DependencyInvalidationEvent["sourceFactVersions"] | null {
  if (!isPlainArray(value)) return null;
  const length = readPlainArrayLength(value);
  if (length === null || length < 1 || length > MAX_FACTS || !hasExactDenseArrayShape(value, length)) return null;
  const output: { sourceFactRef: string; version: number }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    const item = read.ok && read.present ? record(read.value, ["sourceFactRef", "version"]) : null;
    if (item === null || !isRef(item.sourceFactRef) || seen.has(item.sourceFactRef) || !isVersion(item.version)) return null;
    seen.add(item.sourceFactRef); output.push(item as unknown as { sourceFactRef: string; version: number });
  }
  return output.sort((a, b) => a.sourceFactRef < b.sourceFactRef ? -1 : a.sourceFactRef > b.sourceFactRef ? 1 : 0);
}
function parseInvalidation(value: unknown): DependencyInvalidationEvent | null {
  const item = record(value, ["witnessRef", "sourceFactVersions", "flippedAt", "truthClass"]);
  const flipped = item === null ? null : record(item.flippedAt, ["gate", "contextRef", "contextVersion"]);
  const facts = item === null ? null : parseFactVersions(item.sourceFactVersions);
  if (item === null || flipped === null || facts === null || !isRef(item.witnessRef) ||
    !oneOf(flipped.gate, DEPENDENCY_GATES) || !isRef(flipped.contextRef) || !isVersion(flipped.contextVersion) ||
    !oneOf(item.truthClass, TRUTHS)) return null;
  return { witnessRef: item.witnessRef, sourceFactVersions: facts,
    flippedAt: flipped as unknown as DependencyInvalidationEvent["flippedAt"], truthClass: item.truthClass };
}

/** Record a revocable flip only through its inclusive horizon; never rewrite past history. */
export function evaluateDependencyInvalidation(
  input: unknown,
  expectedWitnessRef: unknown,
  horizon: unknown,
  stability: unknown,
): DependencyInvalidationResult {
  const event = parseInvalidation(input);
  if (event === null || !isRef(expectedWitnessRef) || !oneOf(horizon, DEPENDENCY_GATES) ||
    !oneOf(stability, ["MONOTONIC", "REVOCABLE"] as const))
    return invalid(issue("DEPENDENCY_INVALIDATION_MALFORMED", "dependency invalidation is malformed"));
  if (stability === "MONOTONIC")
    return invalid(issue("DEPENDENCY_INVALIDATION_MONOTONIC_FORBIDDEN", "monotonic witnesses cannot emit invalidation flips"));
  if (event.witnessRef !== expectedWitnessRef)
    return invalid(issue("DEPENDENCY_INVALIDATION_WITNESS_MISMATCH", "invalidation witness does not match"));
  if (!isWithinHorizon(event.flippedAt.gate, horizon))
    return deepFreeze({ ok: false, outcome: "NO_OP_AFTER_HORIZON", code: "DEPENDENCY_INVALIDATION_AFTER_HORIZON" });
  return deepFreeze({ ok: true, outcome: "INVALIDATION_RECORDED", event });
}
