import { useEffect, useState } from "react";
import type { JSX } from "react";

import { readGoalSource } from "../../live/live-goal-source.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import { MIDDOT } from "../glyphs.js";

/**
 * THE PRD, on the goal that binds it. The daemon planned this goal from one stored text;
 * a person reading the board should be able to open that text without leaving the page.
 * Folded by default (it can be long), the summary carries the path and the byte count, the
 * body is the text as stored - no rendering, no excerpting, no invented headings. A goal
 * created without a source says so; nothing is shown that the daemon did not state.
 */

export interface PrdPanelProps {
  readonly outcome: GoalSourceOutcome | null;
}

export function PrdPanel({ outcome }: PrdPanelProps): JSX.Element {
  if (outcome === null) {
    return <p className="cr2-slot-kicker" data-testid="cr.prd.loading">Reading the PRD...</p>;
  }
  if (outcome.status !== "GOAL_SOURCE") {
    return outcome.status === "REFUSED" && outcome.code === "GOAL_SOURCE_UNBOUND"
      ? <p className="cr2-needs-note" data-testid="cr.prd.unbound">This goal was created without a PRD.</p>
      : (
        <p className="cr2-approve-refusal" data-testid="cr.prd.refusal" role="status">
          {`${outcome.status} ${MIDDOT} ${outcome.code} ${MIDDOT} ${outcome.layer}`}
        </p>
      );
  }
  return (
    <details className="cr2-approve-inspect cr2-prd" data-testid="cr.prd.root">
      <summary className="cr2-approve-inspect-summary" data-testid="cr.prd.summary">
        {`THE PRD ${MIDDOT} ${outcome.displayPath} ${MIDDOT} ${String(outcome.byteLength)} bytes ${MIDDOT} ${outcome.mediaType}`}
      </summary>
      <p className="cr2-approve-mono" data-testid="cr.prd.digest">{`sha256 ${outcome.contentSha256}`}</p>
      <pre className="cr2-prd-text" data-testid="cr.prd.text">{outcome.text}</pre>
    </details>
  );
}

export interface LivePrdProps {
  readonly goalRef: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Injectable for tests; the default reads POST /goals/source/read with the session's headers. */
  readonly read?: ((goalRef: string) => Promise<GoalSourceOutcome>) | undefined;
}

/** One read on mount: the bound text is immutable, so nothing polls. */
export function LivePrd({ goalRef, headers, read }: LivePrdProps): JSX.Element {
  const [outcome, setOutcome] = useState<GoalSourceOutcome | null>(null);
  const [reader] = useState(() => read ?? ((ref: string): Promise<GoalSourceOutcome> => readGoalSource(headers, ref)));
  useEffect(() => {
    let live = true;
    setOutcome(null);
    void reader(goalRef).then(
      (next) => { if (live) setOutcome(next); },
      () => { if (live) setOutcome({ code: "GOAL_SOURCE_READ_FAILED", layer: "CONTROL_ROOM_GOALS", status: "ERROR" }); },
    );
    return (): void => { live = false; };
  }, [goalRef, reader]);
  return (
    <section className="cr2-ops-panel" data-testid="cr.prd.panel">
      <h3 className="cr2-approve-heading">{`SOURCE ${MIDDOT} WHAT THIS GOAL WAS PLANNED FROM`}</h3>
      <PrdPanel outcome={outcome} />
    </section>
  );
}
