import type { JSX } from "react";

import { ActionButton } from "../components/primitives.js";
import { ARROW_LEFT, MIDDOT } from "../glyphs.js";

/**
 * A stub for the per-goal board (the real one is UI-5). "Open board" routes here
 * so the goals-home navigation is real, while the board's five lanes, frontier,
 * and join progress land in the next slice. It states plainly that it is a
 * placeholder rather than drawing lanes with nothing behind them.
 */

export interface BoardStubProps {
  readonly goalId: string;
  readonly title: string;
  readonly onBack: () => void;
}

export function BoardStub({ goalId, title, onBack }: BoardStubProps): JSX.Element {
  return (
    <section className="cr2-boardstub" data-testid="cr.goals.boardstub">
      <p className="cr2-slot-kicker">{`BOARD ${MIDDOT} ${goalId}`}</p>
      <h2 className="cr2-slot-title">{title}</h2>
      <p className="cr2-slot-body">
        The per-goal board attaches in the next slice (UI-5): the five lanes
        (PLAN / READY / EXECUTING / REVIEW / ACCEPTED), the frontier lanes, and
        join progress, each dispatching from the daemon&apos;s own offer surface.
        Until then this is a placeholder, not a board drawn over data it cannot yet
        read.
      </p>
      <ActionButton onClick={onBack} testId="cr.goals.boardstub.back" variant="secondary">
        {`${ARROW_LEFT} Back to goals`}
      </ActionButton>
    </section>
  );
}
