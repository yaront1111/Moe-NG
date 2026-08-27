import type { JSX } from "react";

import { EMDASH, MIDDOT } from "../glyphs.js";
import { useProof } from "../shell/proof-context.js";
import "../styles/cordum-work-board.css";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import { receiptFor } from "./work-board-receipt.js";
import type { ColumnMeaning } from "./work-labels.js";
import {
  COLUMN_MEANINGS, cardIdentity, chainRank, labelForKind, labelForMissing,
} from "./work-labels.js";

/**
 * The per-goal WORK BOARD (UI-5): a READ-ONLY view of the daemon's affordance
 * surface. It renders exactly what POST /affordances/read carries, shaped into a
 * SurfaceFrame by live-board-feed.ts, and NOTHING it does not.
 *
 * WORDS, NOT STATE. The daemon speaks in command kinds, aggregate ids and the
 * three status tokens READY / BLOCKED / COMMITTED. This board translates those
 * WORDS through work-labels.ts - a plain label per kind, a plain title and a
 * one-line meaning per column - and keeps every raw token visible underneath in
 * mono. It never renames, merges, re-counts or re-classes anything the daemon
 * said, and a command kind the label map has not been told about renders raw and
 * is marked unknown rather than given an invented name.
 *
 * NOT "STEPS". What the surface lists are commands on the PROJECT, not the plan's
 * steps: the same screen shows a plan with its own step count directly above, and
 * calling both "steps" made the two contradict each other. The count line names
 * them commands and says so out loud.
 *
 * HONESTY: the surface carries no execution lanes (PLAN / EXECUTING / REVIEW /
 * ACCEPTED) and no node acceptance, so those are not drawn. The collapsed note at
 * the foot says that in the owner's words, with the raw status tokens on one mono
 * line behind it. Drawing five lanes over three-status data would be fabrication.
 *
 * READ-ONLY: the only affordance is a per-card receipt, which opens the shell's
 * proof inspector on the card's own fields (work-board-receipt.ts). It imports
 * nothing that dispatches: a dispatch would post the fabricated dev payloads the
 * rebuild forbids.
 */

export interface WorkBoardProps {
  readonly frame: SurfaceFrame | null;
}

function ClaimChip({ step }: { readonly step: SurfaceStep }): JSX.Element | null {
  const claim = step.claim;
  if (claim === null) return null;
  return (
    <span className="cr2-board-claim" data-testid="cr.board.claim">
      {`held by ${claim.claimedBy} until ${claim.expiresAt}`}
    </span>
  );
}

function MissingNote({ step }: { readonly step: SurfaceStep }): JSX.Element | null {
  if (step.status !== "BLOCKED") return null;
  const text = step.missing.length === 0
    ? "prerequisites not yet met"
    : `needs ${step.missing.map(labelForMissing).join(", ")}`;
  return <span className="cr2-board-missing" data-testid="cr.board.missing">{text}</span>;
}

/**
 * The card's only control: it opens the receipt for THIS card in the shell's
 * proof inspector. No dispatch, no write - the payload is a restatement of the
 * fields already on screen.
 */
function InspectButton({
  step, index, label,
}: { readonly step: SurfaceStep; readonly index: number; readonly label: string }): JSX.Element {
  const { openProof } = useProof();
  return (
    <button
      aria-label={`Inspect the receipt for ${label}`}
      className="cr2-wb-inspect"
      data-testid={`cr.board.card.${step.status}.${String(index)}.inspect`}
      onClick={() => { openProof(receiptFor(step)); }}
      type="button"
    >
      Inspect
    </button>
  );
}

function StepCard({ step, index }: { readonly step: SurfaceStep; readonly index: number }): JSX.Element {
  const reading = labelForKind(step.kind);
  return (
    <li
      className="cr2-board-card"
      data-card-id={cardIdentity(step.kind, step.aggregateId)}
      data-known={reading.known ? "true" : "false"}
      data-testid={`cr.board.card.${step.status}.${String(index)}`}
    >
      <span className="cr2-board-card-head">
        <span className="cr2-wb-label" data-testid="cr.board.label">{reading.label}</span>
        <span className="cr2-wb-group" data-testid="cr.board.group">{reading.group}</span>
      </span>
      <span className="cr2-board-mono cr2-wb-raw" data-testid="cr.board.raw">
        {`${step.kind} @ ${step.aggregateId ?? EMDASH}`}
      </span>
      {reading.identityPerRead ? (
        <span className="cr2-wb-minted" data-testid="cr.board.minted">
          The daemon mints that target fresh on every read; the command stays one command.
        </span>
      ) : null}
      <ClaimChip step={step} />
      <MissingNote step={step} />
      <InspectButton index={index} label={reading.label} step={step} />
    </li>
  );
}

/**
 * Presentation order only: the surface iterates its bootstrap kinds
 * alphabetically, so a column opens on the last thing that happened. Sorting by
 * the daemon's own prerequisite chain (work-labels.ts CHAIN_ORDER) puts them back
 * in the order the work runs; ties and unknown kinds keep the surface's order.
 */
function inChainOrder(steps: readonly SurfaceStep[]): readonly SurfaceStep[] {
  return steps
    .map((step, at) => ({ at, step }))
    .sort((a, b) => chainRank(a.step.kind) - chainRank(b.step.kind) || a.at - b.at)
    .map((entry) => entry.step);
}

function Column({
  column, steps,
}: { readonly column: ColumnMeaning; readonly steps: readonly SurfaceStep[] }): JSX.Element {
  const own = inChainOrder(steps.filter((step) => step.status === column.status));
  return (
    <section className="cr2-board-column" data-testid={`cr.board.column.${column.key}`}>
      {/*
        These three ids must NOT start with "cr.board.column." - the v1 stylesheets
        in this same bundle (styles/preview-board.css:27, board/board-layout.css:21)
        style every element under that prefix as a lane box (min-block-size: 18rem),
        which turns a one-line heading into a 288px box. Pinned by test.
      */}
      <h3 className="cr2-board-column-head" data-testid={`cr.board.colhead.${column.key}`}>
        {`${column.title} ${MIDDOT} ${String(own.length)}`}
      </h3>
      <p className="cr2-wb-meaning" data-testid={`cr.board.colmeaning.${column.key}`}>
        {column.meaning}
      </p>
      <code className="cr2-wb-status" data-testid={`cr.board.colstatus.${column.key}`}>
        {column.status}
      </code>
      {own.length === 0 ? (
        <p className="cr2-board-empty" data-testid={`cr.board.empty.${column.key}`}>{column.empty}</p>
      ) : (
        <ul className="cr2-board-cards">
          {own.map((step, index) => (
            <StepCard index={index} key={`${column.key}.${String(index)}`} step={step} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The honesty note: collapsed, in the owner's words, raw statuses kept behind it. */
function ComingOnline(): JSX.Element {
  return (
    <details className="cr2-wb-gap" data-testid="cr.board.comingonline">
      <summary className="cr2-wb-gap-summary" data-testid="cr.board.comingonline.summary">
        {"What this board can't show yet"}
      </summary>
      <p className="cr2-wb-gap-body" data-testid="cr.board.comingonline.body">
        {"This board reads the daemon's own list of commands for this project: which it "
          + "would accept now, which are waiting on something first, and which are already "
          + "recorded. That list does not say which plan step is being worked on, reviewed "
          + "or accepted, so those lanes from the design are left out rather than guessed. "
          + "Nothing here is estimated."}
      </p>
      <code className="cr2-wb-gap-raw" data-testid="cr.board.comingonline.raw">
        {`surface statuses: READY ${MIDDOT} BLOCKED ${MIDDOT} COMMITTED`}
      </code>
    </details>
  );
}

function EmptyState({ testId, message }: { readonly testId: string; readonly message: string }): JSX.Element {
  return (
    <section className="cr2-board" data-testid="cr.board.root">
      <p className="cr2-board-state" data-testid={testId}>{message}</p>
    </section>
  );
}

/**
 * The count line. Every number is a count of the frame's own rows, and the last
 * sentence exists because the plan above this board carries its own step count:
 * without it, two different meanings of "step" sit on one screen.
 */
function countSentence(steps: readonly SurfaceStep[]): string {
  const of = (status: SurfaceStep["status"]): string =>
    String(steps.filter((step) => step.status === status).length);
  return `The daemon lists ${String(steps.length)} command${steps.length === 1 ? "" : "s"} `
    + `for this project: ${of("READY")} it would accept now, ${of("BLOCKED")} waiting on `
    + `something, ${of("COMMITTED")} already recorded. These are not the plan's steps above.`;
}

export function WorkBoard({ frame }: WorkBoardProps): JSX.Element {
  if (frame === null) {
    return (
      <EmptyState message="The affordance surface has not answered yet." testId="cr.board.waiting" />
    );
  }
  if (frame.connection === "DISCONNECTED") {
    return (
      <EmptyState
        message="Disconnected from the daemon. The board shows nothing it cannot currently read."
        testId="cr.board.disconnected"
      />
    );
  }
  if (frame.outcome !== "SURFACE") {
    const code = frame.detail === "" ? frame.outcome : frame.detail;
    return (
      <EmptyState
        message={`The affordance surface answered ${frame.outcome}. Its code renders verbatim: ${code}.`}
        testId="cr.board.outcome"
      />
    );
  }

  const steps = frame.steps;
  return (
    <section className="cr2-board" data-testid="cr.board.root">
      <h3 className="cr2-wb-heading" data-testid="cr.board.heading">
        Commands the daemon holds for this project
      </h3>
      <p className="cr2-board-count" data-testid="cr.board.count">{countSentence(steps)}</p>
      <div className="cr2-board-columns">
        {COLUMN_MEANINGS.map((column) => <Column column={column} key={column.key} steps={steps} />)}
      </div>
      <ComingOnline />
    </section>
  );
}
