import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import "../styles/cordum-repository-effects.css";
import type { RecoveryActionView, RecoveryReservationView, RepositoryRecoveryOutcome } from "../../live/live-repository-recovery.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import { OutcomeNote } from "../components/outcome-note.js";
import { ActionButton } from "../components/primitives.js";
import type { RepositoryRecoveryPort } from "./repository-recovery-port.js";

interface Props {
  readonly outcome: RepositoryRecoveryOutcome | null;
  readonly port: RepositoryRecoveryPort | null;
  readonly onRecorded?: () => void;
}
function ReservationControls({ reservation, port, onRecorded }: {
  readonly reservation: RecoveryReservationView; readonly port: RepositoryRecoveryPort | null; readonly onRecorded: (() => void) | undefined;
}): JSX.Element {
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<OfferOutcome | null>(null);
  const sending = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async (action: RecoveryActionView): Promise<void> => {
    if (port === null || sending.current || reason.trim() === "") return;
    sending.current = true; setBusy(true); setReport(null);
    let result: OfferOutcome;
    try { result = await port.submit(reservation, action, reason); }
    catch { result = { ok: false, code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_RECOVERY" }; }
    if (!mounted.current) return;
    sending.current = false; setBusy(false); setReport(result);
    if (result.ok) onRecorded?.();
  };
  return <div data-testid={`cr.health.recovery.${reservation.nodeRef}`}>
    <p className="cr2-needs-detail">{reservation.nodeRef}</p>
    <p className="cr2-needs-note">{`Reservation revision ${reservation.expectedReservationRevision} · ${reservation.phase}`}</p>
    {reservation.actions.some((action) => action.available) && <label className="cr2-needs-note">
      {`Recovery reason for ${reservation.nodeRef}`}
      <textarea aria-label={`Recovery reason for ${reservation.nodeRef}`} value={reason} maxLength={1000}
        disabled={busy} onChange={(event) => setReason(event.target.value)} />
    </label>}
    {reservation.actions.map((action) => <div key={action.action}>
      {action.available ? <ActionButton variant="secondary" disabled={port === null || busy || reason.trim() === "" || report?.ok === true}
        onClick={() => { void submit(action); }}>
        {action.action === "ABORT_UNEXECUTED" ? "Release unused reservation" : "Reconcile completed landing"}
      </ActionButton> : <p className="cr2-approve-mono">{action.code}</p>}
    </div>)}
    {busy && <p role="status">Recording recovery decision…</p>}
    {report?.ok === true && <p role="status">Recovery decision recorded. Refreshing repository ownership.</p>}
    {report?.ok === false && <OutcomeNote code={report.code} layer={report.layer} said="Recovery was not confirmed. Refresh repository ownership to see its current state."
      testId={`cr.health.recovery.refusal.${reservation.nodeRef}`} />}
  </div>;
}

export function RepositoryRecoveryCard({ outcome, port, onRecorded }: Props): JSX.Element {
  return <section className="cr2-ops-card" data-testid="cr.health.recovery">
    <h3 className="cr2-approve-heading">Repository recovery</h3>
    <p className="cr2-needs-note">The daemon rechecks durable evidence before releasing ownership. Uncertain processes and Git effects remain held.</p>
    {outcome === null ? <p>Reading recovery options…</p> : outcome.status !== "RECOVERY"
      ? <OutcomeNote code={outcome.code} layer={outcome.layer} said="Recovery options could not be read." testId="cr.health.recovery.read-refusal" />
      : <>
        {outcome.view.code !== null && <p className="cr2-approve-mono">{outcome.view.code}</p>}
        {outcome.view.code === null && outcome.view.reservations.length === 0 && <p>No repository reservation needs recovery.</p>}
        {outcome.view.reservations.map((reservation) => <ReservationControls key={`${reservation.nodeRef}:${reservation.expectedReservationRevision}:${reservation.actions.map((entry) => entry.offer?.["expectedVersion"] ?? "none").join(":")}`}
          reservation={reservation} port={port} onRecorded={onRecorded} />)}
      </>}
  </section>;
}
