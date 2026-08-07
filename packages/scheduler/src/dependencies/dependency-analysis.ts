import type { RedundancyCandidate } from "../graph-model.js";
import { isGraphKey } from "../graph-key.js";
import { hasExactDenseArrayShape, hasOnlyOwnStringKeys, isPlainArray, isPlainRecord,
  readOwnArrayElement, readOwnDataProperty, readPlainArrayLength } from "../runtime-shape.js";
import { validateDependencyContract, type DependencyContract } from "./dependency-contract.js";
export interface ContractRedundancyAssessment {
  readonly kind: "REDUNDANCY_CANDIDATE";
  readonly structuralCandidate: RedundancyCandidate;
  readonly contractComparison: {
    readonly producerArmEquivalent: boolean;
    readonly satisfactionPredicateEquivalent: boolean;
    readonly consumptionHorizonEquivalent: boolean;
  };
  readonly requiresSemanticProof: true;
  readonly semanticProofObligation: {
    readonly kind: "PROVE_EQUIVALENT_SATISFACTION_AND_INVALIDATION";
    readonly directEdgeKey: string;
    readonly alternatePathEdgeKeys: readonly string[];
  };
}
export type DependencyChallengeStatus =
  | { readonly kind: "OPEN" | "MAPPED_TO_EXISTING_CONTRACT" | "RESOLVED_BY_SUPERSESSION" | "CLOSED_NO_CHANGE" | "SUPERSEDED" }
  | { readonly kind: "DEDUPLICATED"; readonly existingChallengeRef: string };
export type DependencyChallengeSubject =
  | { readonly kind: "MISSING_EDGE_DISCOVERY"; readonly producerNodeKey: string; readonly consumerNodeKey: string;
    readonly holdNodeKey: string; readonly edgeHash: string; readonly truthClass: "AGENT_REPORTED";
    readonly callerLeaseRef: string; readonly callerLeaseVersion: number }
  | { readonly kind: "EXISTING_EDGE_NECESSITY"; readonly edgeKey: string; readonly contractHash: string;
    readonly blockerKind: "SEMANTIC_PREREQUISITE" };
export interface DependencyChallenge {
  readonly challengeRef: string; readonly subject: DependencyChallengeSubject;
  readonly binding: { readonly graphEpoch: number;
    readonly sourceFactVersions: readonly { readonly sourceFactRef: string; readonly version: number }[] };
  readonly status: DependencyChallengeStatus; readonly successorPlanningRunRef: string;
  readonly successorPlanningRunVersion: number; readonly dedupKey: string;
}
export type DependencyAnalysisIssueCode =
  | "DEPENDENCY_ANALYSIS_MALFORMED" | "DEPENDENCY_ANALYSIS_CONTRACT_INVALID" | "DEPENDENCY_ANALYSIS_PATH_MISMATCH"
  | "DEPENDENCY_CHALLENGE_MALFORMED" | "DEPENDENCY_CHALLENGE_FOREIGN_HOLD"
  | "DEPENDENCY_CHALLENGE_MUTUAL_HOLD" | "DEPENDENCY_CHALLENGE_DEDUP_REQUIRED"
  | "DEPENDENCY_CHALLENGE_CONTRACT_NOT_CURRENT";
export interface DependencyAnalysisIssue { readonly code: DependencyAnalysisIssueCode; readonly message: string;
  readonly nodeKeys: readonly string[]; readonly edgeKeys: readonly string[] }
export type ContractRedundancyResult =
  | { readonly ok: true; readonly assessment: ContractRedundancyAssessment }
  | { readonly ok: false; readonly issues: readonly DependencyAnalysisIssue[] };
export type DependencyChallengeResult =
  | { readonly ok: true; readonly challenge: DependencyChallenge }
  | { readonly ok: false; readonly issues: readonly DependencyAnalysisIssue[] };
const HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_ITEMS = 128;
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}
function issue(code: DependencyAnalysisIssueCode, message: string, nodeKeys: readonly string[] = [], edgeKeys: readonly string[] = []): DependencyAnalysisIssue {
  return deepFreeze({ code, message, nodeKeys: [...nodeKeys], edgeKeys: [...edgeKeys] });
}
function failure<T extends ContractRedundancyResult | DependencyChallengeResult>(value: DependencyAnalysisIssue): T {
  return deepFreeze({ ok: false, issues: [value] }) as unknown as T;
}
function isRef(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isDigest(value: unknown): value is string { return typeof value === "string" && HEX_64.test(value); }
function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
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
function dense(value: unknown, minimum = 0): unknown[] | null {
  if (!isPlainArray(value)) return null;
  const length = readPlainArrayLength(value);
  if (length === null || length < minimum || length > MAX_ITEMS || !hasExactDenseArrayShape(value, length)) return null;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    if (!read.ok || !read.present) return null;
    output.push(read.value);
  }
  return output;
}
function stringArray(value: unknown, minimum: number): string[] | null {
  const values = dense(value, minimum);
  return values !== null && values.every(isGraphKey) ? values as string[] : null;
}
function checkedContract(value: unknown, registry: unknown): DependencyContract | null {
  if (!isPlainRecord(value)) return null;
  const edgeKind = readOwnDataProperty(value, "edgeKind");
  if (!edgeKind.ok || !edgeKind.present) return null;
  const result = validateDependencyContract({ edgeKind: edgeKind.value, contract: value }, registry);
  return result.ok && result.graphEdgeKind === "HARD" ? result.contract : null;
}
function parseCandidate(value: unknown): RedundancyCandidate | null {
  const item = record(value, ["edgeKey", "producerNodeKey", "consumerNodeKey", "alternateHardPathNodeKeys",
    "alternateHardPathEdgeKeys", "requiresSemanticProof"]);
  const nodes = item === null ? null : stringArray(item.alternateHardPathNodeKeys, 2);
  const edges = item === null ? null : stringArray(item.alternateHardPathEdgeKeys, 1);
  if (item === null || nodes === null || edges === null || !isGraphKey(item.edgeKey) ||
    !isGraphKey(item.producerNodeKey) || !isGraphKey(item.consumerNodeKey) || item.requiresSemanticProof !== true ||
    nodes.length !== edges.length + 1 || edges.includes(item.edgeKey) || new Set(nodes).size !== nodes.length || new Set(edges).size !== edges.length ||
    nodes[0] !== item.producerNodeKey || nodes.at(-1) !== item.consumerNodeKey) return null;
  return { edgeKey: item.edgeKey, producerNodeKey: item.producerNodeKey, consumerNodeKey: item.consumerNodeKey,
    alternateHardPathNodeKeys: nodes, alternateHardPathEdgeKeys: edges, requiresSemanticProof: true };
}
function contractsForPath(value: unknown, candidate: RedundancyCandidate, registry: unknown): DependencyContract[] | null {
  const values = dense(value, 1);
  if (values === null || values.length !== candidate.alternateHardPathEdgeKeys.length) return null;
  const contracts = values.map((entry) => checkedContract(entry, registry));
  if (contracts.some((entry) => entry === null)) return null;
  const typed = contracts as DependencyContract[];
  return typed.every((contract, index) => contract.producerNodeKey === candidate.alternateHardPathNodeKeys[index] &&
    contract.consumerNodeKey === candidate.alternateHardPathNodeKeys[index + 1]) ? typed : null;
}
/** A semantic-proof obligation only; never edge-removal or activation authority. */
export function assessContractRedundancy(input: unknown, registry: unknown = []): ContractRedundancyResult {
  const item = record(input, ["structuralCandidate", "directContract", "alternatePathContracts"]);
  const candidate = item === null ? null : parseCandidate(item.structuralCandidate);
  if (item === null || candidate === null)
    return failure(issue("DEPENDENCY_ANALYSIS_MALFORMED", "dependency redundancy input is malformed"));
  const direct = checkedContract(item.directContract, registry);
  const alternate = contractsForPath(item.alternatePathContracts, candidate, registry);
  if (direct === null || alternate === null)
    return failure(issue("DEPENDENCY_ANALYSIS_CONTRACT_INVALID", "dependency redundancy contract is invalid"));
  if (direct.producerNodeKey !== candidate.producerNodeKey || direct.consumerNodeKey !== candidate.consumerNodeKey ||
    alternate.some((entry) => entry.graphBindingDigest !== direct.graphBindingDigest))
    return failure(issue("DEPENDENCY_ANALYSIS_PATH_MISMATCH", "direct contract does not match structural candidate"));
  const predicate = JSON.stringify(direct.satisfactionPredicate);
  const assessment: ContractRedundancyAssessment = {
    kind: "REDUNDANCY_CANDIDATE", structuralCandidate: candidate,
    contractComparison: {
      producerArmEquivalent: alternate.every((entry) => JSON.stringify(entry.producer) === JSON.stringify(direct.producer)),
      satisfactionPredicateEquivalent: alternate.every((entry) => JSON.stringify(entry.satisfactionPredicate) === predicate),
      consumptionHorizonEquivalent: alternate.every((entry) => entry.consumptionHorizon === direct.consumptionHorizon),
    }, requiresSemanticProof: true,
    semanticProofObligation: { kind: "PROVE_EQUIVALENT_SATISFACTION_AND_INVALIDATION",
      directEdgeKey: candidate.edgeKey, alternatePathEdgeKeys: [...candidate.alternateHardPathEdgeKeys] },
  };
  return deepFreeze({ ok: true, assessment });
}
function parseFactVersions(value: unknown) {
  const values = dense(value, 1); if (values === null) return null;
  const output: { sourceFactRef: string; version: number }[] = []; const seen = new Set<string>();
  for (const value of values) {
    const item = record(value, ["sourceFactRef", "version"]);
    if (item === null || !isRef(item.sourceFactRef) || seen.has(item.sourceFactRef) || !isVersion(item.version)) return null;
    seen.add(item.sourceFactRef); output.push(item as unknown as { sourceFactRef: string; version: number });
  }
  return output.sort((a, b) => a.sourceFactRef < b.sourceFactRef ? -1 : a.sourceFactRef > b.sourceFactRef ? 1 : 0);
}
function parseStatus(value: unknown): DependencyChallengeStatus | null {
  const tagged = isPlainRecord(value) ? readOwnDataProperty(value, "kind") : null;
  if (tagged === null || !tagged.ok || !tagged.present) return null;
  const simple = ["OPEN", "MAPPED_TO_EXISTING_CONTRACT", "RESOLVED_BY_SUPERSESSION", "CLOSED_NO_CHANGE", "SUPERSEDED"];
  if (typeof tagged.value === "string" && simple.includes(tagged.value)) {
    const item = record(value, ["kind"]); return item as unknown as DependencyChallengeStatus | null;
  }
  if (tagged.value === "DEDUPLICATED") {
    const item = record(value, ["kind", "existingChallengeRef"]);
    return item !== null && isRef(item.existingChallengeRef) ? item as unknown as DependencyChallengeStatus : null;
  }
  return null;
}
function parseSubject(value: unknown): DependencyChallengeSubject | null {
  const tagged = isPlainRecord(value) ? readOwnDataProperty(value, "kind") : null;
  if (tagged === null || !tagged.ok || !tagged.present) return null;
  if (tagged.value === "MISSING_EDGE_DISCOVERY") {
    const item = record(value, ["kind", "producerNodeKey", "consumerNodeKey", "holdNodeKey", "edgeHash", "truthClass", "callerLeaseRef", "callerLeaseVersion"]);
    return item !== null && isGraphKey(item.producerNodeKey) && isGraphKey(item.consumerNodeKey) && isGraphKey(item.holdNodeKey) &&
      item.producerNodeKey !== item.consumerNodeKey && isDigest(item.edgeHash) && item.truthClass === "AGENT_REPORTED" &&
      isRef(item.callerLeaseRef) && isVersion(item.callerLeaseVersion) ? item as unknown as DependencyChallengeSubject : null;
  }
  if (tagged.value === "EXISTING_EDGE_NECESSITY") {
    const item = record(value, ["kind", "edgeKey", "contractHash", "blockerKind"]);
    return item !== null && isGraphKey(item.edgeKey) && isDigest(item.contractHash) && item.blockerKind === "SEMANTIC_PREREQUISITE"
      ? item as unknown as DependencyChallengeSubject : null;
  }
  return null;
}
function parseOpenChallenge(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const tagged = readOwnDataProperty(value, "kind");
  if (!tagged.ok || !tagged.present) return null;
  const keys = tagged.value === "MISSING_EDGE_DISCOVERY"
    ? ["kind", "producerNodeKey", "consumerNodeKey", "challengeRef", "dedupKey"]
    : tagged.value === "EXISTING_EDGE_NECESSITY" ? ["kind", "challengeRef", "dedupKey"] : null;
  const item = keys === null ? null : record(value, keys);
  if (item === null || !isRef(item.challengeRef) || !isRef(item.dedupKey)) return null;
  if (tagged.value === "MISSING_EDGE_DISCOVERY" &&
    (!isGraphKey(item.producerNodeKey) || !isGraphKey(item.consumerNodeKey))) return null;
  return item;
}
function parseContext(value: unknown) {
  const item = record(value, ["callerLease", "currentHardContracts", "openChallenges"]);
  const lease = item === null ? null : record(item.callerLease, ["nodeKey", "leaseRef", "leaseVersion"]);
  const contracts = item === null ? null : dense(item.currentHardContracts);
  const challenges = item === null ? null : dense(item.openChallenges);
  if (lease === null || contracts === null || challenges === null || !isGraphKey(lease.nodeKey) || !isRef(lease.leaseRef) || !isVersion(lease.leaseVersion)) return null;
  const current = contracts.map((entry) => record(entry, ["edgeKey", "contractHash"]));
  const open = challenges.map(parseOpenChallenge);
  if (current.some((entry) => entry === null || !isGraphKey(entry.edgeKey) || !isDigest(entry.contractHash)) ||
    open.some((entry) => entry === null)) return null;
  const currentKeys = current.map((entry) => entry!.edgeKey as string);
  const openRefs = open.map((entry) => entry!.challengeRef as string);
  const openKeys = open.map((entry) => entry!.dedupKey as string);
  if (new Set(currentKeys).size !== currentKeys.length || new Set(openRefs).size !== openRefs.length ||
    new Set(openKeys).size !== openKeys.length) return null;
  return { lease, current: current as Record<string, unknown>[], open: open as Record<string, unknown>[] };
}
/** Validate a challenge proposal only; approved supersession remains the sole graph-mutation path. */
export function validateDependencyChallenge(input: unknown, contextInput: unknown): DependencyChallengeResult {
  const item = record(input, ["challengeRef", "subject", "binding", "status", "successorPlanningRunRef", "successorPlanningRunVersion"]);
  const binding = item === null ? null : record(item.binding, ["graphEpoch", "sourceFactVersions"]);
  const facts = binding === null ? null : parseFactVersions(binding.sourceFactVersions);
  const subject = item === null ? null : parseSubject(item.subject); const status = item === null ? null : parseStatus(item.status);
  const context = parseContext(contextInput);
  if (item === null || binding === null || facts === null || subject === null || status === null || context === null ||
    !isRef(item.challengeRef) || !isVersion(binding.graphEpoch) || !isRef(item.successorPlanningRunRef) || !isVersion(item.successorPlanningRunVersion))
    return failure(issue("DEPENDENCY_CHALLENGE_MALFORMED", "dependency challenge is malformed"));
  const hash = subject.kind === "MISSING_EDGE_DISCOVERY" ? subject.edgeHash : subject.contractHash;
  const dedupKey = JSON.stringify(["moe-dependency-challenge/1", subject.kind, hash, binding.graphEpoch,
    facts.map((entry) => [entry.sourceFactRef, entry.version])]);
  if (subject.kind === "MISSING_EDGE_DISCOVERY") {
    if (subject.holdNodeKey !== context.lease.nodeKey || subject.consumerNodeKey !== context.lease.nodeKey ||
      subject.callerLeaseRef !== context.lease.leaseRef || subject.callerLeaseVersion !== context.lease.leaseVersion)
      return failure(issue("DEPENDENCY_CHALLENGE_FOREIGN_HOLD", "agent discovery may hold only its leased node", [subject.holdNodeKey]));
    if (context.open.some((entry) => entry.kind === "MISSING_EDGE_DISCOVERY" &&
      entry.producerNodeKey === subject.consumerNodeKey && entry.consumerNodeKey === subject.producerNodeKey))
      return failure(issue("DEPENDENCY_CHALLENGE_MUTUAL_HOLD", "mutual hidden dependency holds are forbidden", [subject.producerNodeKey, subject.consumerNodeKey]));
  } else if (!context.current.some((entry) => entry.edgeKey === subject.edgeKey && entry.contractHash === subject.contractHash)) {
    return failure(issue("DEPENDENCY_CHALLENGE_CONTRACT_NOT_CURRENT", "semantic prerequisite must reference a current hard contract", [], [subject.edgeKey]));
  }
  const duplicate = context.open.find((entry) => entry.dedupKey === dedupKey);
  if ((duplicate === undefined && status.kind === "DEDUPLICATED") || (duplicate !== undefined &&
    (status.kind !== "DEDUPLICATED" || status.existingChallengeRef !== duplicate.challengeRef || duplicate.challengeRef === item.challengeRef)))
    return failure(issue("DEPENDENCY_CHALLENGE_DEDUP_REQUIRED", "matching challenge identity must bind its existing challenge"));
  return deepFreeze({ ok: true, challenge: { challengeRef: item.challengeRef, subject, binding: {
    graphEpoch: binding.graphEpoch, sourceFactVersions: facts }, status, successorPlanningRunRef: item.successorPlanningRunRef,
    successorPlanningRunVersion: item.successorPlanningRunVersion, dedupKey } as DependencyChallenge });
}
