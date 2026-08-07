import { isGraphKey } from "../graph-key.js";
import {
  hasExactDenseArrayShape,
  hasOnlyOwnStringKeys,
  isPlainArray,
  isPlainRecord,
  readOwnArrayElement,
  readOwnDataProperty,
  readPlainArrayLength,
} from "../runtime-shape.js";
export const HARD_DEPENDENCY_KINDS = [
  "ARTIFACT_CONSUMPTION", "STATE_PRECONDITION", "SCOPE_SERIALIZATION", "POLICY_SEQUENCE",
] as const;
export const NONBLOCKING_DEPENDENCY_KINDS = [
  "RELATED", "CONTAINS", "CONTEXT", "PREFERRED_ORDER",
] as const;
export const DEPENDENCY_GATES = [
  "MATERIALIZATION_SEAL", "EXECUTOR_CLAIM", "EFFECT_ACTIVATE", "STEP_START",
  "CANDIDATE_SEAL", "RESULT_SEAL", "EVIDENCE_SEAL", "INTEGRATION_SEAL",
  "REVIEW_QUALIFICATION", "ACCEPTANCE_QUALIFICATION", "GOAL_COMPLETION",
] as const;
export type HardDependencyKind = (typeof HARD_DEPENDENCY_KINDS)[number];
export type NonblockingDependencyKind = (typeof NONBLOCKING_DEPENDENCY_KINDS)[number];
export type DependencyGate = (typeof DEPENDENCY_GATES)[number];
export type DependencyTruthClass =
  | "OBSERVED" | "AGENT_REPORTED" | "DAEMON_VERIFIED" | "HUMAN_APPROVED" | "UNKNOWN";
export type SourceOperationClass =
  | "ARTIFACT_SEAL" | "DAEMON_FACT_OBSERVATION" | "SCOPE_OBSERVATION" | "POLICY_RULE_EVALUATION";
type ProducerFact =
  | { readonly kind: "ARTIFACT_CONSUMPTION"; readonly artifactOrInterfaceRef: string; readonly digest: string }
  | { readonly kind: "STATE_PRECONDITION"; readonly daemonFactRef: string; readonly digest: string }
  | { readonly kind: "SCOPE_SERIALIZATION"; readonly scopeCollisionObservationRef: string; readonly digest: string }
  | { readonly kind: "POLICY_SEQUENCE"; readonly policyRuleId: string; readonly policyHash: string };
export interface DependencyWitnessBinding {
  readonly witnessRef: string; readonly witnessVersion: number; readonly witnessDigest: string;
  readonly sourceOperationClass: SourceOperationClass;
}
export interface DependencyFactBinding {
  readonly sourceFactRef: string; readonly sourceFactVersion: number; readonly sourceFactDigest: string;
}
interface DependencyContractBase {
  readonly producerNodeKey: string; readonly consumerNodeKey: string;
  readonly graphBindingDigest: string;
  readonly consumer: { readonly kind: "PRECONDITION"; readonly criterionRef: string; readonly contractHash: string };
  readonly minimumQualifyingMilestone: "CANDIDATE_SEALED" | "RESULT_SEALED" | "EVIDENCE_SEALED" |
    "INTEGRATION_SEALED" | "REVIEW_QUALIFIED" | "ACCEPTED";
  readonly satisfactionPredicate: { readonly predicateRef: string; readonly schemaId: string;
    readonly schemaVersion: number; readonly parametersDigest: string };
  readonly stability: "MONOTONIC" | "REVOCABLE";
  readonly satisfactionWitnesses: readonly DependencyWitnessBinding[]; readonly consumptionHorizon: DependencyGate;
  readonly necessity: { readonly failedConsumerCriterionRef: string; readonly failureKind:
    "MISSING_ARTIFACT" | "PRECONDITION_FALSE" | "SCOPE_CONFLICT" | "POLICY_VIOLATION";
    readonly truthClass: DependencyTruthClass };
  readonly alternativeRuling: { readonly kind: "NOT_APPLICABLE" | "RULED_OUT"; readonly reason: string } |
    { readonly kind: "INTERFACE_AVAILABLE" | "FIXTURE_AVAILABLE"; readonly ref: string; readonly digest: string };
  readonly alternateProducers: readonly string[]; readonly truthClass: DependencyTruthClass;
  readonly invalidationFacts: readonly DependencyFactBinding[]; readonly recheckPredicateRef: string;
}
export type DependencyContract = { [Kind in HardDependencyKind]: DependencyContractBase & {
  readonly edgeKind: Kind; readonly producer: Extract<ProducerFact, { readonly kind: Kind }>; } }[HardDependencyKind];
export interface DependencyRequirement {
  readonly edgeKind: HardDependencyKind | NonblockingDependencyKind; readonly contract?: unknown;
}
export interface MonotonicPredicateRegistryEntry {
  readonly predicateRef: string; readonly schemaId: string; readonly schemaVersion: number;
  readonly parameterSchema: { readonly kind: "JSON_SCHEMA"; readonly digest: string };
  readonly sourceOperationClass: SourceOperationClass; readonly proofRationale: string;
}
export type DependencyIssueCode =
  | "DEPENDENCY_REQUIREMENT_MALFORMED" | "DEPENDENCY_HARD_CONTRACT_REQUIRED"
  | "DEPENDENCY_ADVISORY_CONTRACT_FORBIDDEN" | "DEPENDENCY_CONTRACT_MALFORMED"
  | "DEPENDENCY_PRODUCER_KIND_MISMATCH" | "DEPENDENCY_PREDICATE_REGISTRY_MALFORMED"
  | "DEPENDENCY_MONOTONIC_OPERATION_MISMATCH";
export interface DependencyIssue { readonly code: DependencyIssueCode; readonly message: string;
  readonly nodeKeys: readonly string[]; readonly edgeKeys: readonly string[] }
export type DependencyContractValidationResult =
  | { readonly ok: true; readonly graphEdgeKind: "HARD"; readonly contract: DependencyContract }
  | { readonly ok: true; readonly graphEdgeKind: "ADVISORY" }
  | { readonly ok: false; readonly issues: readonly DependencyIssue[] };
const CONTRACT_KEYS = ["producerNodeKey", "consumerNodeKey", "edgeKind", "graphBindingDigest", "producer",
  "consumer", "minimumQualifyingMilestone", "satisfactionPredicate", "stability", "satisfactionWitnesses",
  "consumptionHorizon", "necessity", "alternativeRuling", "alternateProducers", "truthClass",
  "invalidationFacts", "recheckPredicateRef"] as const;
const HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_ITEMS = 128;
const MILESTONES = ["CANDIDATE_SEALED", "RESULT_SEALED", "EVIDENCE_SEALED", "INTEGRATION_SEALED", "REVIEW_QUALIFIED", "ACCEPTED"] as const;
const TRUTH_CLASSES = ["OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN"] as const;
const OPERATIONS = ["ARTIFACT_SEAL", "DAEMON_FACT_OBSERVATION", "SCOPE_OBSERVATION", "POLICY_RULE_EVALUATION"] as const;
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}
function compareStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function makeIssue(code: DependencyIssueCode, message: string, nodeKeys: readonly string[] = []): DependencyIssue {
  return deepFreeze({ code, message, nodeKeys: [...nodeKeys], edgeKeys: [] });
}
function sortIssues(issues: readonly DependencyIssue[]): DependencyIssue[] {
  return [...issues].sort((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b)));
}
function fail(...issues: readonly DependencyIssue[]): DependencyContractValidationResult {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
function isRef(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isDigest(value: unknown): value is string { return typeof value === "string" && HEX_64.test(value); }
function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function record(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, allowed)) return null;
  const output: Record<string, unknown> = {};
  for (const key of required) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) return null;
    output[key] = read.value;
  }
  for (const key of allowed) {
    if (key in output) continue;
    const read = readOwnDataProperty(value, key);
    if (!read.ok) return null;
    if (read.present) output[key] = read.value;
  }
  return output;
}
function denseArray(value: unknown, minimum: number): unknown[] | null {
  if (!isPlainArray(value)) return null;
  const length = readPlainArrayLength(value);
  if (length === null || length < minimum || length > MAX_ITEMS || !hasExactDenseArrayShape(value, length)) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    if (!read.ok || !read.present) return null;
    result.push(read.value);
  }
  return result;
}
function parseProducer(value: unknown): ProducerFact | null {
  const base = record(value, ["kind", "artifactOrInterfaceRef", "daemonFactRef", "scopeCollisionObservationRef", "policyRuleId", "digest", "policyHash"], ["kind"]);
  if (base === null || !oneOf(base.kind, HARD_DEPENDENCY_KINDS)) return null;
  const shapes: Record<HardDependencyKind, readonly string[]> = {
    ARTIFACT_CONSUMPTION: ["kind", "artifactOrInterfaceRef", "digest"],
    STATE_PRECONDITION: ["kind", "daemonFactRef", "digest"],
    SCOPE_SERIALIZATION: ["kind", "scopeCollisionObservationRef", "digest"],
    POLICY_SEQUENCE: ["kind", "policyRuleId", "policyHash"],
  };
  const exact = record(value, shapes[base.kind]);
  if (exact === null) return null;
  const referenceKey = shapes[base.kind][1]!;
  const digestKey = shapes[base.kind][2]!;
  if (!isRef(exact[referenceKey]) || !isDigest(exact[digestKey])) return null;
  return { kind: base.kind, [referenceKey]: exact[referenceKey], [digestKey]: exact[digestKey] } as ProducerFact;
}
function parseWitnesses(value: unknown): DependencyWitnessBinding[] | null {
  const entries = denseArray(value, 1); if (entries === null) return null;
  const output: DependencyWitnessBinding[] = []; const seen = new Set<string>();
  for (const entry of entries) {
    const item = record(entry, ["witnessRef", "witnessVersion", "witnessDigest", "sourceOperationClass"]);
    if (item === null || !isRef(item.witnessRef) || seen.has(item.witnessRef) || !isVersion(item.witnessVersion) ||
      !isDigest(item.witnessDigest) || !oneOf(item.sourceOperationClass, OPERATIONS)) return null;
    seen.add(item.witnessRef);
    output.push(item as unknown as DependencyWitnessBinding);
  }
  return output.sort((a, b) => compareStrings(a.witnessRef, b.witnessRef));
}
function parseFacts(value: unknown): DependencyFactBinding[] | null {
  const entries = denseArray(value, 1); if (entries === null) return null;
  const output: DependencyFactBinding[] = []; const seen = new Set<string>();
  for (const entry of entries) {
    const item = record(entry, ["sourceFactRef", "sourceFactVersion", "sourceFactDigest"]);
    if (item === null || !isRef(item.sourceFactRef) || seen.has(item.sourceFactRef) ||
      !isVersion(item.sourceFactVersion) || !isDigest(item.sourceFactDigest)) return null;
    seen.add(item.sourceFactRef); output.push(item as unknown as DependencyFactBinding);
  }
  return output.sort((a, b) => compareStrings(a.sourceFactRef, b.sourceFactRef));
}
function parseRegistry(value: unknown): MonotonicPredicateRegistryEntry[] | null {
  const entries = denseArray(value, 0); if (entries === null) return null;
  const output: MonotonicPredicateRegistryEntry[] = []; const seen = new Set<string>();
  for (const entry of entries) {
    const item = record(entry, ["predicateRef", "schemaId", "schemaVersion", "parameterSchema", "sourceOperationClass", "proofRationale"]);
    const schema = item === null ? null : record(item.parameterSchema, ["kind", "digest"]);
    if (item === null || schema === null || schema.kind !== "JSON_SCHEMA" || !isDigest(schema.digest) ||
      !isRef(item.predicateRef) || !isRef(item.schemaId) || !isVersion(item.schemaVersion) ||
      !oneOf(item.sourceOperationClass, OPERATIONS) || !isRef(item.proofRationale)) return null;
    const key = JSON.stringify([item.predicateRef, item.schemaId, item.schemaVersion]);
    if (seen.has(key)) return null; seen.add(key);
    output.push({ ...item, parameterSchema: schema } as unknown as MonotonicPredicateRegistryEntry);
  }
  return output;
}
function parseContract(value: unknown): DependencyContract | null {
  const item = record(value, CONTRACT_KEYS); if (item === null) return null;
  const producer = parseProducer(item.producer);
  const consumer = record(item.consumer, ["kind", "criterionRef", "contractHash"]);
  const predicate = record(item.satisfactionPredicate, ["predicateRef", "schemaId", "schemaVersion", "parametersDigest"]);
  const necessity = record(item.necessity, ["failedConsumerCriterionRef", "failureKind", "truthClass"]);
  const alternative = parseAlternative(item.alternativeRuling);
  const witnesses = parseWitnesses(item.satisfactionWitnesses); const facts = parseFacts(item.invalidationFacts);
  const alternates = denseArray(item.alternateProducers, 0);
  if (!isGraphKey(item.producerNodeKey) || !isGraphKey(item.consumerNodeKey) || !oneOf(item.edgeKind, HARD_DEPENDENCY_KINDS) ||
    !isDigest(item.graphBindingDigest) || producer === null || consumer === null || consumer.kind !== "PRECONDITION" ||
    !isRef(consumer.criterionRef) || !isDigest(consumer.contractHash) || !oneOf(item.minimumQualifyingMilestone, MILESTONES) ||
    predicate === null || !isRef(predicate.predicateRef) || !isRef(predicate.schemaId) || !isVersion(predicate.schemaVersion) || !isDigest(predicate.parametersDigest) ||
    !oneOf(item.stability, ["MONOTONIC", "REVOCABLE"] as const) || witnesses === null || !oneOf(item.consumptionHorizon, DEPENDENCY_GATES) ||
    necessity === null || !isRef(necessity.failedConsumerCriterionRef) || !oneOf(necessity.failureKind, ["MISSING_ARTIFACT", "PRECONDITION_FALSE", "SCOPE_CONFLICT", "POLICY_VIOLATION"] as const) ||
    !oneOf(necessity.truthClass, TRUTH_CLASSES) || alternative === null || alternates === null || !alternates.every(isGraphKey) ||
    new Set(alternates).size !== alternates.length || !oneOf(item.truthClass, TRUTH_CLASSES) || facts === null || !isRef(item.recheckPredicateRef)) return null;
  return { ...item, producer, consumer, satisfactionPredicate: predicate, satisfactionWitnesses: witnesses,
    necessity, alternativeRuling: alternative, alternateProducers: [...alternates].sort(), invalidationFacts: facts } as unknown as DependencyContract;
}
function parseAlternative(value: unknown): DependencyContract["alternativeRuling"] | null {
  const tagged = record(value, ["kind", "reason", "ref", "digest"], ["kind"]); if (tagged === null) return null;
  if (oneOf(tagged.kind, ["NOT_APPLICABLE", "RULED_OUT"] as const)) {
    const item = record(value, ["kind", "reason"]); return item !== null && isRef(item.reason) ? item as never : null;
  }
  if (oneOf(tagged.kind, ["INTERFACE_AVAILABLE", "FIXTURE_AVAILABLE"] as const)) {
    const item = record(value, ["kind", "ref", "digest"]); return item !== null && isRef(item.ref) && isDigest(item.digest) ? item as never : null;
  }
  return null;
}
/** Zero-authority validation/projection; it grants no readiness or mutation authority. */
export function validateDependencyContract(input: unknown, registryInput: unknown = []): DependencyContractValidationResult {
  const registry = parseRegistry(registryInput);
  if (registry === null) return fail(makeIssue("DEPENDENCY_PREDICATE_REGISTRY_MALFORMED", "monotonic predicate registry is malformed"));
  const requirement = record(input, ["edgeKind", "contract"], ["edgeKind"]);
  if (requirement === null || !oneOf(requirement.edgeKind, [...HARD_DEPENDENCY_KINDS, ...NONBLOCKING_DEPENDENCY_KINDS]))
    return fail(makeIssue("DEPENDENCY_REQUIREMENT_MALFORMED", "dependency requirement is malformed"));
  const hasContract = Object.hasOwn(requirement, "contract");
  if (oneOf(requirement.edgeKind, NONBLOCKING_DEPENDENCY_KINDS)) {
    return hasContract ? fail(makeIssue("DEPENDENCY_ADVISORY_CONTRACT_FORBIDDEN", "non-blocking relations cannot carry dependency contracts"))
      : deepFreeze({ ok: true, graphEdgeKind: "ADVISORY" });
  }
  if (!hasContract) return fail(makeIssue("DEPENDENCY_HARD_CONTRACT_REQUIRED", "hard dependency edges require a complete contract"));
  const contract = parseContract(requirement.contract);
  if (contract === null || contract.edgeKind !== requirement.edgeKind)
    return fail(makeIssue("DEPENDENCY_CONTRACT_MALFORMED", "dependency contract is malformed or incomplete"));
  if (contract.producer.kind !== contract.edgeKind)
    return fail(makeIssue("DEPENDENCY_PRODUCER_KIND_MISMATCH", "producer fact kind must match edgeKind", [contract.producerNodeKey, contract.consumerNodeKey]));
  const proof = registry.find((entry) => entry.predicateRef === contract.satisfactionPredicate.predicateRef &&
    entry.schemaId === contract.satisfactionPredicate.schemaId && entry.schemaVersion === contract.satisfactionPredicate.schemaVersion);
  if (contract.stability === "MONOTONIC" && proof !== undefined &&
    contract.satisfactionWitnesses.some((witness) => witness.sourceOperationClass !== proof.sourceOperationClass))
    return fail(makeIssue("DEPENDENCY_MONOTONIC_OPERATION_MISMATCH", "witness source operation does not match registered predicate"));
  const normalized = proof === undefined && contract.stability === "MONOTONIC" ? { ...contract, stability: "REVOCABLE" as const } : contract;
  return deepFreeze({ ok: true, graphEdgeKind: "HARD", contract: normalized });
}
