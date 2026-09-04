import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { ARROW_RIGHT, MIDDOT } from "../glyphs.js";
import { deriveGoalStatus } from "./goal-status.js";
import type { GoalStatus } from "./goal-status.js";

/**
 * THE FIRST THING ON AN OPENED GOAL: where it stands and the one thing to do next, before
 * any card. A person arriving here should not have to read the contract, the plan, the
 * board and the ledger to learn that. The strip is derived (goal-status.ts) from answers
 * the page already reads; it links to the section that carries the step, it never acts.
 */

export const STAGE_WORDS: Readonly<Record<GoalStatus["stage"], string>> = Object.freeze({
  CLOSED: "Closed",
  CONTRACT: "Contract to approve",
  ESCALATION: "Review exhausted",
  NO_PRD: "No PRD",
  PLAN: "Plan review",
  READY_TO_CLOSE: "Ready to close",
  REPLANNED: "Replanned",
  UNKNOWN: "Reading",
  WORKING: "Agents working",
});

/** The page anchors the opened goal's sections carry; the strip links, the page owns the ids. */
export const GOAL_SECTION_IDS = Object.freeze({
  activity: "cr-goal-activity", board: "cr-goal-board", contract: "cr-goal-contract", plan: "cr-goal-plan",
  publish: "cr-goal-publish",
});

export interface GoalStatusStripProps {
  /** Takes the person to Needs you, where closes and escalations are decided. */
  readonly onNeedsYou?: (() => void) | undefined;
  readonly status: GoalStatus;
}

export function GoalStatusStrip({ onNeedsYou, status }: GoalStatusStripProps): JSX.Element {
  const { agents, next, progress, stage } = status;
  const facts: string[] = [];
  if (progress !== null) facts.push(`${String(progress.verified)} of ${String(progress.criteria)} criteria verified`);
  if (agents !== null) facts.push(`${String(agents.accepted)} of ${String(agents.total)} nodes accepted`);
  return (
    <section aria-label="Where this goal stands" className="cr2-goal-status" data-stage={stage} data-testid="cr.goalstatus.root">
      <div className="cr2-goal-status-lead">
        <span className="cr2-goal-status-stage" data-testid="cr.goalstatus.stage">{STAGE_WORDS[stage]}</span>
        <p className="cr2-goal-status-headline" data-testid="cr.goalstatus.headline">{status.headline}</p>
        {facts.length === 0 ? null : (
          <p className="cr2-goal-status-facts" data-testid="cr.goalstatus.facts">{facts.join(` ${MIDDOT} `)}</p>
        )}
      </div>
      <div className="cr2-goal-status-next">
        <span className="cr2-goal-status-next-kicker">Next</span>
        {next.anchor === null ? (
          <span className="cr2-goal-status-next-label" data-testid="cr.goalstatus.next">{next.label}</span>
        ) : next.anchor === "needs-you" ? (
          <button className="cr2-goal-status-next-label cr2-goal-status-next-button" data-testid="cr.goalstatus.next" onClick={onNeedsYou} type="button">
            {`${next.label} ${ARROW_RIGHT}`}
          </button>
        ) : (
          <a className="cr2-goal-status-next-label" data-testid="cr.goalstatus.next" href={`#${GOAL_SECTION_IDS[next.anchor]}`}>
            {next.label}
          </a>
        )}
        <p className="cr2-goal-status-next-detail" data-testid="cr.goalstatus.detail">{next.detail}</p>
      </div>
    </section>
  );
}

export interface LiveGoalStatusProps {
  readonly goalId: string;
  readonly onNeedsYou?: (() => void) | undefined;
  readonly pollMs?: number | undefined;
  /** The coverage reader the page already holds; the strip reads the opened goal with it. */
  readonly read: (goalId: string) => Promise<DocumentCoverageOutcome>;
  readonly runId: string;
  /** The board's own affordance frame, shared so the strip and the board agree on offers. */
  readonly surface: SurfaceFrame | null;
}

const POLL_MS = 5_000;

export function LiveGoalStatus({ goalId, onNeedsYou, pollMs, read, runId, surface }: LiveGoalStatusProps): JSX.Element {
  const [coverage, setCoverage] = useState<DocumentCoverageOutcome | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setCoverage(null);
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void read(goalId).then((next) => {
        inFlight = false;
        if (generation.current === run) setCoverage(next);
      }, () => { inFlight = false; });
    };
    tick();
    const timer = setInterval(tick, pollMs ?? POLL_MS);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [goalId, pollMs, read]);
  return <GoalStatusStrip onNeedsYou={onNeedsYou} status={deriveGoalStatus({ coverage, goalId, runId, surface })} />;
}
