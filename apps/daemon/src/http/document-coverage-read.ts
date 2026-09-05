/**
 * PRD COVERAGE, the read port. Every join is from the ledger, folded ONCE per read:
 *  - goals bound to the document: the catalog's GoalCreated bindings;
 *  - Product Contract revisions citing the document on either plane (the `/1` writer's
 *    aggregates and the `/2` family's revision events), ONE per contract: the Gate 1
 *    approved revision when the gate reader finds its approval, else the pending one the
 *    Gate 1 card would offer (the smallest `contractId revisionId`, as the pending read picks);
 *  - the sealed nodes of the bound goals' activated plans (widened to COMPLETED goals so
 *    closed work keeps counting), whose `criterionBindings` say which criteria a node
 *    delivers;
 *  - ONE review-ledger walk for those nodes: `accepted` proves NODE_TEST_PASSED only.
 *    Criterion evidence remains EVIDENCE_REQUIRED. Legacy bare-key execution or an unreadable
 *    scoped ledger is UNATTRIBUTABLE. Reused local keys do not join distinct scoped subjects;
 *  - each goal's last activity from the decision ledger.
 *
 * The section map is prose-derived and advisory; the document text comes through the goal
 * source read, which re-proves the stored bytes against their declared digest.
 */
import {
  admitProductContractRevisionRef, decodeProductContractRevisionV2Bytes, deriveProductContractRevisionDigest,
} from "@moe/core";
import { encodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { legacyCompiledNodeKeys, nodesBlockedByIdentity } from "../orchestrator/compiled-node-identity.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { locateSealedAuthority } from "../planning/planning-authority-reader-seal.js";
import { readProductContractGate1Approval } from "../product-contract/product-contract-gate-1-reader.js";
import { PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE } from "../product-contract/product-contract-v2-event-contract.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import type { ReviewLedger } from "../review/review-read-model.js";
import { coverageRefused as refused } from "./document-coverage-contract.js";
import type {
  ContractCoverage, CriterionCoverage, CriterionCoverageStatus, DocumentCoverageReadPort,
  DocumentCoverageReadResult, DocumentCoverageSelector, GoalCoverage, RequirementCoverage,
} from "./document-coverage-contract.js";
import { catalogBoundGoals, lastDecidedAt } from "./document-coverage-goals.js";
import type { BoundGoalRow } from "./document-coverage-goals.js";
import { sectionCoverage } from "./document-coverage-sections.js";

const V1_REVISION_PREFIX = "product-contract-revision:";
const V2_REVISION_PREFIX = "product-contract-revision.v2:";
const V2_REQUIREMENT_SECTIONS = Object.freeze([
  "functionalRequirements", "nonFunctionalRequirements", "securityPrivacyRequirements",
  "technologyRequirements", "uxAccessibilityRequirements", "deploymentRequirements",
] as const);
/** Sealed plans keep counting after the goal closes: verified work does not un-verify. */
const COVERAGE_LIFECYCLES: ReadonlySet<string> =
  new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

/** The review facts a criterion's status is derived from; an injectable slice of the ledger. */
export type NodeReviewFacts = Pick<ReviewLedger, "accepted" | "unreadable">;

export interface DocumentCoverageReadOptions {
  readonly projectId: string;
  /** Injectable for tests; production walks the enabled/closing/completed goals durably. */
  readonly readActive?: (
    store: SqliteEventStore, projectId: string, ledger: DurableLedger,
  ) => readonly ActiveCompiledGraph[];
  /** Injectable for tests; production folds every node's review ledger in one walk. */
  readonly readReviews?: (
    store: SqliteEventStore, projectId: string, nodeRefs: ReadonlySet<string>,
  ) => ReadonlyMap<string, NodeReviewFacts>;
  readonly store: SqliteEventStore;
}

const dataRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;

interface SealedNode { readonly criterionIds: readonly string[]; readonly goalRef: string; readonly nodeKey: string; readonly nodeRef: string }
interface Carrier { readonly criterionId: string; readonly goalRef: string; readonly nodeKey: string; readonly status: CriterionCoverageStatus }
interface StatementRow { readonly id: string; readonly statement: string }
interface Candidate {
  readonly contractId: string;
  readonly criteria: readonly (StatementRow & { readonly requirementId: string })[];
  readonly plane: "V1" | "V2";
  readonly requirements: readonly StatementRow[];
  readonly revisionDigest: string;
  readonly revisionId: string;
}
type CandidateOutcome = { readonly candidate: Candidate } | { readonly code: string; readonly layer: string } | null;
const RANK: Record<CriterionCoverageStatus, number> = { EVIDENCE_REQUIRED: 1, PLANNED: 0, UNATTRIBUTABLE: 3, UNPLANNED: -1, VERIFIED: 2 };
const candidateKey = (candidate: Candidate): string => JSON.stringify([
  candidate.plane, candidate.contractId, candidate.revisionId, candidate.revisionDigest,
]);
const criterionContent = (rows: readonly { readonly criterionId: string; readonly statement: string }[]): string =>
  JSON.stringify(rows.map((row) => [row.criterionId, row.statement]).sort((left, right) => left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0));

function sealedNodesOf(projectId: string, graphs: readonly ActiveCompiledGraph[]): SealedNode[] {
  const nodes: SealedNode[] = [];
  for (const graph of graphs) {
    const bearing = new Set(graph.content.snapshot.nodes
      .filter((node) => node.executionBearing).map((node) => node.nodeKey));
    for (const definition of graph.content.nodeAuthority.definitions) {
      if (!bearing.has(definition.nodeKey)) continue;
      nodes.push({
        criterionIds: definition.criterionBindings.map((binding) => binding.criterionId),
        goalRef: graph.goalRef, nodeKey: definition.nodeKey,
        nodeRef: compiledExecutionRef(projectId, graph, definition.nodeKey),
      });
    }
  }
  return nodes;
}

const rowsOf = (value: unknown, idKey: string): (StatementRow & { readonly requirementId: string })[] =>
  (Array.isArray(value) ? value : []).flatMap((raw) => {
    const record = dataRecord(raw);
    const id = record?.[idKey];
    if (typeof id !== "string") return [];
    const requirementId = record?.["requirementId"];
    return [{ id, requirementId: typeof requirementId === "string" ? requirementId : "", statement: String(record?.["statement"] ?? "") }];
  });

/** A `/1` revision from its folded aggregate state; its digest re-derived from the bytes. */
function v1Candidate(record: Readonly<Record<string, unknown>>, sha: string): CandidateOutcome {
  const digests = record["sourceDocumentDigests"];
  if (!Array.isArray(digests) || !digests.includes(sha)) return null;
  const contractId = record["contractId"];
  const revisionId = record["revisionId"];
  if (typeof contractId !== "string" || typeof revisionId !== "string") return null;
  const derived = deriveProductContractRevisionDigest(record);
  if (!derived.ok) return { code: derived.code, layer: derived.layer };
  return { candidate: {
    contractId, criteria: rowsOf(record["criteria"], "criterionId"), plane: "V1",
    requirements: rowsOf(record["requirements"], "requirementId"), revisionDigest: derived.revisionDigest, revisionId,
  } };
}

/** A `/2` revision from its committed event bytes, through the core codec. */
function v2Candidate(store: SqliteEventStore, aggregateId: string, sha: string): CandidateOutcome {
  const event = store.readEvents(aggregateId)
    .find((row) => row.aggregateId === aggregateId && row.eventType === PRODUCT_CONTRACT_REVISION_V2_EVENT_TYPE);
  if (event === undefined) return null;
  const decoded = decodeProductContractRevisionV2Bytes(event.payload);
  if (!decoded.ok) return { code: decoded.code, layer: decoded.layer };
  const revision = decoded.revision as unknown as Readonly<Record<string, unknown>>;
  const digests = revision["sourceDocumentDigests"];
  if (!Array.isArray(digests) || !digests.includes(sha)) return null;
  const contractId = revision["contractId"];
  const revisionId = revision["revisionId"];
  const revisionDigest = revision["revisionDigest"];
  if (typeof contractId !== "string" || typeof revisionId !== "string" || typeof revisionDigest !== "string") return null;
  return { candidate: {
    contractId, criteria: rowsOf(revision["criteria"], "criterionId"), plane: "V2",
    requirements: V2_REQUIREMENT_SECTIONS.flatMap((section) => rowsOf(revision[section], "requirementId")),
    revisionDigest, revisionId,
  } };
}

export function createDocumentCoverageReadPort(options: DocumentCoverageReadOptions): DocumentCoverageReadPort {
  const { projectId, store } = options;
  const readActive = options.readActive
    ?? ((s: SqliteEventStore, p: string, ledger: DurableLedger) => activeCompiledGraphs(s, p, COVERAGE_LIFECYCLES, ledger));
  const readReviews = options.readReviews
    ?? ((s: SqliteEventStore, p: string, refs: ReadonlySet<string>) => readReviewLedgers(s, p, refs).ledgers);

  const approved = (candidate: Candidate): boolean | { readonly code: string; readonly layer: string } => {
    const admitted = admitProductContractRevisionRef({
      contractId: candidate.contractId, revisionDigest: candidate.revisionDigest, revisionId: candidate.revisionId,
    });
    if (!admitted.ok) return { code: admitted.code, layer: admitted.layer };
    const read = readProductContractGate1Approval(store, { projectId, ref: admitted.ref });
    if (read.ok) return true;
    if (read.code === "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT") return false;
    return { code: read.code, layer: read.layer };
  };

  /** One revision per contract citing the document, or the first refusal met. */
  const contractsOf = (ledger: DurableLedger, sha: string, carried: ReadonlyMap<string, Carrier>, graphs: readonly ActiveCompiledGraph[]): ContractCoverage[] | { readonly code: string; readonly layer: string } => {
    const byContract = new Map<string, { approved: Candidate[]; pending: Candidate[] }>();
    for (const [aggregateId] of ledger.aggregates) {
      let outcome: CandidateOutcome = null;
      if (aggregateId.startsWith(V1_REVISION_PREFIX)) {
        const record = dataRecord(stateOf(ledger, aggregateId));
        outcome = record === null ? null : v1Candidate(record, sha);
      } else if (aggregateId.startsWith(V2_REVISION_PREFIX)) {
        outcome = v2Candidate(store, aggregateId, sha);
      }
      if (outcome === null) continue;
      if (!("candidate" in outcome)) return outcome;
      const gate = approved(outcome.candidate);
      if (typeof gate !== "boolean") return gate;
      const bucket = byContract.get(outcome.candidate.contractId) ?? { approved: [], pending: [] };
      (gate ? bucket.approved : bucket.pending).push(outcome.candidate);
      byContract.set(outcome.candidate.contractId, bucket);
    }
    // V1 did not persist the full Product Contract ref on its run. Re-prove the
    // goal/run/graph seal and exact criterion content; only one compatible approved
    // revision may carry a node fact. Prefixes and the current Gate 1 selection are
    // not provenance. Ambiguous or absent associations remain unattributable.
    const candidates = [...byContract.values()].flatMap((bucket) => bucket.approved);
    const associations = new Map<string, string>();
    for (const graph of graphs) {
      const sealed = locateSealedAuthority(store, projectId, graph.goalRef);
      if ("ok" in sealed || sealed.runId !== graph.planningRunRef) continue;
      const encoded = encodeGraphContent(graph.content);
      if (!encoded.ok || sealed.revision.graphBinding.graphContentHash !== encoded.value.graphContentHash) continue;
      const content = criterionContent(sealed.contract.obligations);
      const compatible = candidates.filter((candidate) => candidate.plane === "V1"
        && criterionContent(candidate.criteria.map((row) => ({ criterionId: row.id, statement: row.statement }))) === content);
      if (compatible.length === 1) associations.set(graph.goalRef, candidateKey(compatible[0]!));
    }
    const carrierFor = (candidate: Candidate, criterionId: string): Carrier | undefined => {
      let selected: Carrier | undefined;
      for (const carrier of carried.values()) {
        if (carrier.criterionId !== criterionId) continue;
        const association = associations.get(carrier.goalRef);
        if (association !== undefined && association !== candidateKey(candidate)) continue;
        const next: Carrier = association === undefined ? { ...carrier, status: "UNATTRIBUTABLE" } : carrier;
        if (selected === undefined || RANK[next.status] > RANK[selected.status]) selected = next;
      }
      return selected;
    };
    const sortKey = (row: Candidate): string => `${row.contractId} ${row.revisionId}`;
    const contracts: ContractCoverage[] = [];
    for (const [contractId, bucket] of byContract) {
      const chosen = bucket.approved.length > 0
        ? [...bucket.approved].sort((a, b) => sortKey(b).localeCompare(sortKey(a)))[0]
        : [...bucket.pending].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))[0];
      if (chosen === undefined) continue;
      contracts.push(Object.freeze({
        contractId,
        gate1: bucket.approved.length > 0 ? "APPROVED" : "PENDING",
        plane: chosen.plane,
        requirements: Object.freeze(chosen.requirements.map((requirement): RequirementCoverage => Object.freeze({
          criteria: Object.freeze(chosen.criteria.filter((criterion) => criterion.requirementId === requirement.id)
            .map((criterion): CriterionCoverage => {
              const carrier = carrierFor(chosen, criterion.id);
              return Object.freeze({
                criterionId: criterion.id, nodeKey: carrier?.nodeKey ?? null,
                nodeTestStatus: carrier?.status === "EVIDENCE_REQUIRED" ? "NODE_TEST_PASSED" : null,
                statement: criterion.statement, status: carrier?.status ?? "UNPLANNED",
              });
            })),
          requirementId: requirement.id,
          statement: requirement.statement,
        }))),
        revisionDigest: chosen.revisionDigest,
        revisionId: chosen.revisionId,
      }));
    }
    return contracts.sort((left, right) => left.contractId.localeCompare(right.contractId));
  };

  const coverageOf = (sha: string, allGoals: readonly BoundGoalRow[], ledger: DurableLedger, selectedGoal?: string): DocumentCoverageReadResult => {
    const bound = allGoals.filter((goal) => goal.sha === sha);
    const goalIds = new Set(bound.map((goal) => goal.goalId));
    // Every activated plan, not only this document's: a shared key is shared with ANY plan.
    const graphs = readActive(store, projectId, ledger);
    const allNodes = sealedNodesOf(projectId, graphs);
    const ambiguous = nodesBlockedByIdentity(graphs, legacyCompiledNodeKeys(store, projectId, graphs, ledger));
    const nodes = allNodes.filter((node) => goalIds.has(node.goalRef));
    const nodeKeys = new Set(nodes.map((node) => node.nodeRef));
    const reviews = readReviews(store, projectId, nodeKeys);
    const carried = new Map<string, Carrier>();
    // A criterion carried by several nodes folds by a TOTAL order, so the answer cannot depend
    // on definition order: UNATTRIBUTABLE outranks EVIDENCE_REQUIRED outranks PLANNED.
    // An unattributable carrier withholds the node-test assertion for the whole criterion.
    // Ties keep the first carrier, so the reported nodeKey stays stable.
    for (const node of nodes) {
      if (selectedGoal !== undefined && node.goalRef !== selectedGoal) continue;
      const facts = reviews.get(node.nodeRef);
      const status: CriterionCoverageStatus = ambiguous.has(node.nodeKey)
        || facts?.unreadable === true
        ? "UNATTRIBUTABLE" : facts?.accepted !== undefined ? "EVIDENCE_REQUIRED" : "PLANNED";
      for (const criterionId of node.criterionIds) {
        const key = JSON.stringify([node.goalRef, criterionId]);
        const current = carried.get(key);
        if (current === undefined || RANK[status] > RANK[current.status]) {
          carried.set(key, { criterionId, goalRef: node.goalRef, nodeKey: node.nodeKey, status });
        }
      }
    }
    const contracts = contractsOf(ledger, sha, carried, graphs.filter((graph) => goalIds.has(graph.goalRef)));
    if (!Array.isArray(contracts)) return refused(contracts.code, contracts.layer);
    const latest = lastDecidedAt(store, projectId, new Set([
      ...bound.flatMap((goal) => [goal.goalId, ...(goal.planningRunRef === null ? [] : [goal.planningRunRef])]),
      ...nodeKeys,
    ]));
    const goals: GoalCoverage[] = bound.map((goal) => {
      const own = [goal.goalId, goal.planningRunRef ?? "", ...nodes.filter((node) => node.goalRef === goal.goalId).map((node) => node.nodeRef)];
      let last: string | null = null;
      for (const id of own) { const at = latest.get(id); if (at !== undefined && (last === null || at > last)) last = at; }
      return Object.freeze({ goalId: goal.goalId, lastActivityAt: last, lifecycle: goal.lifecycle, planningRunRef: goal.planningRunRef, title: goal.title });
    });
    const first = goals[0];
    const source = first === undefined ? null : createGoalSourceReadPort({ projectId, store }).read(first.goalId);
    const readable = source !== null && source.ok ? source : null;
    const allCriteria = contracts.flatMap((contract) => contract.requirements.flatMap((requirement) => requirement.criteria));
    const count = (status: CriterionCoverageStatus): number => allCriteria.filter((criterion) => criterion.status === status).length;
    return Object.freeze({
      contracts: Object.freeze(contracts),
      document: Object.freeze({
        byteLength: readable?.byteLength ?? null, contentSha256: sha, displayPath: readable?.displayPath ?? null,
      }),
      goals: Object.freeze(goals),
      outcome: "COVERAGE" as const,
      sections: readable === null ? null : Object.freeze({
        advisoryOnly: true as const,
        entries: sectionCoverage(readable.text, contracts.flatMap((c) => c.requirements)),
      }),
      totals: Object.freeze({
        contracts: contracts.length, criteria: allCriteria.length, goals: goals.length, planned: count("PLANNED"),
        requirements: contracts.reduce((sum, c) => sum + c.requirements.length, 0),
        unattributable: count("UNATTRIBUTABLE"), verified: count("VERIFIED"),
      }),
    });
  };

  const readCoverage = (selector: DocumentCoverageSelector): DocumentCoverageReadResult => {
    try {
      const ledger = readDurableLedger(store, projectId);
      const allGoals = catalogBoundGoals(store, projectId, ledger);
      if (allGoals === null) return refused("DOCUMENT_COVERAGE_READ_UNREADABLE");
      if ("goalRef" in selector) {
        const bound = allGoals.find((goal) => goal.goalId === selector.goalRef);
        if (bound === undefined) return refused("DOCUMENT_COVERAGE_READ_GOAL_UNBOUND");
        return coverageOf(bound.sha, allGoals, ledger, selector.goalRef);
      }
      if (!LOWER_HEX_64.test(selector.contentSha256)) return refused("DOCUMENT_COVERAGE_READ_MALFORMED");
      return coverageOf(selector.contentSha256, allGoals, ledger);
    } catch {
      return refused("DOCUMENT_COVERAGE_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: projectId, readCoverage });
}
