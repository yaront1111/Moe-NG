/**
 * RUNS & LEASES, the read port. One walk per durable source, every one already made by a
 * shipped read: the catalog's bound goals, the compiled-node source's activated graphs
 * (widened to COMPLETED goals), the planning-run read for the run's lifecycle and bound
 * approval, the work-claim ledger for who holds a node, ONE review-ledger walk for every
 * node's rounds, findings, escalation, acceptance and verifier receipt, and the decision
 * ledger for last activity.
 *
 * STATUS, in one fixed order, first match wins: UNATTRIBUTABLE (the node key is carried by
 * another activated plan too, so the review ledger cannot be attributed) > ACCEPTED (the
 * daemon's acceptance is on the node) > BLOCKED (its review ledger does not read) >
 * ESCALATED > ESCALATION_REQUIRED (three unsuccessful rounds and no escalation decision, so
 * review.submit is refused) > DELIVERED (the latest round routed ACCEPT and awaits the
 * verifier receipt) > IN_PROGRESS (an OPEN, unexpired claim) > READY. A rejected round
 * leaves the node READY, as the affordance surface does; `review.latestRoute` says so.
 */
import type { SqliteEventStore } from "@moe/store";

import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { ambiguousCompiledNodeKeys } from "../orchestrator/compiled-node-identity.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import type { GoalPublishState } from "../repository/publish-ledger.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import type { ReviewLedger, ReviewLedgers } from "../review/review-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-read-model.js";
import type { WorkClaimRecord } from "../work/work-claim-read-model.js";
import { activeClaim } from "../work/work-claim-services.js";
import { workItemIdFor } from "./affordance-read.js";
import { NODE_DELIVER_KIND } from "./affordance-contract.js";
import { catalogBoundGoals, lastDecidedAt } from "./document-coverage-goals.js";
import type { BoundGoalRow } from "./document-coverage-goals.js";
import { createPlanningRunReadPort } from "./planning-run-read.js";
import type { PlanningRunReadResult } from "./planning-run-read.js";
import { runsRefused as refused } from "./runs-read-contract.js";
import type {
  RunGoalPublish, RunGoalView, RunNodeFinding, RunNodeReview, RunNodeStatus, RunNodeView, RunsReadPort,
  RunsReadResult, RunsSelector, RunsView,
} from "./runs-read-contract.js";

/** The latest publish request and its receipt, as one view; null when never requested. */
function publishOf(state: GoalPublishState | undefined): RunGoalPublish | null {
  const request = state?.requests[state.requests.length - 1];
  if (state === undefined || request === undefined) return null;
  const receipt = state.receipts.get(request.decisionId);
  return Object.freeze({
    branch: receipt?.branch ?? null,
    code: receipt?.refusal?.code ?? null,
    decisionId: request.decisionId,
    outcome: receipt === undefined ? "PENDING" : receipt.outcome,
    remoteUrl: request.remoteUrl,
    requestedAt: request.decidedAt,
    sha: receipt?.sha ?? null,
    url: receipt?.url ?? null,
  });
}

const RUN_LIFECYCLES: ReadonlySet<string> = new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);
/** The review kernel's escalation limit (`REVIEW_ESCALATION_ROUND_LIMIT`), spelled here so the
 *  status word matches the refusal `review.submit` gives at that point. */
const ESCALATION_ROUND_LIMIT = 3;
const MAX_FINDINGS = 8;

/** The review facts a node's status is derived from; an injectable slice of the ledger. */
export type NodeReviewFacts = Pick<
  ReviewLedger, "accepted" | "escalated" | "replanned" | "rounds" | "unreadable" | "version"
> & { readonly lineage: Pick<ReviewLedger["lineage"], "unsuccessfulRounds"> & Partial<Pick<ReviewLedger["lineage"], "records">> };

export interface NodeReviews {
  readonly landings: ReviewLedgers["landings"];
  readonly ledgers: ReadonlyMap<string, NodeReviewFacts>;
  readonly receipts: ReviewLedgers["receipts"];
}

export interface RunsReadOptions {
  /** Daemon clock for claim expiry; injectable so a test can sit before or after `expiresAt`. */
  readonly clock?: () => string;
  readonly projectId: string;
  readonly readActive?: (store: SqliteEventStore, projectId: string) => readonly ActiveCompiledGraph[];
  readonly readClaims?: (store: SqliteEventStore, projectId: string) => ReadonlyMap<string, WorkClaimRecord>;
  readonly readReviews?: (store: SqliteEventStore, projectId: string, nodeRefs: ReadonlySet<string>) => NodeReviews;
  readonly readRun?: (store: SqliteEventStore, projectId: string, runId: string) => PlanningRunReadResult;
  /** Injectable for tests; the default walks the decision ledger for publish requests and receipts. */
  readonly readPublish?: (store: SqliteEventStore, projectId: string) => ReadonlyMap<string, GoalPublishState>;
  readonly store: SqliteEventStore;
}

interface SealedNode {
  readonly criterionIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly goalRef: string;
  readonly nodeKey: string;
  readonly objective: string;
}

function sealedNodesOf(graphs: readonly ActiveCompiledGraph[]): readonly SealedNode[] {
  const nodes: SealedNode[] = [];
  for (const graph of graphs) {
    const { edges, nodes: snapshotNodes } = graph.content.snapshot;
    const bearing = new Set(snapshotNodes.filter((node) => node.executionBearing).map((node) => node.nodeKey));
    for (const definition of graph.content.nodeAuthority.definitions) {
      if (!bearing.has(definition.nodeKey)) continue;
      nodes.push(Object.freeze({
        criterionIds: definition.criterionBindings.map((binding) => binding.criterionId),
        dependsOn: edges.filter((edge) => edge.consumerNodeKey === definition.nodeKey)
          .map((edge) => edge.producerNodeKey),
        goalRef: graph.goalRef,
        nodeKey: definition.nodeKey,
        objective: definition.objective,
      }));
    }
  }
  return nodes;
}

/** Node keys carried by more than one activated plan: their review ledgers are shared. */
function sharedKeysOf(nodes: readonly SealedNode[]): ReadonlySet<string> {
  const seen = new Map<string, number>();
  for (const node of nodes) seen.set(node.nodeKey, (seen.get(node.nodeKey) ?? 0) + 1);
  return new Set([...seen].filter(([, count]) => count > 1).map(([key]) => key));
}

const EMPTY_FACTS: NodeReviewFacts = Object.freeze({
  accepted: undefined, escalated: false, lineage: { unsuccessfulRounds: 0 }, replanned: false,
  rounds: [], unreadable: false, version: 0,
});

function reviewOf(facts: NodeReviewFacts): RunNodeReview {
  const latest = facts.rounds[facts.rounds.length - 1];
  const findings: RunNodeFinding[] = latest === undefined ? [] : (facts.lineage.records ?? [])
    .filter((record) => record.round === latest.round)
    .slice(0, MAX_FINDINGS)
    .map((record) => Object.freeze({
      detail: record.finding.detail, round: record.round, ruleId: record.finding.ruleId,
      severity: record.finding.severity, subject: `${record.finding.subject.kind} ${record.finding.subject.locator}`,
    }));
  return Object.freeze({
    escalated: facts.escalated,
    findings: Object.freeze(findings),
    latestRoute: latest === undefined ? null : latest.routing.route,
    rounds: facts.rounds.length,
    unreadable: facts.unreadable,
    unsuccessfulRounds: facts.lineage.unsuccessfulRounds,
    version: facts.version,
  });
}

function statusOf(
  review: RunNodeReview, accepted: boolean, claimActive: boolean, shared: boolean, replanned: boolean,
): RunNodeStatus {
  if (shared) return "UNATTRIBUTABLE";
  if (accepted) return "ACCEPTED";
  if (review.unreadable) return "BLOCKED";
  if (replanned) return "REPLANNED";
  if (review.escalated) return "ESCALATED";
  if (review.unsuccessfulRounds >= ESCALATION_ROUND_LIMIT) return "ESCALATION_REQUIRED";
  if (review.latestRoute === "ACCEPT") return "DELIVERED";
  if (claimActive) return "IN_PROGRESS";
  return "READY";
}

export function createRunsReadPort(options: RunsReadOptions): RunsReadPort {
  const { projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const readActive = options.readActive
    ?? ((s: SqliteEventStore, p: string) => activeCompiledGraphs(s, p, RUN_LIFECYCLES));
  const readClaims = options.readClaims
    ?? ((s: SqliteEventStore, p: string) => readWorkClaimLedger(s, p).claims);
  const readReviews = options.readReviews ?? readReviewLedgers;
  const readRun = options.readRun ?? ((s: SqliteEventStore, p: string, runId: string) =>
    createPlanningRunReadPort({ projectId: p, store: s }).readPlanningRun(runId));
  const readPublish = options.readPublish ?? readPublishLedger;

  const goalView = (
    goal: BoundGoalRow, nodes: readonly SealedNode[], shared: ReadonlySet<string>,
    claims: ReadonlyMap<string, WorkClaimRecord>, reviews: NodeReviews,
    latest: ReadonlyMap<string, string>, now: string, publishes: ReadonlyMap<string, GoalPublishState>,
  ): RunGoalView => {
    const run = goal.planningRunRef === null ? null : readRun(store, projectId, goal.planningRunRef);
    const own = nodes.filter((node) => node.goalRef === goal.goalId);
    return Object.freeze({
      goalId: goal.goalId,
      lifecycle: goal.lifecycle,
      nodes: Object.freeze(own.map((node): RunNodeView => {
        const facts = reviews.ledgers.get(node.nodeKey) ?? EMPTY_FACTS;
        const review = reviewOf(facts);
        const record = claims.get(workItemIdFor(NODE_DELIVER_KIND, node.nodeKey));
        const active = activeClaim(record, now) !== null;
        const receipt = reviews.receipts.get(node.nodeKey);
        const landing = reviews.landings.get(node.nodeKey);
        const isShared = shared.has(node.nodeKey);
        return Object.freeze({
          accepted: facts.accepted === undefined
            ? null : Object.freeze({ verifierReceiptId: facts.accepted.verifierReceiptId }),
          claim: record === undefined ? null : Object.freeze({
            active, claimedBy: record.claimedBy, expiresAt: record.expiresAt, status: record.status,
          }),
          criterionIds: node.criterionIds,
          dependsOn: node.dependsOn,
          landing: landing === undefined ? null : Object.freeze({
            branch: landing.commit?.branch ?? null,
            code: landing.refusal?.code ?? null,
            files: landing.commit?.files ?? [],
            outcome: landing.outcome,
            sha: landing.commit?.sha ?? null,
          }),
          lastActivityAt: latest.get(node.nodeKey) ?? null,
          nodeKey: node.nodeKey,
          objective: node.objective,
          receipt: receipt === undefined ? null : Object.freeze({
            byteCount: receipt.byteCount, exitCode: receipt.exitCode, outputSha256: receipt.outputSha256,
            test: receipt.test, workspace: receipt.workspace,
          }),
          review,
          sharedKey: isShared,
          status: statusOf(review, facts.accepted !== undefined, active, isShared, facts.replanned),
        });
      })),
      publish: publishOf(publishes.get(goal.goalId)),
      run: run === null || run.outcome !== "RUN" ? null : Object.freeze({
        approval: run.approval, lifecycle: run.lifecycle, reviewable: run.reviewable, runId: run.runId,
      }),
      title: goal.title,
    });
  };

  const readRuns = (selector: RunsSelector): RunsReadResult => {
    try {
      const all = catalogBoundGoals(store, projectId);
      if (all === null) return refused("RUNS_READ_UNREADABLE");
      let goals: readonly BoundGoalRow[] = all;
      if ("goalRef" in selector) {
        const one = all.find((goal) => goal.goalId === selector.goalRef);
        if (one === undefined) return refused("RUNS_READ_GOAL_UNKNOWN");
        goals = [one];
      }
      // Every activated plan, not only the selected goals': a shared key is shared with ANY plan.
      const graphs = readActive(store, projectId);
      const allNodes = sealedNodesOf(graphs);
      const shared = new Set([...sharedKeysOf(allNodes), ...ambiguousCompiledNodeKeys(store, projectId, graphs)]);
      const goalIds = new Set(goals.map((goal) => goal.goalId));
      const nodes = allNodes.filter((node) => goalIds.has(node.goalRef));
      const nodeKeys = new Set(nodes.map((node) => node.nodeKey));
      const claims = readClaims(store, projectId);
      const reviews = readReviews(store, projectId, nodeKeys);
      const latest = lastDecidedAt(store, projectId, nodeKeys);
      const now = clock();
      const publishes = readPublish(store, projectId);
      const views = goals.map((goal) => goalView(goal, nodes, shared, claims, reviews, latest, now, publishes));
      const totals: Record<RunNodeStatus, number> = {
        ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0,
        IN_PROGRESS: 0, READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0,
      };
      let nodeCount = 0;
      for (const view of views) {
        for (const node of view.nodes) { totals[node.status] += 1; nodeCount += 1; }
      }
      const result: RunsView = Object.freeze({
        goals: Object.freeze(views),
        outcome: "RUNS" as const,
        totals: Object.freeze({ ...totals, goals: views.length, nodes: nodeCount }),
      });
      return result;
    } catch {
      return refused("RUNS_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: projectId, readRuns });
}
