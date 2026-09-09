import type { JSX } from "react";
import type { RepositoryReservationView } from "../../live/live-repository-reservation.js";

const PHASE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  AWAITING_LANDING: "Waiting to land the verified work",
  BLOCKED: "Held for reconciliation",
  EXECUTING: "Executing the work",
  LANDING: "Landing the verified work",
  RESERVED: "Preparing the work",
  VERIFYING: "Verifying the work",
});

export function RepositoryReservationCard({ reservation }: {
  readonly reservation: RepositoryReservationView;
}): JSX.Element {
  return (
    <section className="cr2-ops-card" data-testid="cr.health.reservation">
      <h3 className="cr2-approve-heading">Repository ownership</h3>
      {reservation.status === "HELD" ? (
        <>
          <p className="cr2-needs-detail">{`Repository held by ${reservation.owner.nodeRef} in project ${reservation.owner.projectId}.`}</p>
          <p className="cr2-needs-note">{Object.hasOwn(PHASE_WORDS, reservation.phase) ? PHASE_WORDS[reservation.phase] : reservation.phase}</p>
          <p className="cr2-needs-note">Other nodes wait until this work is landed. A stopped agent or expired claim does not release the repository.</p>
        </>
      ) : reservation.status === "IDLE" ? (
        <p className="cr2-needs-note">No repository reservation is held.</p>
      ) : (
        <>
          <p className="cr2-needs-detail">Repository ownership is unknown. The daemon could not establish whether this repository is held.</p>
          <p className="cr2-approve-mono">{reservation.code}</p>
        </>
      )}
    </section>
  );
}
