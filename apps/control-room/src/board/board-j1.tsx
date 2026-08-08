import type { JSX } from "react";

import type { FixtureFact } from "../fixtures.js";
import { TruthChip } from "../kernel.js";
import { FactWithProvenance } from "../shell/provenance-panel.js";

/**
 * J1 board slice (spec §4.3). Five phase columns and phase-labelled cards, and
 * deliberately nothing else: no join strip, no silence timer, no terminated filter.
 * Those belong to J2/J5 and to the board surface task that builds over this file.
 *
 * A card is a view model handed in by the caller. The board derives no phase, no
 * readiness, and no ordering of its own.
 */
export const BOARD_J1_COLUMNS = ["plan", "ready", "executing", "review", "accepted"] as const;
export type BoardJ1Column = (typeof BOARD_J1_COLUMNS)[number];

const COLUMN_TITLES: Record<BoardJ1Column, string> = {
  accepted: "Accepted",
  executing: "Executing",
  plan: "Planning",
  ready: "Ready",
  review: "Review",
};

export interface BoardJ1Card {
  readonly column: BoardJ1Column;
  readonly name: string;
  readonly nodeId: string;
  readonly phase: string;
  /** Payload-supplied; `unknown` because the kernel decides what it means. */
  readonly truthClass: unknown;
}

export interface BoardJ1Props {
  readonly cards: readonly BoardJ1Card[];
  readonly facts: readonly FixtureFact[];
}

function Card({ card }: { readonly card: BoardJ1Card }): JSX.Element {
  return (
    <article data-testid={`cr.board.card.${card.nodeId}`}>
      <h3 data-testid="cr.board.card.name">{card.name}</h3>
      <span data-testid="cr.board.card.phase">{card.phase}</span>
      <TruthChip truthClass={card.truthClass} />
    </article>
  );
}

export function BoardJ1({ cards, facts }: BoardJ1Props): JSX.Element {
  return (
    <section aria-label="Board" data-testid="cr.surface.board">
      {facts.map((fact) => (
        <FactWithProvenance fact={fact} key={fact.factId} />
      ))}
      {BOARD_J1_COLUMNS.map((column) => (
        <div aria-label={COLUMN_TITLES[column]} data-testid={`cr.board.column.${column}`}
          key={column}>
          <h2>{COLUMN_TITLES[column]}</h2>
          {cards
            .filter((card) => card.column === column)
            .map((card) => (
              <Card card={card} key={card.nodeId} />
            ))}
        </div>
      ))}
    </section>
  );
}
