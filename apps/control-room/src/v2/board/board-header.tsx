import type { JSX } from "react";

import { ARROW_RIGHT, MIDDOT } from "../glyphs.js";
import type { GoalStatus } from "../goals/goal-status.js";
import { GOAL_SECTION_IDS, STAGE_WORDS } from "../goals/goal-status-strip.js";
import { nodesLine } from "./board-columns.js";
import type { BoardFold } from "./board-columns.js";

/**
 * THE HEADER BAND of the board: the goal's title and the human's own brief on the left, ONE
 * progress bar in the centre, the stage and THE ONE thing to do next on the right. It ranks
 * nothing else above it, because nothing else on the page answers "where does this stand".
 *
 * Two ratios live here and are kept apart on purpose: acceptance CRITERIA verified (the
 * contract's measure, from the coverage read) and NODES done (the agents' measure, from the
 * runs read). The bar is the first; the second is a plain line beneath it.
 */

export interface BoardHeaderProps {
  readonly brief: string | null;
  readonly fold: BoardFold | null;
  readonly onNeedsYou?: (() => void) | undefined;
  /** The daemon offers repository.publish for this goal; the header points at the card. */
  readonly publishOffered: boolean;
  readonly status: GoalStatus;
  readonly title: string;
}

function NextStep({ onNeedsYou, status }: { readonly onNeedsYou?: (() => void) | undefined; readonly status: GoalStatus }): JSX.Element {
  const { next } = status;
  if (next.anchor === null) {
    return <span className="cr2-kanban-next-label" data-testid="cr.kanban.next">{next.label}</span>;
  }
  if (next.anchor === "needs-you") {
    return (
      <button className="cr2-kanban-next-label cr2-kanban-next-button" data-testid="cr.kanban.next" onClick={onNeedsYou} type="button">
        {`${next.label} ${ARROW_RIGHT}`}
      </button>
    );
  }
  return (
    <a className="cr2-kanban-next-label" data-testid="cr.kanban.next" href={`#${GOAL_SECTION_IDS[next.anchor]}`}>
      {next.label}
    </a>
  );
}

export function BoardHeader({ brief, fold, onNeedsYou, publishOffered, status, title }: BoardHeaderProps): JSX.Element {
  const { progress, stage } = status;
  const percent = progress === null || progress.criteria === 0 ? 0 : Math.round((progress.verified / progress.criteria) * 100);
  return (
    <header className="cr2-kanban-header" data-stage={stage} data-testid="cr.kanban.header">
      <div className="cr2-kanban-identity">
        <h2 className="cr2-kanban-title" data-testid="cr.kanban.title">{title}</h2>
        {brief === null || brief.trim() === "" ? null : (
          <p className="cr2-kanban-brief" data-testid="cr.kanban.brief" title={brief}>{brief}</p>
        )}
      </div>
      <div className="cr2-kanban-progress" data-testid="cr.kanban.progress">
        {progress === null ? (
          <p className="cr2-kanban-progress-label">No contract to verify against yet.</p>
        ) : (
          <>
            <p className="cr2-kanban-progress-label">
              <strong>{`${String(progress.verified)} of ${String(progress.criteria)}`}</strong>
              {" acceptance criteria verified"}
            </p>
            <div aria-label="Acceptance criteria verified" aria-valuemax={progress.criteria} aria-valuemin={0} aria-valuenow={progress.verified} className="cr2-kanban-bar" role="progressbar">
              <span className="cr2-kanban-bar-fill" style={{ width: `${String(percent)}%` }} />
            </div>
          </>
        )}
        <p className="cr2-kanban-nodes" data-testid="cr.kanban.nodes">
          {fold === null ? "No nodes yet." : nodesLine(fold)}
        </p>
      </div>
      <div className="cr2-kanban-decision">
        <span className="cr2-kanban-stage" data-testid="cr.kanban.stage">{STAGE_WORDS[stage]}</span>
        <p className="cr2-kanban-headline" data-testid="cr.kanban.headline">{status.headline}</p>
        <div className="cr2-kanban-next">
          <span className="cr2-kanban-next-kicker">Next</span>
          <NextStep onNeedsYou={onNeedsYou} status={status} />
          {publishOffered ? (
            <a className="cr2-kanban-next-label cr2-kanban-next-secondary" data-testid="cr.kanban.publish" href={`#${GOAL_SECTION_IDS.publish}`}>
              {`${MIDDOT} Publish landed commits`}
            </a>
          ) : null}
        </div>
      </div>
    </header>
  );
}
