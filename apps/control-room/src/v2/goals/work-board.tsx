import type { JSX } from "react";

import { EMDASH, MIDDOT } from "../glyphs.js";
import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";

/**
 * The per-goal WORK BOARD (UI-5): a READ-ONLY view of the daemon's affordance
 * surface. It renders exactly what POST /affordances/read carries, shaped into a
 * SurfaceFrame by live-board-feed.ts, and NOTHING it does not.
 *
 * HONESTY: the surface carries steps with only three statuses - READY, BLOCKED,
 * COMMITTED - each optionally with a durable claim, a kind, missing[]
 * prerequisites, an aggregateId and a version. It does NOT carry the design's
 * five execution lanes (PLAN / READY / EXECUTING / REVIEW / ACCEPTED) or node
 * acceptance (deriveLiveGoals documents the same gap). So this board draws THREE
 * columns keyed to the real statuses - Ready / Blocked / Committed - plus an
 * explicit coming-online panel naming the lanes and node acceptance as not yet on
 * the surface. Drawing five lanes over three-status data would be fabrication and
 * is forbidden.
 *
 * This module is pure presentation over a frame (the live feed is owned by
 * LiveWorkBoard, mirroring GoalsHome/LiveGoalsHome). It imports nothing that
 * dispatches: a dispatch would post the fabricated dev payloads the rebuild
 * forbids. Read-only.
 */

export interface WorkBoardProps {
  readonly frame: SurfaceFrame | null;
}

interface ColumnSpec {
  readonly key: string;
  readonly title: string;
  readonly status: SurfaceStep["status"];
  readonly empty: string;
}

const COLUMNS: readonly ColumnSpec[] = Object.freeze([
  Object.freeze({ key: "ready", title: "Ready", status: "READY", empty: "No steps ready" }),
  Object.freeze({ key: "blocked", title: "Blocked", status: "BLOCKED", empty: "No steps blocked" }),
  Object.freeze({
    key: "committed", title: "Committed", status: "COMMITTED", empty: "No steps committed",
  }),
]);

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
    : `needs ${step.missing.join(", ")}`;
  return <span className="cr2-board-missing" data-testid="cr.board.missing">{text}</span>;
}

function StepCard({ step, index }: { readonly step: SurfaceStep; readonly index: number }): JSX.Element {
  return (
    <li className="cr2-board-card" data-testid={`cr.board.card.${step.status}.${String(index)}`}>
      <span className="cr2-board-card-head">
        <span className="cr2-board-kind">{step.kind}</span>
        <span className="cr2-board-mono">{step.aggregateId ?? EMDASH}</span>
      </span>
      <ClaimChip step={step} />
      <MissingNote step={step} />
    </li>
  );
}

function Column({ spec, steps }: { readonly spec: ColumnSpec; readonly steps: readonly SurfaceStep[] }): JSX.Element {
  const own = steps.filter((step) => step.status === spec.status);
  return (
    <section className="cr2-board-column" data-testid={`cr.board.column.${spec.key}`}>
      <h3 className="cr2-board-column-head">{`${spec.title} ${MIDDOT} ${String(own.length)}`}</h3>
      {own.length === 0 ? (
        <p className="cr2-board-empty" data-testid={`cr.board.empty.${spec.key}`}>{spec.empty}</p>
      ) : (
        <ul className="cr2-board-cards">
          {own.map((step, index) => <StepCard index={index} key={`${spec.key}.${String(index)}`} step={step} />)}
        </ul>
      )}
    </section>
  );
}

/** The honesty panel: shown in every SURFACE render, naming what the surface omits. */
function ComingOnline(): JSX.Element {
  return (
    <section className="cr2-board-comingonline" data-testid="cr.board.comingonline">
      <h3 className="cr2-board-comingonline-head">Coming online</h3>
      <p className="cr2-board-comingonline-body">
        {"The affordance surface carries only three step statuses (READY, BLOCKED, "
          + "COMMITTED), so this board shows exactly those three columns. The design's "
          + "execution lanes (PLAN / EXECUTING / REVIEW / ACCEPTED) and node acceptance "
          + "are not carried by the affordance surface yet, so they are not drawn here - "
          + "no fabricated lane stands in for data the surface does not report."}
      </p>
    </section>
  );
}

function EmptyState({ testId, message }: { readonly testId: string; readonly message: string }): JSX.Element {
  return (
    <section className="cr2-board" data-testid="cr.board.root">
      <p className="cr2-board-state" data-testid={testId}>{message}</p>
    </section>
  );
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
      <p className="cr2-board-count" data-testid="cr.board.count">
        {`${String(steps.length)} step${steps.length === 1 ? "" : "s"} on the surface`}
      </p>
      <div className="cr2-board-columns">
        {COLUMNS.map((spec) => <Column key={spec.key} spec={spec} steps={steps} />)}
      </div>
      <ComingOnline />
    </section>
  );
}
