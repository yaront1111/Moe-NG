/**
 * Admission-local types, stable reason codes, and hostile-input helpers.
 *
 * Zero authority: nothing here removes an edge, upgrades a truth class, or
 * transitions any lifecycle state. Structural facts (cycles, self edges, node
 * and hard-edge limits, completion closure) are NEVER re-coded here — they pass
 * through from `validateGraphSnapshot` under their landed `GRAPH_*` codes.
 */
import type { ContractRedundancyAssessment } from "../dependencies/dependency-analysis.js";
import type {
  DependencyContract, DependencyIssueCode, DependencyTruthClass,
} from "../dependencies/dependency-contract.js";
import type { GraphIssueCode, GraphKey, StructuralDiagnostic } from "../graph-model.js";
import type { HardEdgeCounterfactualAnalysis } from "../hard-edge-counterfactual-model.js";
import {
  hasExactDenseArrayShape, hasOnlyOwnStringKeys, isPlainArray, isPlainRecord,
  readOwnArrayElement, readOwnDataProperty, readPlainArrayLength,
} from "../runtime-shape.js";

/** Closed admission-local code union. Disjoint from GRAPH_*, FRONTIER_*, DEPENDENCY_*. */
export type AdmissionIssueCode =
  | "ADMISSION_INPUT_MALFORMED"
  | "ADMISSION_CROSS_SNAPSHOT_INPUT"
  | "ADMISSION_CONTRACT_INCOMPATIBLE"
  | "ADMISSION_DUPLICATE_CONTRACT"
  | "ADMISSION_STALE_FACT"
  | "ADMISSION_HARD_DEPENDENCY_UNPROVEN"
  | "ADMISSION_MINIMUM_MILESTONE_OVERSTATED"
  | "ADMISSION_EDGE_SEMANTICALLY_REDUNDANT"
  | "ADMISSION_ESTIMATE_MALFORMED"
  | "ADMISSION_EXPANSION_LINEAGE_MALFORMED"
  | "ADMISSION_EXPANSION_DEPTH_EXCEEDED"
  | "ADMISSION_EXPANSION_CHILD_WIDTH_EXCEEDED"
  | "ADMISSION_EXPANSION_FANOUT_EXCEEDED"
  | "ADMISSION_NECESSITY_CLAIM_MALFORMED"
  | "ADMISSION_WAIT_MALFORMED"
  | "ADMISSION_WAIT_HORIZON_INVALID";

export interface AdmissionIssue {
  /**
   * An admission-local code, or a landed graph/dependency code passed through.
   * A structural or contract fact is NEVER re-coded under an admission synonym.
   */
  readonly code: AdmissionIssueCode | GraphIssueCode | DependencyIssueCode;
  readonly message: string;
  readonly nodeKeys: readonly GraphKey[];
  readonly edgeKeys: readonly GraphKey[];
}

/** Caller-supplied estimate. `value === null` if and only if truthClass is UNKNOWN. */
export interface AdmissionEstimate {
  readonly value: number | null;
  readonly truthClass: DependencyTruthClass;
}

export interface AdmissionEstimates {
  readonly proposedDuration: AdmissionEstimate;
  readonly sequentialBaselineDuration: AdmissionEstimate;
  readonly proposedCost: AdmissionEstimate;
  readonly sequentialBaselineCost: AdmissionEstimate;
}

/** Every field is copied from `analyzeGraphStructure`; nothing is recomputed. */
export interface AdmissionStructuralSummary {
  readonly structuralStageCount: number;
  readonly criticalPathHardEdgeCount: number;
  readonly maxHardDescendantCount: number;
  /** null = UNKNOWN without frontier facts; never fabricated as zero. */
  readonly logicalReadyWidth: number | null;
  readonly admissionReadyWidth: number | null;
  readonly dispatchableWidth: number | null;
}

export interface AdmissionBaselineRecord {
  readonly proposed: AdmissionStructuralSummary;
  readonly sequentialBaseline: AdmissionStructuralSummary;
  readonly estimates: AdmissionEstimates;
  /** Admission proves no duration and makes no speed claim. */
  readonly durationEstimate: null;
}

/** Design-404 obligations recorded for review; admission generates no stub. */
export interface AdmissionStubConstraints {
  readonly nonProduction: true;
  readonly approvedInterfaceContractHash: string;
  readonly approvedInterfaceRef: string;
  readonly approvedInterfaceDigest: string;
  readonly requiredConformanceRecipes: readonly ["PRODUCER", "CONSUMER"];
  readonly replacedAndVerifiedAtIntegration: true;
}

export interface AdmissionInterfaceFirstRecord {
  /** The landed INTERFACE_FIRST_REVIEW_REQUIRED diagnostic, unmodified. */
  readonly diagnostic: StructuralDiagnostic;
  readonly alternativeRuling: DependencyContract["alternativeRuling"] | null;
  readonly stubConstraints: AdmissionStubConstraints | null;
  readonly reviewOnly: true;
}

export type AdmissionReductionOutcome =
  | "FULL_IDENTITY"
  | "PARTIAL_EQUIVALENCE"
  | "ASSESSMENT_UNAVAILABLE";

export interface AdmissionReductionRecord {
  readonly edgeKey: GraphKey;
  readonly outcome: AdmissionReductionOutcome;
  /** The kernel assessment, passed through byte-for-byte or null when unavailable. */
  readonly assessment: ContractRedundancyAssessment | null;
  readonly reviewOnly: true;
}

export interface AdmissionExpansionRecord {
  readonly facts: {
    readonly expansionDepth: number;
    readonly childWidth: number;
    readonly nodesAddedInExpansion: number;
  };
  readonly limits: {
    readonly maxExpansionDepth: 3;
    readonly maxChildWidth: 6;
    readonly maxNodesPerExpansion: 9;
  };
  readonly raiseReference: { readonly kind: "R2_EXPANSION_LIMIT_RAISE"; readonly reviewOnly: true };
}

/** Evidence artifacts. Records are never refusals and never mutation authority. */
export interface AdmissionRecords {
  readonly baseline: AdmissionBaselineRecord;
  readonly interfaceFirst: readonly AdmissionInterfaceFirstRecord[];
  readonly reduction: readonly AdmissionReductionRecord[];
  readonly counterfactuals: HardEdgeCounterfactualAnalysis;
  readonly expansion: AdmissionExpansionRecord | null;
}

export type AdmissionResult =
  | { readonly ok: true; readonly records: AdmissionRecords }
  | { readonly ok: false; readonly issues: readonly AdmissionIssue[] };

export const MAX_ADMISSION_ITEMS = 256;
const HEX_64 = /^[0-9a-f]{64}$/u;

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function makeIssue(
  code: AdmissionIssueCode,
  message: string,
  nodeKeys: readonly GraphKey[] = [],
  edgeKeys: readonly GraphKey[] = [],
): AdmissionIssue {
  return deepFreeze({ code, message, nodeKeys: [...nodeKeys], edgeKeys: [...edgeKeys] });
}

export function sortIssues(issues: readonly AdmissionIssue[]): AdmissionIssue[] {
  return [...issues].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function refuse(issues: readonly AdmissionIssue[]): AdmissionResult {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}

export function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

export function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * Bounded, prototype-safe own-data-property projection. `required` defaults to
 * `allowed`; keys outside `allowed`, accessors, and proxies all fail closed.
 */
export function record(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> | null {
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

export function dense(value: unknown, minimum = 0): unknown[] | null {
  if (!isPlainArray(value)) return null;
  const length = readPlainArrayLength(value);
  if (length === null || length < minimum || length > MAX_ADMISSION_ITEMS || !hasExactDenseArrayShape(value, length)) {
    return null;
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = readOwnArrayElement(value, index);
    if (!read.ok || !read.present) return null;
    output.push(read.value);
  }
  return output;
}
