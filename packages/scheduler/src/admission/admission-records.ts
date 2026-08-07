/**
 * Evidence-record builders for the admission pass.
 *
 * Every structural number here is COPIED from `analyzeGraphStructure`; admission
 * never recomputes a critical path, never turns an UNKNOWN estimate into zero,
 * and never emits a speed claim. A record is review evidence, not a refusal and
 * not authority to change the graph.
 */
import { assessContractRedundancy } from "../dependencies/dependency-analysis.js";
import type { DependencyContract, DependencyTruthClass } from "../dependencies/dependency-contract.js";
import type { GraphStructuralAnalysis } from "../graph-model.js";
import {
  makeIssue, oneOf, record,
  type AdmissionEstimate, type AdmissionEstimates, type AdmissionExpansionRecord,
  type AdmissionInterfaceFirstRecord, type AdmissionIssue, type AdmissionReductionRecord,
  type AdmissionStructuralSummary, type AdmissionStubConstraints,
} from "./admission-model.js";

const TRUTH_CLASSES: readonly DependencyTruthClass[] =
  ["OBSERVED", "AGENT_REPORTED", "DAEMON_VERIFIED", "HUMAN_APPROVED", "UNKNOWN"];
const ESTIMATE_KEYS = ["proposedDuration", "sequentialBaselineDuration", "proposedCost", "sequentialBaselineCost"] as const;
const EXPANSION_LIMITS = { maxExpansionDepth: 3, maxChildWidth: 6, maxNodesPerExpansion: 9 } as const;

export type ContractsByEdge = ReadonlyMap<string, DependencyContract>;

/** Structural summary derived wholly from the landed analysis outputs. */
export function summarizeStructure(analysis: GraphStructuralAnalysis): AdmissionStructuralSummary {
  return {
    structuralStageCount: analysis.structuralStageCount,
    criticalPathHardEdgeCount: analysis.criticalPathHardEdges.length,
    maxHardDescendantCount: analysis.nodes.reduce((max, node) => Math.max(max, node.hardDescendantCount), 0),
    logicalReadyWidth: analysis.logicalReadyWidth,
    admissionReadyWidth: analysis.admissionReadyWidth,
    dispatchableWidth: analysis.dispatchableWidth,
  };
}

function parseEstimate(value: unknown): AdmissionEstimate | null {
  const item = record(value, ["value", "truthClass"]);
  if (item === null || !oneOf(item.truthClass, TRUTH_CLASSES)) return null;
  const unknown = item.truthClass === "UNKNOWN";
  if (item.value === null) return unknown ? { value: null, truthClass: item.truthClass } : null;
  // An UNKNOWN estimate may never carry a number: zero is not "no cost".
  if (unknown || typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < 0) return null;
  return { value: item.value, truthClass: item.truthClass };
}

/** Absent estimates stay UNKNOWN/null. Returns null when the caller shape is invalid. */
export function parseEstimates(value: unknown): AdmissionEstimates | null {
  if (value === undefined) {
    return {
      proposedDuration: { value: null, truthClass: "UNKNOWN" },
      sequentialBaselineDuration: { value: null, truthClass: "UNKNOWN" },
      proposedCost: { value: null, truthClass: "UNKNOWN" },
      sequentialBaselineCost: { value: null, truthClass: "UNKNOWN" },
    };
  }
  const item = record(value, ESTIMATE_KEYS);
  if (item === null) return null;
  const parsed = ESTIMATE_KEYS.map((key) => parseEstimate(item[key]));
  if (parsed.some((entry) => entry === null)) return null;
  return {
    proposedDuration: parsed[0]!, sequentialBaselineDuration: parsed[1]!,
    proposedCost: parsed[2]!, sequentialBaselineCost: parsed[3]!,
  };
}

/**
 * Landed INTERFACE_FIRST_REVIEW_REQUIRED diagnostics composed with the kernel
 * alternative ruling and the design-404 stub obligations. No stub is generated
 * and no second serial-edge detector exists.
 */
export function buildInterfaceFirstRecords(
  analysis: GraphStructuralAnalysis,
  contracts: ContractsByEdge,
): AdmissionInterfaceFirstRecord[] {
  return analysis.diagnostics.map((diagnostic) => {
    const contract = contracts.get(diagnostic.edgeKey);
    return {
      diagnostic,
      alternativeRuling: contract?.alternativeRuling ?? null,
      stubConstraints: stubConstraintsFor(contract),
      reviewOnly: true,
    };
  });
}

/** Obligations only, and only when the kernel ruled a substitute available. */
function stubConstraintsFor(contract: DependencyContract | undefined): AdmissionStubConstraints | null {
  if (contract === undefined) return null;
  const ruling = contract.alternativeRuling;
  if (ruling.kind !== "INTERFACE_AVAILABLE" && ruling.kind !== "FIXTURE_AVAILABLE") return null;
  return {
    nonProduction: true,
    approvedInterfaceContractHash: contract.consumer.contractHash,
    approvedInterfaceRef: ruling.ref,
    approvedInterfaceDigest: ruling.digest,
    requiredConformanceRecipes: ["PRODUCER", "CONSUMER"],
    replacedAndVerifiedAtIntegration: true,
  };
}

/**
 * Contract-level semantic reduction. A proposal-refusal is licensed ONLY on FULL
 * identity along the alternate path (producer arm AND satisfaction predicate AND
 * consumption horizon). Any partial equivalence is recorded, never refused, and
 * the kernel assessment — which keeps `requiresSemanticProof: true` — passes
 * through unmodified. Refusing a PROPOSAL is not removing a landed edge.
 */
export function buildReductionRecords(
  analysis: GraphStructuralAnalysis,
  contracts: ContractsByEdge,
  registry: unknown,
): { readonly records: AdmissionReductionRecord[]; readonly issues: AdmissionIssue[] } {
  const records: AdmissionReductionRecord[] = [];
  const issues: AdmissionIssue[] = [];
  for (const candidate of analysis.structuralRedundancyCandidates) {
    const direct = contracts.get(candidate.edgeKey);
    const alternates = candidate.alternateHardPathEdgeKeys.map((edgeKey) => contracts.get(edgeKey));
    const unavailable: AdmissionReductionRecord = {
      edgeKey: candidate.edgeKey, outcome: "ASSESSMENT_UNAVAILABLE", assessment: null, reviewOnly: true,
    };
    if (direct === undefined || alternates.some((entry) => entry === undefined)) {
      records.push(unavailable);
      continue;
    }
    const assessed = assessContractRedundancy({
      structuralCandidate: candidate,
      directContract: direct,
      alternatePathContracts: alternates as DependencyContract[],
    }, registry);
    if (!assessed.ok) {
      records.push(unavailable);
      continue;
    }
    const comparison = assessed.assessment.contractComparison;
    const identical = comparison.producerArmEquivalent &&
      comparison.satisfactionPredicateEquivalent && comparison.consumptionHorizonEquivalent;
    records.push({
      edgeKey: candidate.edgeKey,
      outcome: identical ? "FULL_IDENTITY" : "PARTIAL_EQUIVALENCE",
      assessment: assessed.assessment,
      reviewOnly: true,
    });
    if (identical) {
      // The refusal names the alternate path that licensed it, so the reason is
      // auditable from the issue alone; the full assessment stays in the record.
      issues.push(makeIssue(
        "ADMISSION_EDGE_SEMANTICALLY_REDUNDANT",
        "proposed edge has identical producer arm, satisfaction predicate and consumption horizon " +
        `to the alternate contract path [${candidate.alternateHardPathEdgeKeys.join(", ")}]`,
        [candidate.producerNodeKey, candidate.consumerNodeKey], [candidate.edgeKey],
      ));
    }
  }
  return { records, issues };
}

/**
 * Pure checker over CALLER-SUPPLIED expansion-lineage facts. Admission owns no
 * lineage state; depth/width/per-expansion facts belong to the expansion
 * admission protocol. The raise reference records that R2 may raise the limits.
 */
export function evaluateExpansionLineage(value: unknown): {
  readonly issues: AdmissionIssue[];
  readonly record: AdmissionExpansionRecord | null;
} {
  const item = record(value, ["expansionDepth", "childWidth", "nodesAddedInExpansion"]);
  const counts = item === null ? null : [item.expansionDepth, item.childWidth, item.nodesAddedInExpansion];
  if (counts === null || counts.some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
    return { issues: [makeIssue("ADMISSION_EXPANSION_LINEAGE_MALFORMED", "expansion lineage facts are malformed")], record: null };
  }
  const facts = {
    expansionDepth: counts[0] as number, childWidth: counts[1] as number, nodesAddedInExpansion: counts[2] as number,
  };
  const issues: AdmissionIssue[] = [];
  if (facts.expansionDepth > EXPANSION_LIMITS.maxExpansionDepth) {
    issues.push(makeIssue("ADMISSION_EXPANSION_DEPTH_EXCEEDED", "expansion lineage depth exceeds the limit"));
  }
  if (facts.childWidth > EXPANSION_LIMITS.maxChildWidth) {
    issues.push(makeIssue("ADMISSION_EXPANSION_CHILD_WIDTH_EXCEEDED", "expansion child width exceeds the limit"));
  }
  if (facts.nodesAddedInExpansion > EXPANSION_LIMITS.maxNodesPerExpansion) {
    issues.push(makeIssue("ADMISSION_EXPANSION_FANOUT_EXCEEDED", "nodes added in one expansion exceed the limit"));
  }
  return {
    issues,
    record: issues.length === 0
      ? { facts, limits: EXPANSION_LIMITS, raiseReference: { kind: "R2_EXPANSION_LIMIT_RAISE", reviewOnly: true } }
      : null,
  };
}
