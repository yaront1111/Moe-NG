import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { LiveGoalCatalogEntry } from "../../live/live-goal-catalog.js";
import type { RunGoalView } from "../../live/live-runs.js";
import { foldBoard, nodesLine } from "../board/board-columns.js";
import type { BoardFold } from "../board/board-columns.js";
import { MIDDOT } from "../glyphs.js";
import { deriveGoalStatus } from "./goal-status.js";
import type { GoalStatus } from "./goal-status.js";
import type { GoalStateLabel, HeadlineTone } from "./goal-model.js";

/**
 * A GOAL AT A GLANCE, for the goals list: the one sentence that says where it stands, the
 * word for its state, whether it needs a human, and how its nodes are doing. Derived from
 * the same three daemon answers the opened goal's board reads (coverage, runs, offers), so
 * the list card and the board never disagree about a goal. Pure.
 */

export interface GoalGlance {
  readonly headline: string;
  readonly needsYou: boolean;
  /** The decisions waiting on a human, in a person's words, for the card's chip. */
  readonly needsYouLabels: readonly string[];
  /** "5 nodes, 3 done, 1 working, 1 stuck" (middot-joined); null before any node exists. */
  readonly nodesLine: string | null;
  /** Lower sorts first: needs a human, then stuck, then working, then waiting, then done. */
  readonly rank: number;
  readonly stage: GoalStatus["stage"];
  readonly state: GoalStateLabel;
  readonly stuck: number;
  readonly tone: HeadlineTone;
}

const NEEDS_YOU_STAGES: ReadonlySet<GoalStatus["stage"]> = new Set(["CONTRACT", "ESCALATION", "PLAN", "READY_TO_CLOSE"]);

const STAGE_LABEL: Readonly<Partial<Record<GoalStatus["stage"], string>>> = Object.freeze({
  CONTRACT: "Contract to approve",
  ESCALATION: "Review exhausted",
  PLAN: "Plan to approve",
  READY_TO_CLOSE: "Ready to close",
});

function stateOf(status: GoalStatus, fold: BoardFold | null, lifecycle: string | null): GoalStateLabel {
  if (status.stage === "CLOSED" || lifecycle === "COMPLETED") return "DONE";
  if (status.stage === "ESCALATION" || status.stage === "REPLANNED" || (fold !== null && fold.counts.BLOCKED > 0)) return "BLOCKED";
  if (lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING" || status.stage === "WORKING") return "ACTIVE";
  return "DRAFT";
}

function toneOf(state: GoalStateLabel, needsYou: boolean, stuck: number): HeadlineTone {
  if (state === "DONE") return "verified";
  if (state === "BLOCKED" || stuck > 0) return "danger";
  return needsYou ? "agent" : "accent";
}

function rankOf(state: GoalStateLabel, needsYou: boolean, stuck: number, fold: BoardFold | null): number {
  if (needsYou) return 0;
  if (state === "BLOCKED" || stuck > 0) return 1;
  if (fold !== null && fold.counts.WORKING + fold.counts.REVIEW > 0) return 2;
  if (state === "DONE") return 4;
  return 3;
}

export function deriveGoalGlance(input: {
  readonly coverage: DocumentCoverageOutcome | undefined;
  readonly entry: LiveGoalCatalogEntry;
  readonly nowMs: number;
  readonly run: RunGoalView | undefined;
  readonly surface: SurfaceFrame | null;
}): GoalGlance {
  const { coverage, entry, nowMs, run, surface } = input;
  const status = deriveGoalStatus({
    coverage: coverage ?? null, goalId: entry.goalId, runId: entry.planningRunRef, surface,
  });
  const fold = run === undefined || run.nodes.length === 0 ? null : foldBoard(run.nodes, nowMs);
  const lifecycle = run?.lifecycle
    ?? (coverage?.status === "COVERAGE" ? coverage.goals.find((row) => row.goalId === entry.goalId)?.lifecycle ?? null : null);
  const stuck = fold?.stuck ?? 0;
  const state = stateOf(status, fold, lifecycle);
  const needsYou = NEEDS_YOU_STAGES.has(status.stage);
  const labels = needsYou ? [STAGE_LABEL[status.stage] ?? status.stage] : [];
  // The status headline already says where the goal stands; a stuck node is the one fact a
  // person must not miss on the list, so it rides on the same line.
  const headline = stuck > 0 && status.stage === "WORKING"
    ? `${status.headline} ${MIDDOT} ${String(stuck)} stuck`
    : status.headline;
  return Object.freeze({
    headline,
    needsYou,
    needsYouLabels: Object.freeze(labels),
    nodesLine: fold === null ? null : nodesLine(fold),
    rank: rankOf(state, needsYou, stuck, fold),
    stage: status.stage,
    state,
    stuck,
    tone: toneOf(state, needsYou, stuck),
  });
}
