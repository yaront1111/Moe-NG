/**
 * RUNS & LEASES, the wire contract: for every source-bound goal (or one named goal), the
 * planning run, the sealed nodes of its activated plan, and for each node the durable facts
 * that say where the work stands: who holds its claim, what its review ledger recorded
 * (rounds, the latest round's findings), the verifier's execution receipt, and whether the
 * daemon's own acceptance is on it.
 *
 * `status` is a derived word for the card, spelled from those facts in one fixed order
 * (see `runs-read.ts`); every fact it was derived from travels beside it, so the card can
 * show the evidence and never has to trust the word. A node with legacy bare-key execution
 * facts is UNATTRIBUTABLE: those records contain no sealed owner and cannot be migrated
 * into the new scoped execution subject.
 */
import type { PlanningRunApprovalState } from "./planning-run-read.js";

export const RUNS_READ_PATH = "/runs/read" as const;
const LAYER = "RUNS_READ" as const;

export const RUNS_READ_CODES = Object.freeze([
  "RUNS_READ_CAPABILITY_DENIED",
  "RUNS_READ_GOAL_UNKNOWN",
  "RUNS_READ_PROJECT_MISMATCH",
  "RUNS_READ_UNREADABLE",
] as const);
export type RunsReadCode = (typeof RUNS_READ_CODES)[number];

export const RUN_NODE_STATUSES = Object.freeze([
  "ACCEPTED", "BLOCKED", "DELIVERED", "ESCALATED", "ESCALATION_REQUIRED", "IN_PROGRESS", "READY",
  "REPLANNED", "UNATTRIBUTABLE",
] as const);
export type RunNodeStatus = (typeof RUN_NODE_STATUSES)[number];

export interface RunNodeClaim {
  /** True when the claim is OPEN and unexpired at the daemon's clock. */
  readonly active: boolean;
  readonly claimedBy: string;
  readonly expiresAt: string;
  readonly status: "OPEN" | "RELEASED";
}
export interface RunNodeFinding {
  readonly detail: string;
  readonly round: number;
  readonly ruleId: string;
  readonly severity: string;
  readonly subject: string;
}
export interface RunNodeReceipt {
  readonly testedTreeSha: string | null;
  readonly byteCount: number;
  readonly exitCode: number;
  readonly outputSha256: string;
  readonly test: string;
  readonly workspace: string;
}
export interface RunNodeReview {
  readonly escalated: boolean;
  /** The latest round's findings, in the reviewer's order, at most a handful. */
  readonly findings: readonly RunNodeFinding[];
  /** The latest round's routing route (ACCEPT, REJECT_IMPLEMENTATION, ...), or null. */
  readonly latestRoute: string | null;
  readonly rounds: number;
  readonly unreadable: boolean;
  readonly unsuccessfulRounds: number;
  /** The review aggregate version, the expectedVersion any review command must carry. */
  readonly version: number;
}
/** What the lander did with the accepted node's files: a commit, or a refusal by code. */
export interface RunNodeLanding {
  readonly branch: string | null;
  readonly code: string | null;
  readonly files: readonly string[];
  readonly outcome: "COMMITTED" | "REFUSED";
  readonly sha: string | null;
}
export interface RunNodeView {
  readonly accepted: { readonly verifierReceiptId: string } | null;
  readonly claim: RunNodeClaim | null;
  readonly criterionIds: readonly string[];
  readonly dependsOn: readonly string[];
  /** The git landing of the accepted delivery, when the lander recorded one. */
  readonly landing: RunNodeLanding | null;
  readonly lastActivityAt: string | null;
  readonly nodeKey: string;
  /** Opaque execution identity; nodeKey remains the local graph/display name. */
  readonly nodeRef: string;
  readonly objective: string;
  /** The verifier's own execution evidence, when its receipt decision decodes. */
  readonly receipt: RunNodeReceipt | null;
  readonly review: RunNodeReview;
  /** Legacy execution attribution is unresolved, including a dependency's legacy identity. */
  readonly sharedKey: boolean;
  readonly status: RunNodeStatus;
}
/** The goal's latest publish decision and what the publisher did with it. */
export interface RunGoalPublish {
  readonly branch: string | null;
  readonly code: string | null;
  readonly decisionId: string;
  readonly outcome: "PENDING" | "PUSHED" | "REFUSED";
  readonly remoteUrl: string;
  readonly requestedAt: string;
  readonly sha: string | null;
  readonly url: string | null;
}
export interface RunGoalView {
  readonly goalId: string;
  readonly lifecycle: string | null;
  readonly nodes: readonly RunNodeView[];
  readonly publish: RunGoalPublish | null;
  readonly run: {
    readonly approval: PlanningRunApprovalState;
    readonly lifecycle: string;
    readonly reviewable: boolean;
    readonly runId: string;
  } | null;
  readonly title: string | null;
}
export interface RunsView {
  readonly goals: readonly RunGoalView[];
  readonly outcome: "RUNS";
  readonly totals: Readonly<Record<RunNodeStatus, number>> & {
    readonly goals: number;
    readonly nodes: number;
  };
}
export interface RunsRefused {
  readonly code: string;
  readonly layer: string;
  readonly outcome: "REFUSED";
}
export type RunsReadResult = RunsRefused | RunsView;

/** Exactly `{}` (every bound goal) or exactly `{ goalRef }`. */
export type RunsSelector = { readonly goalRef: string } | Record<never, never>;

export interface RunsReadPort {
  readonly boundProjectId: string;
  readRuns(selector: RunsSelector): RunsReadResult;
}

export const runsRefused = (code: string, layer: string = LAYER): RunsRefused =>
  Object.freeze({ code, layer, outcome: "REFUSED" as const });
