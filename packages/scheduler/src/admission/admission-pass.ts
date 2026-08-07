/**
 * Anti-blocking admission pass.
 *
 * Composes the landed structural kernel (`validateGraphSnapshot`,
 * `analyzeGraphStructure`, `analyzeHardEdgeCounterfactuals`) with the landed
 * dependency-contract kernel. Structural members, completion closure, and the
 * node/hard-edge limits are PASSED THROUGH under their landed `GRAPH_*` codes;
 * admission adds only the codes that are genuinely its own.
 *
 * Zero authority: the result is either refusals or review records. Admission
 * never removes an edge, never rewrites the graph, never upgrades a truth class,
 * and never claims a decomposition is faster.
 */
import { analyzeGraphStructure } from "../analyze-graph.js";
import { analyzeHardEdgeCounterfactuals } from "../hard-edge-counterfactual.js";
import { validateGraphSnapshot } from "../validate-graph.js";
import { validateDependencyContract, type DependencyContract } from "../dependencies/dependency-contract.js";
import type { ValidatedGraph } from "../graph-model.js";
import type { HardEdgeCounterfactual } from "../hard-edge-counterfactual-model.js";
import {
  deepFreeze, dense, isRef, isVersion, makeIssue, record, refuse,
  type AdmissionIssue, type AdmissionResult,
} from "./admission-model.js";
import {
  buildInterfaceFirstRecords, buildReductionRecords, evaluateExpansionLineage,
  parseEstimates, summarizeStructure,
} from "./admission-records.js";
import { evaluateNecessityClaim } from "./admission-necessity.js";

/**
 * Witness classes that never prove a hard dependency (design 399). They are
 * co-location facts, not consumer-criterion failures.
 */
export const REJECTED_NECESSITY_WITNESS_KINDS = [
  "PROSE_ORDER", "RESOURCE_SCARCITY", "SAME_EPIC", "SAME_REPOSITORY", "SHARED_OWNERSHIP",
] as const;
const INPUT_KEYS = ["proposedSnapshot", "sequentialBaselineSnapshot", "contracts", "predicateRegistry",
  "currentSourceFactVersions", "estimates", "expansionLineage", "policyOverride"] as const;
const INPUT_REQUIRED = ["proposedSnapshot", "sequentialBaselineSnapshot", "contracts"] as const;
const ENTRY_KEYS = ["edgeKey", "edgeKind", "contract", "necessityWitness"] as const;
const ENTRY_REQUIRED = ["edgeKey", "edgeKind"] as const;

interface ParsedInput {
  readonly proposedSnapshot: unknown;
  readonly sequentialBaselineSnapshot: unknown;
  readonly contracts: readonly unknown[];
  readonly registry: unknown;
  readonly currentFactVersions: ReadonlyMap<string, number>;
  readonly estimates: unknown;
  readonly expansionLineage: unknown;
  readonly policyOverride: unknown;
}

function parseFactVersions(value: unknown): Map<string, number> | null {
  if (value === undefined) return new Map();
  const entries = dense(value);
  if (entries === null) return null;
  const output = new Map<string, number>();
  for (const raw of entries) {
    const item = record(raw, ["sourceFactRef", "version"]);
    if (item === null || !isRef(item.sourceFactRef) || !isVersion(item.version) || output.has(item.sourceFactRef)) {
      return null;
    }
    output.set(item.sourceFactRef, item.version);
  }
  return output;
}

function parseInput(value: unknown): ParsedInput | null {
  const item = record(value, INPUT_KEYS, INPUT_REQUIRED);
  const contracts = item === null ? null : dense(item.contracts);
  const currentFactVersions = item === null ? null : parseFactVersions(item.currentSourceFactVersions);
  if (item === null || contracts === null || currentFactVersions === null) return null;
  return {
    proposedSnapshot: item.proposedSnapshot,
    sequentialBaselineSnapshot: item.sequentialBaselineSnapshot,
    contracts,
    // Only an ABSENT registry defaults to empty. A malformed one is left to the
    // kernel so DEPENDENCY_PREDICATE_REGISTRY_MALFORMED surfaces instead of
    // being silently coerced into "no monotonic proofs available".
    registry: item.predicateRegistry === undefined ? [] : item.predicateRegistry,
    currentFactVersions,
    estimates: item.estimates,
    expansionLineage: item.expansionLineage,
    policyOverride: item.policyOverride,
  };
}

/** Both snapshots must describe the same work set, else the comparison is meaningless. */
function sameWorkSet(left: ValidatedGraph, right: ValidatedGraph): boolean {
  return left.completionNodeKey === right.completionNodeKey &&
    left.nodes.length === right.nodes.length &&
    left.nodes.every((node, index) => node.nodeKey === right.nodes[index]?.nodeKey);
}

function collectContracts(
  parsed: ParsedInput,
  graph: ValidatedGraph,
  counterfactuals: ReadonlyMap<string, HardEdgeCounterfactual>,
  issues: AdmissionIssue[],
): Map<string, DependencyContract> {
  const byEdge = new Map<string, DependencyContract>();
  const edges = new Map(graph.edges.map((edge) => [edge.edgeKey, edge] as const));
  const bindings = new Set<string>();
  const seen = new Set<string>();
  for (const raw of parsed.contracts) {
    const item = record(raw, ENTRY_KEYS, ENTRY_REQUIRED);
    if (item === null || !isRef(item.edgeKey) || typeof item.edgeKind !== "string") {
      issues.push(makeIssue("ADMISSION_INPUT_MALFORMED", "admission contract entry is malformed"));
      continue;
    }
    const edgeKey = item.edgeKey;
    if (seen.has(edgeKey)) {
      issues.push(makeIssue("ADMISSION_DUPLICATE_CONTRACT", "two contracts claim the same edge", [], [edgeKey]));
      continue;
    }
    seen.add(edgeKey);
    const edge = edges.get(edgeKey);
    if (edge === undefined) {
      issues.push(makeIssue("ADMISSION_CONTRACT_INCOMPATIBLE", "contract names an edge outside the proposed graph", [], [edgeKey]));
      continue;
    }
    const requirement = "contract" in item
      ? { edgeKind: item.edgeKind, contract: item.contract }
      : { edgeKind: item.edgeKind };
    const validated = validateDependencyContract(requirement, parsed.registry);
    if (!validated.ok) {
      // The kernel's own DEPENDENCY_* codes and messages pass through verbatim
      // rather than collapsing seven distinct facts into one admission synonym.
      // Only the graph edge binding — which the kernel cannot know — is added.
      for (const issue of validated.issues) issues.push(deepFreeze({ ...issue, edgeKeys: [edgeKey] }));
      continue;
    }
    if (validated.graphEdgeKind !== edge.kind) {
      issues.push(makeIssue("ADMISSION_CONTRACT_INCOMPATIBLE", "contract edge kind disagrees with the graph edge", [], [edgeKey]));
      continue;
    }
    if (validated.graphEdgeKind === "ADVISORY") continue;
    const contract = validated.contract;
    if (contract.producerNodeKey !== edge.producerNodeKey || contract.consumerNodeKey !== edge.consumerNodeKey) {
      issues.push(makeIssue("ADMISSION_CONTRACT_INCOMPATIBLE", "contract endpoints disagree with the graph edge",
        [contract.producerNodeKey, contract.consumerNodeKey], [edgeKey]));
      continue;
    }
    bindings.add(contract.graphBindingDigest);
    checkContract(contract, edgeKey, item.necessityWitness, counterfactuals.get(edgeKey), parsed.currentFactVersions, issues);
    byEdge.set(edgeKey, contract);
  }
  if (bindings.size > 1) {
    issues.push(makeIssue("ADMISSION_CROSS_SNAPSHOT_INPUT", "contracts are bound to more than one graph"));
  }
  for (const edge of graph.edges) {
    if (edge.kind === "HARD" && !byEdge.has(edge.edgeKey)) {
      issues.push(makeIssue("ADMISSION_HARD_DEPENDENCY_UNPROVEN", "hard edge has no current typed dependency contract",
        [edge.producerNodeKey, edge.consumerNodeKey], [edge.edgeKey]));
    }
  }
  return byEdge;
}

/** Per-contract admission checks: witness class, fact freshness, milestone. */
function checkContract(
  contract: DependencyContract,
  edgeKey: string,
  necessityWitness: unknown,
  counterfactual: HardEdgeCounterfactual | undefined,
  currentFactVersions: ReadonlyMap<string, number>,
  issues: AdmissionIssue[],
): void {
  const necessity = counterfactual === undefined
    ? null
    : evaluateNecessityClaim(necessityWitness, contract, counterfactual);
  if (necessity === null || !necessity.ok || necessity.outcome.kind !== "ADMISSIBLE") {
    issues.push(makeIssue("ADMISSION_HARD_DEPENDENCY_UNPROVEN",
      "hard edge lacks daemon-verifiable necessity evidence", [], [edgeKey]));
  }
  for (const fact of contract.invalidationFacts) {
    const current = currentFactVersions.get(fact.sourceFactRef);
    if (current !== undefined && fact.sourceFactVersion < current) {
      issues.push(makeIssue("ADMISSION_STALE_FACT", "contract source fact is older than the declared current version", [], [edgeKey]));
    }
  }
  const ruling = contract.alternativeRuling;
  if (contract.minimumQualifyingMilestone === "ACCEPTED" &&
    (ruling.kind === "INTERFACE_AVAILABLE" || ruling.kind === "FIXTURE_AVAILABLE")) {
    issues.push(makeIssue("ADMISSION_MINIMUM_MILESTONE_OVERSTATED",
      "an earlier qualifying milestone already satisfies the consumer", [], [edgeKey]));
  }
}

/** Pure checker over caller-supplied expansion-lineage facts. */
export function checkExpansionLineage(facts: unknown): readonly AdmissionIssue[] {
  return evaluateExpansionLineage(facts).issues;
}

/** Admit or refuse a proposed graph. Deterministic, side-effect-free, deeply frozen. */
export function admitGraph(input: unknown): AdmissionResult {
  const parsed = parseInput(input);
  if (parsed === null) return refuse([makeIssue("ADMISSION_INPUT_MALFORMED", "admission input is malformed")]);
  const proposed = validateGraphSnapshot(parsed.proposedSnapshot, parsed.policyOverride);
  if (!proposed.ok) return refuse(proposed.issues);
  const baseline = validateGraphSnapshot(parsed.sequentialBaselineSnapshot, parsed.policyOverride);
  if (!baseline.ok) return refuse(baseline.issues);

  const issues: AdmissionIssue[] = [];
  if (!sameWorkSet(proposed.graph, baseline.graph)) {
    issues.push(makeIssue("ADMISSION_CROSS_SNAPSHOT_INPUT", "the baseline snapshot describes a different work set"));
  }
  const counterfactuals = analyzeHardEdgeCounterfactuals(proposed.graph);
  const byEdge = new Map(counterfactuals.edges.map((edge) => [edge.edgeKey, edge] as const));
  const contracts = collectContracts(parsed, proposed.graph, byEdge, issues);
  const analysis = analyzeGraphStructure(proposed.graph);
  const reduction = buildReductionRecords(analysis, contracts, parsed.registry);
  issues.push(...reduction.issues);
  const estimates = parseEstimates(parsed.estimates);
  if (estimates === null) {
    issues.push(makeIssue("ADMISSION_ESTIMATE_MALFORMED", "caller-supplied estimates are malformed or not truth-classed"));
  }
  const lineage = parsed.expansionLineage === undefined
    ? { issues: [] as AdmissionIssue[], record: null }
    : evaluateExpansionLineage(parsed.expansionLineage);
  issues.push(...lineage.issues);
  if (issues.length > 0 || estimates === null) return refuse(issues);

  return deepFreeze({
    ok: true,
    records: {
      baseline: {
        proposed: summarizeStructure(analysis),
        sequentialBaseline: summarizeStructure(analyzeGraphStructure(baseline.graph)),
        estimates,
        durationEstimate: null,
      },
      interfaceFirst: buildInterfaceFirstRecords(analysis, contracts),
      reduction: reduction.records,
      counterfactuals,
      expansion: lineage.record,
    },
  });
}
