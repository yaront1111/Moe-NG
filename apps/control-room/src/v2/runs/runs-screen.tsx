import type { JSX } from "react";

import "../styles/cordum-board.css";
import type { RunGoalView, RunNodeStatus, RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { BOARD_COLUMNS, COLUMN_WORDS, foldBoard, nodesLine, untilWords } from "../board/board-columns.js";
import type { BoardColumn, BoardFold } from "../board/board-columns.js";
import { BoardLanes } from "../board/board-lanes.js";
import { Freshness } from "../components/freshness.js";
import type { FreshnessProps } from "../components/freshness.js";
import { MIDDOT } from "../glyphs.js";
import { publishLine } from "../goals/goal-publish.js";

/** When the daemon last answered, on the live screen's own clock; absent on a pure render. */
export interface ScreenFreshness {
  readonly clockMs: number;
  readonly lastAnswerMs: FreshnessProps["lastAnswerMs"];
}

/**
 * RUNS: every goal's work as a board. The project's node counts across the six columns come
 * first; then one section per goal - its title, its state, how its nodes are doing, where
 * it was published - over the same six lanes the opened goal shows. Goals with stuck work
 * sort first, then goals with work in flight, then the rest, done last. Pure: no fetch, no
 * clock beyond the `nowMs` it is handed for relative times.
 */

export interface RunsScreenProps {
  readonly freshness?: ScreenFreshness | undefined;
  readonly nowMs: number;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
  readonly outcome: RunsOutcome | null;
}

export const STATUS_WORDS: Readonly<Record<RunNodeStatus, string>> = Object.freeze({
  ACCEPTED: "Accepted",
  BLOCKED: "Ledger unreadable",
  DELIVERED: "Delivered, awaiting the verifier",
  ESCALATED: "Escalated",
  ESCALATION_REQUIRED: "Needs escalation",
  IN_PROGRESS: "In progress",
  READY: "Ready for an agent",
  REPLANNED: "Replanned into a successor goal",
  UNATTRIBUTABLE: "Shared key, not attributable",
});

/** Lifecycle tokens the daemon folds, in a person's words; an unknown token stays as it is. */
export const GOAL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  CANCELLED: "Cancelled", CLOSING: "Closing", COMPLETED: "Done", DRAFT: "Planning",
  EXECUTION_ENABLED: "Active", PLANNING: "Planning", PLAN_REVIEW: "Plan in review",
});

export const ROUTE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ACCEPT: "review passed",
  ESCALATE: "review escalated",
  REJECT_IMPLEMENTATION: "rejected: implementation",
  REJECT_PLAN: "rejected: same finding again",
  UNKNOWN_EVIDENCE: "rejected: evidence unknown",
});

function ago(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
}

/** The evidence line under a node: only facts the daemon stated, in a person's words. */
export function nodeEvidence(node: RunNodeView, nowMs: number): readonly string[] {
  const lines: string[] = [];
  if (node.sharedKey) {
    lines.push("another activated plan carries this node key, so its review ledger cannot be attributed to this goal");
  }
  if (node.accepted !== null) lines.push(`accepted by the daemon ${MIDDOT} receipt ${node.accepted.verifierReceiptId}`);
  if (node.receipt !== null) {
    lines.push(`verifier ran ${node.receipt.test} in ${node.receipt.workspace}, exit ${String(node.receipt.exitCode)},`
      + ` output ${node.receipt.outputSha256.slice(0, 12)} (${String(node.receipt.byteCount)} bytes)`);
  }
  if (node.landing !== null) {
    lines.push(node.landing.outcome === "COMMITTED"
      ? `landed as commit ${(node.landing.sha ?? "").slice(0, 10)} on ${node.landing.branch ?? "?"}`
        + ` ${MIDDOT} ${String(node.landing.files.length)} file${node.landing.files.length === 1 ? "" : "s"}, local only`
      : `not landed in git: ${node.landing.code ?? "REFUSED"}`);
  }
  if (node.review.rounds > 0) {
    const route = node.review.latestRoute === null ? "" : ` ${MIDDOT} last ${ROUTE_WORDS[node.review.latestRoute] ?? node.review.latestRoute}`;
    lines.push(`${String(node.review.rounds)} review round${node.review.rounds === 1 ? "" : "s"}${route}`);
  }
  if (node.review.unsuccessfulRounds > 0) {
    lines.push(`${String(node.review.unsuccessfulRounds)} unsuccessful`
      + (node.status === "ESCALATION_REQUIRED" ? `: the daemon refuses more rounds until a human escalates` : ""));
  }
  if (node.claim !== null) {
    lines.push(node.claim.active
      ? `held by ${node.claim.claimedBy} ${MIDDOT} lease ends ${untilWords(node.claim.expiresAt, nowMs) ?? "now"}`
      : `last held by ${node.claim.claimedBy} (${node.claim.status === "RELEASED" ? "released" : "expired"})`);
  }
  if (node.dependsOn.length > 0) lines.push(`after ${node.dependsOn.join(", ")}`);
  const when = ago(node.lastActivityAt, nowMs);
  if (when !== null) lines.push(`last activity ${when}`);
  return lines;
}

/** Where the goal stands, in one line: the plan's state before nodes exist, the nodes after. */
function standingLine(goal: RunGoalView, fold: BoardFold | null): string {
  if (fold !== null) return nodesLine(fold);
  if (goal.run === null) return "No plan has been run for this goal yet.";
  if (goal.run.approval === "BOUND") return "Plan approved; nodes appear once it is activated.";
  if (goal.run.approval === "ABSENT") return "Plan submitted; waiting for your approval.";
  return "The plan's approval could not be read.";
}

/** Goals with stuck work first, then work in flight, then waiting, then done. */
function rankOf(goal: RunGoalView, fold: BoardFold | null): number {
  if (fold === null) return goal.lifecycle === "COMPLETED" ? 4 : 3;
  if (fold.stuck > 0) return 0;
  if (fold.counts.WORKING + fold.counts.REVIEW > 0) return 1;
  if (fold.counts.QUEUED > 0) return 2;
  return goal.lifecycle === "COMPLETED" || fold.counts.DONE === fold.total ? 4 : 3;
}

const NO_STATEMENT = (): null => null;

/** One goal's board. `embedded` (the opened goal's own page) drops the title link. */
export function GoalSection({ embedded = false, goal, nowMs, onOpenBoard }: {
  readonly embedded?: boolean; readonly goal: RunGoalView; readonly nowMs: number; readonly onOpenBoard: RunsScreenProps["onOpenBoard"];
}): JSX.Element {
  const title = goal.title ?? goal.goalId;
  const runRef = goal.run?.runId ?? "";
  const fold = goal.nodes.length === 0 ? null : foldBoard(goal.nodes, nowMs);
  const state = goal.lifecycle === null ? "" : GOAL_WORDS[goal.lifecycle] ?? goal.lifecycle;
  return (
    <section
      className="cr2-run-goal"
      data-embedded={embedded ? "true" : undefined}
      data-stuck={fold !== null && fold.stuck > 0 ? "true" : undefined}
      data-testid={`cr.runs.goal.${goal.goalId}`}
    >
      <div className="cr2-run-goal-head">
        <div className="cr2-run-goal-lead">
          {embedded ? null : (
            <h2 className="cr2-run-goal-title">
              <button
                className="cr2-goal-titlebutton"
                data-testid={`cr.runs.goal.${goal.goalId}.open`}
                disabled={runRef === ""}
                onClick={(): void => onOpenBoard(goal.goalId, runRef, title)}
                type="button"
              >
                {title}
              </button>
              {state === "" ? null : <span className="cr2-run-goal-state" data-lifecycle={goal.lifecycle ?? undefined}>{state}</span>}
            </h2>
          )}
          <p className="cr2-run-goal-run" data-testid={`cr.runs.goal.${goal.goalId}.run`}>{standingLine(goal, fold)}</p>
          {goal.publish === null ? null : (
            <p className="cr2-run-goal-publish" data-testid={`cr.runs.goal.${goal.goalId}.publish`}>{publishLine(goal.publish)}</p>
          )}
        </div>
      </div>
      {fold === null ? (
        <p className="cr2-needs-note" data-testid={`cr.runs.goal.${goal.goalId}.empty`}>
          No nodes yet: they appear once an approved plan is activated.
        </p>
      ) : (
        <BoardLanes criterionStatement={NO_STATEMENT} fold={fold} nowMs={nowMs} />
      )}
    </section>
  );
}

/** The project's node counts across the six columns, as a strip of heads, plus one sentence. */
function Totals({ freshness, outcome, nowMs }: {
  readonly freshness: ScreenFreshness | undefined; readonly outcome: Extract<RunsOutcome, { status: "RUNS" }>; readonly nowMs: number;
}): JSX.Element {
  const counts: Record<BoardColumn, number> = { BLOCKED: 0, DONE: 0, QUEUED: 0, REVIEW: 0, REWORK: 0, WORKING: 0 };
  for (const goal of outcome.goals) {
    if (goal.nodes.length === 0) continue;
    const fold = foldBoard(goal.nodes, nowMs);
    for (const column of BOARD_COLUMNS) counts[column] += fold.counts[column];
  }
  const { goals, nodes } = outcome.totals;
  const sentence = `${String(goals)} goal${goals === 1 ? "" : "s"} ${MIDDOT} ${String(nodes)} node${nodes === 1 ? "" : "s"}`;
  return (
    <div className="cr2-runs-totals" data-testid="cr.runs.totals" title={sentence}>
      <span className="cr2-runs-totals-sentence">{sentence}</span>
      {freshness === undefined ? null : (
        <Freshness lastAnswerMs={freshness.lastAnswerMs} nowMs={freshness.clockMs} testId="cr.runs.freshness" />
      )}
      {BOARD_COLUMNS.map((column) => (
        <span className="cr2-runs-total" data-column={column} data-count={String(counts[column])} data-testid={`cr.runs.total.${column}`} key={column}>
          <span className="cr2-runs-total-count">{String(counts[column])}</span>
          <span className="cr2-runs-total-word">{COLUMN_WORDS[column]}</span>
        </span>
      ))}
    </div>
  );
}

export function RunsScreen({ freshness, nowMs, onOpenBoard, outcome }: RunsScreenProps): JSX.Element {
  return (
    <section className="cr2-runs" data-testid="cr.runs.root">
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.runs.loading">Reading the runs...</p>
      ) : outcome.status !== "RUNS" ? (
        <p className="cr2-approve-refusal" data-testid="cr.runs.refusal" title={`${outcome.code} ${MIDDOT} ${outcome.layer}`}>
          {`The runs could not be read right now (${outcome.code}).`}
        </p>
      ) : (
        <>
          <Totals freshness={freshness} nowMs={nowMs} outcome={outcome} />
          {outcome.goals.length === 0 ? (
            <div className="cr2-goals-empty" data-testid="cr.runs.empty">
              <p className="cr2-goals-empty-title">No goals to run yet.</p>
              <p className="cr2-goals-empty-body">Create a goal from a PRD and approve its plan; its nodes appear here as agents take them.</p>
            </div>
          ) : [...outcome.goals]
            .map((goal, index) => ({ goal, index, rank: rankOf(goal, goal.nodes.length === 0 ? null : foldBoard(goal.nodes, nowMs)) }))
            .sort((left, right) => left.rank - right.rank || left.index - right.index)
            .map(({ goal }) => (
              <GoalSection goal={goal} key={goal.goalId} nowMs={nowMs} onOpenBoard={onOpenBoard} />
            ))}
        </>
      )}
    </section>
  );
}
