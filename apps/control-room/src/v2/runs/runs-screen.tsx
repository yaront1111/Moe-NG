import type { JSX } from "react";

import type { RunGoalView, RunNodeStatus, RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { MIDDOT } from "../glyphs.js";

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

export const STATUS_WORDS: Readonly<Record<RunNodeStatus, string>> = Object.freeze({
  ACCEPTED: "Accepted",
  BLOCKED: "Ledger unreadable",
  DELIVERED: "Delivered, awaiting the verifier",
  ESCALATED: "Escalated",
  ESCALATION_REQUIRED: "Needs escalation",
  IN_PROGRESS: "In progress",
  READY: "Ready for an agent",
});

const ROUTE_WORDS: Readonly<Record<string, string>> = Object.freeze({
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
  if (node.accepted !== null) lines.push(`accepted by the daemon ${MIDDOT} receipt ${node.accepted.verifierReceiptId}`);
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
      ? `held by ${node.claim.claimedBy} until ${node.claim.expiresAt}`
      : `last held by ${node.claim.claimedBy} (${node.claim.status === "RELEASED" ? "released" : "expired"})`);
  }
  if (node.dependsOn.length > 0) lines.push(`after ${node.dependsOn.join(", ")}`);
  const when = ago(node.lastActivityAt, nowMs);
  if (when !== null) lines.push(`last activity ${when}`);
  return lines;
}

function NodeRow({ node, nowMs }: { readonly node: RunNodeView; readonly nowMs: number }): JSX.Element {
  return (
    <li className="cr2-run-node" data-status={node.status} data-testid={`cr.runs.node.${node.nodeKey}`}>
      <span className="cr2-run-status" data-testid={`cr.runs.node.${node.nodeKey}.status`}>
        {STATUS_WORDS[node.status]}
      </span>
      <div className="cr2-run-node-main">
        <p className="cr2-run-node-title">
          <span className="cr2-approve-mono">{node.nodeKey}</span>
          <span className="cr2-run-node-objective">{node.objective}</span>
        </p>
        <p className="cr2-run-node-evidence" data-testid={`cr.runs.node.${node.nodeKey}.evidence`}>
          {nodeEvidence(node, nowMs).join(` ${MIDDOT} `)}
        </p>
        {node.criterionIds.length === 0 ? null : (
          <p className="cr2-run-node-criteria">{`criteria ${node.criterionIds.join(", ")}`}</p>
        )}
      </div>
    </li>
  );
}

function runLine(goal: RunGoalView): string {
  if (goal.run === null) return "No plan has been run for this goal yet.";
  const approval = goal.run.approval === "BOUND" ? "approval bound"
    : goal.run.approval === "ABSENT" ? "awaiting approval" : "approval unreadable";
  return `Run ${goal.run.runId} ${MIDDOT} ${goal.run.lifecycle} ${MIDDOT} ${approval}`;
}

function GoalSection({ goal, nowMs, onOpenBoard }: {
  readonly goal: RunGoalView; readonly nowMs: number; readonly onOpenBoard: RunsScreenProps["onOpenBoard"];
}): JSX.Element {
  const title = goal.title ?? goal.goalId;
  const runRef = goal.run?.runId ?? "";
  return (
    <section className="cr2-run-goal" data-testid={`cr.runs.goal.${goal.goalId}`}>
      <div className="cr2-run-goal-head">
        <div>
          <p className="cr2-slot-kicker">{`GOAL ${MIDDOT} ${goal.lifecycle ?? "UNKNOWN"}`}</p>
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
          <p className="cr2-run-goal-run" data-testid={`cr.runs.goal.${goal.goalId}.run`}>{runLine(goal)}</p>
        </div>
      </div>
      {goal.nodes.length === 0 ? (
        <p className="cr2-needs-note" data-testid={`cr.runs.goal.${goal.goalId}.empty`}>
          No nodes yet: they appear once an approved plan is activated.
        </p>
      ) : (
        <ol className="cr2-run-ladder">
          {goal.nodes.map((node) => <NodeRow key={node.nodeKey} node={node} nowMs={nowMs} />)}
        </ol>
      )}
    </section>
  );
}

function totalsLine(outcome: Extract<RunsOutcome, { status: "RUNS" }>): string {
  const { totals } = outcome;
  const parts = [`${String(totals.nodes)} node${totals.nodes === 1 ? "" : "s"}`];
  for (const status of ["ACCEPTED", "DELIVERED", "IN_PROGRESS", "READY", "ESCALATION_REQUIRED", "ESCALATED", "BLOCKED"] as const) {
    if (totals[status] > 0) parts.push(`${String(totals[status])} ${STATUS_WORDS[status].toLowerCase()}`);
  }
  return `${String(totals.goals)} goal${totals.goals === 1 ? "" : "s"} ${MIDDOT} ${parts.join(` ${MIDDOT} `)}`;
}

export function RunsScreen({ nowMs, onOpenBoard, outcome }: RunsScreenProps): JSX.Element {
  return (
    <section className="cr2-runs" data-testid="cr.runs.root">
      {outcome === null ? (
        <p className="cr2-slot-kicker" data-testid="cr.runs.loading">Reading the runs...</p>
      ) : outcome.status !== "RUNS" ? (
        <p className="cr2-approve-refusal" data-testid="cr.runs.refusal">
          {`${outcome.status} ${MIDDOT} ${outcome.code} ${MIDDOT} ${outcome.layer}`}
        </p>
      ) : (
        <>
          <span className="cr2-goals-count" data-testid="cr.runs.totals">{totalsLine(outcome)}</span>
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
