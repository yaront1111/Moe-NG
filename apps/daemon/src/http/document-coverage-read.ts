/**
 * PRD COVERAGE, the read port. Every join is from the ledger and every one is already made
 * by a shipped read:
 *  - goals bound to the document: the catalog's GoalCreated bindings;
 *  - Product Contract revisions citing the document, Gate 1 APPROVED or PENDING (the same
 *    `product-contract-gate-1-` aggregate scan the Gate 1 card's pending read performs);
 *  - the sealed nodes of those goals' activated plans (the compiled-node source's own walk,
 *    widened to COMPLETED goals so closed work keeps counting), whose `criterionBindings`
 *    say which criteria a node delivers;
 *  - each node's review ledger: `accepted` is the ONLY thing that makes a criterion
 *    VERIFIED. Nothing here reads a workspace or a test log;
 *  - each goal's last activity: the latest committed decision on the goal, its planning
 *    run, or one of its sealed nodes.
 *
 * The section map is prose-derived and advisory; the document text comes through the goal
 * source read, which re-proves the stored bytes against their declared digest.
 */
import { deriveProductContractRevisionDigest } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { readReviewLedger } from "../review/review-read-model.js";
import type { ReviewLedger } from "../review/review-read-model.js";
import { coverageRefused as refused } from "./document-coverage-contract.js";
import type {
  ContractCoverage, CriterionCoverage, CriterionCoverageStatus, DocumentCoverageReadPort,
  DocumentCoverageReadResult, DocumentCoverageSelector, GoalCoverage, RequirementCoverage,
} from "./document-coverage-contract.js";
import { catalogBoundGoals, lastDecidedAt } from "./document-coverage-goals.js";
import type { BoundGoalRow } from "./document-coverage-goals.js";
import { sectionCoverage } from "./document-coverage-sections.js";

const REVISION_AGGREGATE_PREFIX = "product-contract-revision:";
const GATE_1_AGGREGATE_PREFIX = "product-contract-gate-1-";
/** Sealed plans keep counting after the goal closes: verified work does not un-verify. */
const COVERAGE_LIFECYCLES: ReadonlySet<string> =
  new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

export interface DocumentCoverageReadOptions {
  readonly projectId: string;
  /** Injectable for tests; production walks the enabled/closing/completed goals durably. */
  readonly readActive?: (
    store: SqliteEventStore, projectId: string,
  ) => readonly ActiveCompiledGraph[];
  /** Injectable for tests; production reads the node's durable review ledger. */
  readonly readReview?: (
    store: SqliteEventStore, projectId: string, nodeRef: string,
  ) => Pick<ReviewLedger, "accepted">;
  readonly store: SqliteEventStore;
}

const dataRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;

interface SealedNode {
  readonly criterionIds: readonly string[];
  readonly goalRef: string;
  readonly nodeKey: string;
}
interface Carrier { readonly nodeKey: string; readonly status: CriterionCoverageStatus }

function sealedNodes(
  graphs: readonly ActiveCompiledGraph[], goals: ReadonlySet<string>,
): SealedNode[] {
  const nodes: SealedNode[] = [];
  for (const graph of graphs) {
    if (!goals.has(graph.goalRef)) continue;
    const bearing = new Set(graph.content.snapshot.nodes
      .filter((node) => node.executionBearing).map((node) => node.nodeKey));
    for (const definition of graph.content.nodeAuthority.definitions) {
      if (!bearing.has(definition.nodeKey)) continue;
      nodes.push({
        criterionIds: definition.criterionBindings.map((binding) => binding.criterionId),
        goalRef: graph.goalRef,
        nodeKey: definition.nodeKey,
      });
    }
  }
  return nodes;
}

function requirementsOf(
  record: Readonly<Record<string, unknown>>, carried: ReadonlyMap<string, Carrier>,
): readonly RequirementCoverage[] {
  const criteria = Array.isArray(record["criteria"]) ? record["criteria"] : [];
  const requirements = Array.isArray(record["requirements"]) ? record["requirements"] : [];
  return Object.freeze(requirements.flatMap((raw): RequirementCoverage[] => {
    const requirement = dataRecord(raw);
    const requirementId = requirement?.["requirementId"];
    if (typeof requirementId !== "string") return [];
    const rows = criteria.flatMap((entry): CriterionCoverage[] => {
      const criterion = dataRecord(entry);
      const criterionId = criterion?.["criterionId"];
      if (typeof criterionId !== "string" || criterion?.["requirementId"] !== requirementId) {
        return [];
      }
      const carrier = carried.get(criterionId);
      return [Object.freeze({
        criterionId,
        nodeKey: carrier?.nodeKey ?? null,
        statement: String(criterion?.["statement"] ?? ""),
        status: carrier?.status ?? "UNPLANNED",
      })];
    });
    return [Object.freeze({
      criteria: Object.freeze(rows),
      requirementId,
      statement: String(requirement?.["statement"] ?? ""),
    })];
  }));
}

/** The latest committed decision on the goal, its run, or one of its sealed nodes. */
function lastActivityOf(
  goal: BoundGoalRow, nodes: readonly SealedNode[], latest: ReadonlyMap<string, string>,
): string | null {
  const own = [goal.goalId, goal.planningRunRef ?? "", ...nodes
    .filter((node) => node.goalRef === goal.goalId).map((node) => node.nodeKey)];
  let last: string | null = null;
  for (const aggregateId of own) {
    const at = latest.get(aggregateId);
    if (at !== undefined && (last === null || at > last)) last = at;
  }
  return last;
}

export function createDocumentCoverageReadPort(
  options: DocumentCoverageReadOptions,
): DocumentCoverageReadPort {
  const { projectId, store } = options;
  const readActive = options.readActive
    ?? ((s: SqliteEventStore, p: string) => activeCompiledGraphs(s, p, COVERAGE_LIFECYCLES));
  const readReview = options.readReview ?? readReviewLedger;

  const approvedRevisions = (): ReadonlySet<string> => {
    const ledger = readDurableLedger(store, projectId);
    const approved = new Set<string>();
    for (const [aggregateId] of ledger.aggregates) {
      if (!aggregateId.startsWith(GATE_1_AGGREGATE_PREFIX)) continue;
      const gate = dataRecord(stateOf(ledger, aggregateId));
      if (typeof gate?.["contractId"] === "string" && typeof gate["revisionId"] === "string") {
        approved.add(`${gate["contractId"]} ${gate["revisionId"]}`);
      }
    }
    return approved;
  };

  /** Criterion -> the node that carries it, VERIFIED winning over PLANNED. */
  const carriers = (nodes: readonly SealedNode[]): ReadonlyMap<string, Carrier> => {
    const carried = new Map<string, Carrier>();
    for (const node of nodes) {
      const status: CriterionCoverageStatus =
        readReview(store, projectId, node.nodeKey).accepted !== undefined ? "VERIFIED" : "PLANNED";
      for (const criterionId of node.criterionIds) {
        const current = carried.get(criterionId);
        if (current === undefined || (current.status !== "VERIFIED" && status === "VERIFIED")) {
          carried.set(criterionId, { nodeKey: node.nodeKey, status });
        }
      }
    }
    return carried;
  };

  const coverageOf = (sha: string, allGoals: readonly BoundGoalRow[]): DocumentCoverageReadResult => {
    const bound = allGoals.filter((goal) => goal.sha === sha);
    const nodes = sealedNodes(readActive(store, projectId), new Set(bound.map((goal) => goal.goalId)));
    const latest = lastDecidedAt(store, projectId, new Set([
      ...bound.flatMap((goal) => [goal.goalId, ...(goal.planningRunRef === null ? [] : [goal.planningRunRef])]),
      ...nodes.map((node) => node.nodeKey),
    ]));
    const goals: GoalCoverage[] = bound.map((goal) => Object.freeze({
      goalId: goal.goalId,
      lastActivityAt: lastActivityOf(goal, nodes, latest),
      lifecycle: goal.lifecycle,
      planningRunRef: goal.planningRunRef,
      title: goal.title,
    }));
    const carried = carriers(nodes);
    const approved = approvedRevisions();
    const ledger = readDurableLedger(store, projectId);
    const contracts: ContractCoverage[] = [];
    for (const [aggregateId] of ledger.aggregates) {
      if (!aggregateId.startsWith(REVISION_AGGREGATE_PREFIX)) continue;
      const record = dataRecord(stateOf(ledger, aggregateId));
      const digests = record?.["sourceDocumentDigests"];
      if (record === null || !Array.isArray(digests) || !digests.includes(sha)) continue;
      const contractId = record["contractId"];
      const revisionId = record["revisionId"];
      if (typeof contractId !== "string" || typeof revisionId !== "string") continue;
      const derived = deriveProductContractRevisionDigest(record);
      if (!derived.ok) return refused(derived.code, derived.layer);
      contracts.push(Object.freeze({
        contractId,
        gate1: approved.has(`${contractId} ${revisionId}`) ? "APPROVED" : "PENDING",
        requirements: requirementsOf(record, carried),
        revisionDigest: derived.revisionDigest,
        revisionId,
      }));
    }
    contracts.sort((left, right) => `${left.contractId} ${left.revisionId}`
      .localeCompare(`${right.contractId} ${right.revisionId}`));
    const first = goals[0];
    const source = first === undefined
      ? null : createGoalSourceReadPort({ projectId, store }).read(first.goalId);
    const readable = source !== null && source.ok ? source : null;
    const allCriteria = contracts.flatMap((contract) =>
      contract.requirements.flatMap((requirement) => requirement.criteria));
    return Object.freeze({
      contracts: Object.freeze(contracts),
      document: Object.freeze({
        byteLength: readable?.byteLength ?? null,
        contentSha256: sha,
        displayPath: readable?.displayPath ?? null,
      }),
      goals: Object.freeze(goals),
      outcome: "COVERAGE" as const,
      sections: readable === null ? null : Object.freeze({
        advisoryOnly: true as const,
        entries: sectionCoverage(readable.text, contracts.flatMap((c) => c.requirements)),
      }),
      totals: Object.freeze({
        contracts: contracts.length,
        criteria: allCriteria.length,
        goals: goals.length,
        planned: allCriteria.filter((criterion) => criterion.status === "PLANNED").length,
        requirements: contracts.reduce((sum, c) => sum + c.requirements.length, 0),
        verified: allCriteria.filter((criterion) => criterion.status === "VERIFIED").length,
      }),
    });
  };

  const readCoverage = (selector: DocumentCoverageSelector): DocumentCoverageReadResult => {
    try {
      const allGoals = catalogBoundGoals(store, projectId);
      if (allGoals === null) return refused("DOCUMENT_COVERAGE_READ_UNREADABLE");
      if ("goalRef" in selector) {
        const bound = allGoals.find((goal) => goal.goalId === selector.goalRef);
        if (bound === undefined) return refused("DOCUMENT_COVERAGE_READ_GOAL_UNBOUND");
        return coverageOf(bound.sha, allGoals);
      }
      if (!LOWER_HEX_64.test(selector.contentSha256)) {
        return refused("DOCUMENT_COVERAGE_READ_MALFORMED");
      }
      return coverageOf(selector.contentSha256, allGoals);
    } catch {
      return refused("DOCUMENT_COVERAGE_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: projectId, readCoverage });
}
