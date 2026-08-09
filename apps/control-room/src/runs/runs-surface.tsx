import type { JSX } from "react";

import { SuppliedActions } from "../goals/supplied-actions.js";
import { FactRow, readIdentity } from "../nodes/node-authority.js";
import { useGating } from "../shell/frame.js";
import { RUNS_EMPTY_COPY, RUN_FACTS } from "./runs-contract.js";
import type { RunLeaseProjection, RunsSurfaceProps } from "./runs-contract.js";

/**
 * Runs/leases (spec section 4.11, section 5, section 8.2, section 11.3).
 *
 * The rule this surface exists to obey: it renders lease state, it never decides it. A
 * long `activitySilence` on an ACTIVE lease is a normal build, and CR-J5-001 asserts the
 * absence of any warning or revoke affordance in exactly that case. So there is no
 * comparison, no threshold and no clock anywhere below — `isSuspect` reads the supplied
 * value and nothing else.
 *
 * There is also no revoke modal here on purpose. Spec 8.2 routes post-grace escalation to
 * a REVOCATION_CONFIRMATION decision in the Approvals inbox, which
 * approvals/approval-detail-confirmation.tsx already owns. This surface renders the
 * affordance the daemon returned; the decision happens there.
 */
const SUSPECT_STATE = "SUSPECT";
const SKELETON_ROWS = 3;

/** Reads the supplied state. Deliberately not a predicate over silence or expiry. */
function isSuspect(run: RunLeaseProjection): boolean {
  return run.leaseState?.value === SUSPECT_STATE;
}

function RunRow(props: {
  readonly onProvenance?: RunsSurfaceProps["onProvenance"];
  readonly run: RunLeaseProjection;
  readonly stale: boolean;
}): JSX.Element {
  const { onProvenance, run, stale } = props;
  const identity = readIdentity(run.sessionId);
  const suspect = isSuspect(run);
  return (
    <li
      data-stale={stale ? "true" : undefined}
      data-testid={`cr.runs.row.${identity}`}
      tabIndex={-1}
    >
      {/*
        Stamped from the supplied state alone. Nothing about the silence datums or the
        expiry reaches this decision.
      */}
      {suspect ? <span data-testid="cr.runs.suspect">SUSPECT</span> : null}
      {RUN_FACTS.map(([suffix, label, pick]) => (
        <FactRow
          fact={pick(run)}
          factId={suffix}
          key={suffix}
          label={label}
          onProvenance={onProvenance}
        />
      ))}
      {/*
        Rendered only when the daemon supplied the sentence. An absent sentence renders
        nothing rather than a client-assembled substitute.
      */}
      {suspect ? (
        <FactRow
          fact={run.suspectSentence}
          factId="run.suspectsentence"
          label="Policy"
          onProvenance={onProvenance}
        />
      ) : null}
      <SuppliedActions targetAggregateId={run.actionTargetId} testId={`cr.runs.actions.${identity}`} />
    </li>
  );
}

function Skeletons(): JSX.Element {
  return (
    <ul aria-busy="true" data-testid="cr.runs.loading">
      {Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
        <li data-testid="cr.runs.skeleton" key={`skeleton-${String(index)}`}>
          <span aria-hidden="true">…</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Grouped SUSPECT-first per the 4.11 wireframe. The partition reads the supplied state
 * for each row; it does not rank, score or compare rows against each other.
 */
function partition(
  rows: readonly RunLeaseProjection[],
): readonly (readonly [group: string, rows: readonly RunLeaseProjection[]])[] {
  return [
    ["suspect", rows.filter((run) => isSuspect(run))],
    ["active", rows.filter((run) => !isSuspect(run))],
  ];
}

export function RunsSurface(props: RunsSurfaceProps): JSX.Element {
  const { degraded, loading, onProvenance, rows } = props;
  const { stale } = useGating();
  // Degraded is the caller's fact; `stale` is the frame's. Either one flags the rows,
  // and neither is inferred from the payload's contents.
  const flagged = degraded === true || stale;
  return (
    <section aria-label="Runs and leases" data-testid="cr.runs">
      {flagged ? (
        <p data-testid="cr.runs.stalelabel" role="status">
          Rows may be stale.
        </p>
      ) : null}
      {loading === true ? <Skeletons /> : null}
      {loading !== true && rows.length === 0 ? (
        <p data-testid="cr.runs.empty">{RUNS_EMPTY_COPY}</p>
      ) : null}
      {partition(rows).map(([group, groupRows]) => (
        groupRows.length === 0 ? null : (
          <ul data-testid={`cr.runs.group.${group}`} key={group}>
            {groupRows.map((run) => (
              <RunRow
                key={run.sessionId}
                onProvenance={onProvenance}
                run={run}
                stale={flagged}
              />
            ))}
          </ul>
        )
      ))}
    </section>
  );
}
