import type { JSX } from "react";

import { FactRow } from "../nodes/node-authority.js";
import type { ProvenanceHandler, SuppliedFact } from "../nodes/node-authority.js";
import { BoardCard } from "./board-card.js";
import { BOARD_COLUMNS } from "./board-contract.js";
import type {
  BoardCardProjection, BoardColumn, BoardCommandHandler, BoardFrontierLane, BoardJoinSummary,
  BoardSurfaceProps,
} from "./board-contract.js";

/**
 * The canonical board (spec §2.2, §4.3, §11.3; design §18.1).
 *
 * Columns are the daemon's supplied placement, read as given. This module maps no phase
 * to a lane, computes no readiness, frontier, budget, or truth, applies no lifecycle
 * rule, sorts nothing, deduplicates nothing, and shows no optimistic transition. It
 * reaches no transport and mounts no graph surface.
 */
const COLUMN_TITLES: Record<BoardColumn, string> = {
  accepted: "Accepted", executing: "Executing", plan: "Plan", ready: "Ready", review: "Review",
};

const COLUMN_EMPTY_HINTS: Record<BoardColumn, string> = {
  accepted: "Nothing accepted", executing: "Nothing executing", plan: "Nothing in planning",
  ready: "Nothing ready", review: "Nothing in review",
};

const LANE_FACTS: readonly (readonly [
  suffix: string, label: string, pick: (lane: BoardFrontierLane) => SuppliedFact,
])[] = [
  ["summary", "Lane", (lane) => lane.summary],
  ["cursor", "Applied cursor", (lane) => lane.cursor],
  ["graphepoch", "Graph epoch", (lane) => lane.graphEpoch],
  ["idlecapacity", "Idle capacity", (lane) => lane.idleCapacity],
  ["readiness", "Readiness explanation", (lane) => lane.readinessExplanation],
];

interface CardRenderProps {
  readonly onActivateCommand?: BoardCommandHandler | undefined;
  readonly onProvenance?: ProvenanceHandler | undefined;
}

/** Index-qualified keys: two records may legitimately share a malformed identity. */
function CardList(props: CardRenderProps & {
  readonly cards: readonly BoardCardProjection[];
}): JSX.Element {
  const { cards, onActivateCommand, onProvenance } = props;
  return (
    <>
      {cards.map((card, index) => (
        <BoardCard
          card={card}
          key={`${String(index)}:${card.nodeId}`}
          onActivateCommand={onActivateCommand}
          onProvenance={onProvenance}
        />
      ))}
    </>
  );
}

/**
 * A lane collapses only when the daemon reported it empty at a loaded cursor. A lane
 * that is merely without data is unknown, and unknown never collapses — that is the
 * difference between "nothing is ready" and "we have not been told yet".
 */
function Column(props: CardRenderProps & {
  readonly cards: readonly BoardCardProjection[];
  readonly column: BoardColumn;
  readonly loadedEmpty: boolean;
  readonly loading: boolean;
}): JSX.Element {
  const { cards, column, loadedEmpty, loading, onActivateCommand, onProvenance } = props;
  if (!loading && loadedEmpty && cards.length === 0) {
    return (
      <div data-testid={`cr.board.column.${column}.collapsed`}>
        {`${COLUMN_TITLES[column]} — the daemon reported this lane empty`}
      </div>
    );
  }
  return (
    <div
      aria-label={COLUMN_TITLES[column]}
      data-board-column={column}
      data-testid={`cr.board.column.${column}`}
    >
      <h2 data-testid={`cr.board.heading.${column}`}>{COLUMN_TITLES[column]}</h2>
      {loading ? <div data-testid="cr.board.skeleton" /> : null}
      {!loading && cards.length === 0 ? (
        <p data-testid={`cr.board.empty.${column}`}>{COLUMN_EMPTY_HINTS[column]}</p>
      ) : null}
      <CardList cards={cards} onActivateCommand={onActivateCommand} onProvenance={onProvenance} />
    </div>
  );
}

function FrontierLanes(props: {
  readonly frontier: readonly BoardFrontierLane[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { frontier, onProvenance } = props;
  return (
    <div data-testid="cr.board.frontier">
      {frontier.map((lane) => (
        <div data-testid={`cr.board.frontier.${lane.lane}`} key={lane.lane}>
          <h2>{lane.lane}</h2>
          {LANE_FACTS.map(([suffix, label, pick]) => (
            <FactRow
              fact={pick(lane)}
              factId={`frontier.${lane.lane}.${suffix}`}
              key={suffix}
              label={label}
              onProvenance={onProvenance}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Join progress is a goal-level announcement, so it announces politely (§11.1). */
function JoinStrip(props: {
  readonly joins: readonly BoardJoinSummary[];
  readonly onProvenance?: ProvenanceHandler | undefined;
}): JSX.Element {
  const { joins, onProvenance } = props;
  return (
    <div aria-live="polite" data-testid="cr.board.joinstrip">
      {joins.map((join) => (
        <div data-testid={`cr.board.join.${join.joinId}`} key={join.joinId}>
          <FactRow
            fact={join.summary} factId={`join.${join.joinId}.summary`} label="Join"
            onProvenance={onProvenance}
          />
          <FactRow
            fact={join.inputs} factId={`join.${join.joinId}.inputs`} label="Inputs"
            onProvenance={onProvenance}
          />
        </div>
      ))}
    </div>
  );
}

export function BoardSurface(props: BoardSurfaceProps): JSX.Element {
  const {
    appliedCursorLabel, cards, degraded, frontier, joins, loadedEmptyColumns, loading,
    onActivateCommand, onProvenance, onShowTerminatedChange, showTerminated,
  } = props;
  const placed = (placement: BoardCardProjection["placement"]): readonly BoardCardProjection[] =>
    cards.filter((card) => card.placement === placement);
  const render: CardRenderProps = { onActivateCommand, onProvenance };
  return (
    <section aria-label="Board" data-testid="cr.surface.board">
      {degraded === true ? (
        <p data-testid="cr.board.asof" role="status">
          Showing last-known cards as of {appliedCursorLabel ?? "UNKNOWN"}
        </p>
      ) : null}
      <label htmlFor="cr-board-terminated">Show terminated</label>
      <input
        checked={showTerminated}
        data-testid="cr.board.filter.terminated"
        id="cr-board-terminated"
        onChange={(event) => { onShowTerminatedChange?.(event.target.checked); }}
        type="checkbox"
      />
      <div data-testid="cr.board.columns">
        {BOARD_COLUMNS.map((column) => (
          <Column
            {...render}
            cards={placed(column)}
            column={column}
            key={column}
            loadedEmpty={loadedEmptyColumns.includes(column)}
            loading={loading === true}
          />
        ))}
      </div>
      <div data-testid="cr.board.unmapped">
        <h2>Unmapped</h2>
        <CardList {...render} cards={placed(null)} />
      </div>
      <div data-testid="cr.board.terminated">
        <h2>Terminated</h2>
        {showTerminated ? <CardList {...render} cards={placed("terminated")} /> : null}
      </div>
      <FrontierLanes frontier={frontier} onProvenance={onProvenance} />
      <JoinStrip joins={joins} onProvenance={onProvenance} />
    </section>
  );
}
