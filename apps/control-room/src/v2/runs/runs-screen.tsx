import type { JSX } from "react";

import type { RunGoalView, RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { BoardLanes } from "../board/board-lanes.js";
import { ROUTE_WORDS, foldBoard, nodesLine, untilWords } from "../board/board-columns.js";
import { MIDDOT } from "../glyphs.js";
import { seatWords } from "../ops/activity-words.js";
import { GOAL_WORDS, RUN_WORDS } from "./run-words.js";

export { STATUS_WORDS } from "./run-words.js";
export { ROUTE_WORDS } from "../board/board-columns.js";

/**
 * RUNS & LEASES: every goal's plan as a ladder of nodes, each node with the one word the
 * daemon's facts add up to and the facts themselves beside it - who holds the claim and
 * until when, how many review rounds and how the last one routed, the acceptance receipt.
 * Pure: no fetch, no clock beyond the `nowMs` it is handed for relative times.
 */

export interface RunsScreenProps {
  readonly nowMs: number;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
  readonly outcome: RunsOutcome | null;
}

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
    lines.push("another activated plan carries this work, so its review cannot be attributed to this goal");
  }
  if (node.accepted !== null) lines.push("accepted by the daemon");
  if (node.receipt !== null) {
    lines.push(`verifier ran ${node.receipt.test}, exit ${String(node.receipt.exitCode)}`);
  }
  if (node.landing !== null) {
    lines.push(node.landing.outcome === "COMMITTED"
      ? `landed on ${node.landing.branch ?? "the workspace branch"} ${MIDDOT} ${String(node.landing.files.length)} file${node.landing.files.length === 1 ? "" : "s"}, local only`
      : "not landed yet");
  }
  if (node.review.rounds > 0) {
    const route = node.review.latestRoute === null ? "" : ` ${MIDDOT} last ${ROUTE_WORDS[node.review.latestRoute] ?? node.review.latestRoute}`;
    lines.push(`${String(node.review.rounds)} review round${node.review.rounds === 1 ? "" : "s"}${route}`);
  }
  if (node.review.unsuccessfulRounds > 0) {
    lines.push(`${String(node.review.unsuccessfulRounds)} unsuccessful`
      + (node.status === "ESCALATION_REQUIRED" ? ": needs your decision before more rounds" : ""));
  }
  if (node.claim !== null) {
    const who = seatWords(node.claim.claimedBy);
    if (node.claim.active) {
      const left = untilWords(node.claim.expiresAt, nowMs);
      lines.push(left === null ? `${who} ${MIDDOT} lease expired` : `${who} ${MIDDOT} lease ends ${left}`);
    } else {
      lines.push(`${who} (${node.claim.status === "RELEASED" ? "released" : "expired"})`);
    }
  }
  if (node.dependsOn.length > 0) lines.push("waiting on other work");
  const when = ago(node.lastActivityAt, nowMs);
  if (when !== null) lines.push(`last activity ${when}`);
  return lines;
}

function runLine(goal: RunGoalView): string {
  if (goal.run === null) return "No plan has been run for this goal yet.";
  const approval = goal.run.approval === "BOUND" ? "approved"
    : goal.run.approval === "ABSENT" ? "awaiting approval" : "approval unreadable";
  return `${RUN_WORDS[goal.run.lifecycle] ?? goal.run.lifecycle} ${MIDDOT} ${approval}`;
}

/** One goal as a board. `embedded` (the opened goal's own page) drops the title link and kicker. */
export function GoalSection({ embedded = false, goal, nowMs, onOpenBoard }: {
  readonly embedded?: boolean; readonly goal: RunGoalView; readonly nowMs: number; readonly onOpenBoard: RunsScreenProps["onOpenBoard"];
}): JSX.Element {
  const title = goal.title ?? goal.goalId;
  const runRef = goal.run?.runId ?? "";
  const fold = goal.nodes.length === 0
    ? null : foldBoard(goal.nodes, nowMs, goal.publish?.outcome === "PUSHED" ? goal.publish.sha : null);
  return (
    <section className="cr2-run-goal" data-embedded={embedded ? "true" : undefined} data-testid={`cr.runs.goal.${goal.goalId}`}>
      <div className="cr2-run-goal-head">
        <div>
          {embedded ? null : (
            <p className="cr2-slot-kicker">
              {goal.lifecycle === null ? "Goal" : GOAL_WORDS[goal.lifecycle] ?? goal.lifecycle}
            </p>
          )}
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
            </h2>
          )}
          <p className="cr2-run-goal-run" data-testid={`cr.runs.goal.${goal.goalId}.run`}>{runLine(goal)}</p>
        </div>
      </div>
      {fold === null ? (
        <p className="cr2-needs-note" data-testid={`cr.runs.goal.${goal.goalId}.empty`}>
          No work yet: it appears once an approved plan is activated.
        </p>
      ) : (
        <BoardLanes criterionStatement={(): null => null} fold={fold} nowMs={nowMs} />
      )}
    </section>
  );
}

function totalsLine(outcome: Extract<RunsOutcome, { status: "RUNS" }>, nowMs: number): string {
  const fold = foldBoard(outcome.goals.flatMap((goal) => goal.nodes), nowMs);
  return `${String(outcome.totals.goals)} goal${outcome.totals.goals === 1 ? "" : "s"} ${MIDDOT} ${nodesLine(fold)}`;
}

export function RunsScreen({ nowMs, onOpenBoard, outcome }: RunsScreenProps): JSX.Element {
  return (
    <section className="cr2-runs" data-testid="cr.runs.root">
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.runs.loading">Reading the runs...</p>
      ) : outcome.status !== "RUNS" ? (
        <p className="cr2-approve-refusal" data-testid="cr.runs.refusal">
          The runs could not be read right now.
        </p>
      ) : (
        <>
          <span className="cr2-goals-count" data-testid="cr.runs.totals">{totalsLine(outcome, nowMs)}</span>
          {outcome.goals.length === 0 ? (
            <div className="cr2-goals-empty" data-testid="cr.runs.empty">
              <p className="cr2-goals-empty-title">No goals to run yet.</p>
              <p className="cr2-goals-empty-body">Create a goal from a PRD and approve its plan; its nodes appear here as agents take them.</p>
            </div>
          ) : outcome.goals.map((goal) => (
            <GoalSection goal={goal} key={goal.goalId} nowMs={nowMs} onOpenBoard={onOpenBoard} />
          ))}
        </>
      )}
    </section>
  );
}
