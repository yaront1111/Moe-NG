import type { JSX, KeyboardEvent } from "react";

import { TruthChip } from "../components/truth-chip.js";
import { ARROW_RIGHT, TIMES } from "../glyphs.js";
import { sayWho } from "../truth-class.js";
import type { ProofPayload } from "./proof-context.js";

/**
 * The right-side proof inspector drawer. Closed, it renders nothing. Open with no
 * claim focused, it states the contract: "Nothing on this surface is shown
 * without its class." Open on a claim, it shows the class, the value, whatever
 * receipt rows the caller supplied, and a note.
 *
 * It fabricates nothing: the receipt table renders exactly the rows a chip handed
 * it, and shows none when a claim arrives without them. The note is UI-authored
 * context about the class, never a stand-in for a missing measurement.
 */

const EMPTY_COPY = "Select any truth chip to read the receipt, decision, report, "
  + "or finding behind that claim. Nothing on this surface is shown without its class.";

export interface ProofInspectorProps {
  readonly open: boolean;
  readonly payload: ProofPayload | null;
  readonly onClose: () => void;
  readonly onOpenReceipt?: ((payload: ProofPayload) => void) | undefined;
}

function noteFor(payload: ProofPayload): string {
  if (payload.note !== undefined && payload.note !== "") return payload.note;
  const shown = sayWho(payload.truthClass);
  if (shown.truthClass === "UNKNOWN") {
    return "No class was supplied with this value. UNKNOWN gains no authority and "
      + "is never rendered as a zero or a success.";
  }
  return "The class travels with the value: a withdrawn value cannot keep the "
    + "class its previous payload carried.";
}

export function ProofInspector({
  open,
  payload,
  onClose,
  onOpenReceipt,
}: ProofInspectorProps): JSX.Element | null {
  if (!open) return null;
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  const shown = payload === null ? null : sayWho(payload.truthClass);
  return (
    <aside
      aria-label="Proof inspector"
      className="cr2-proof"
      data-testid="cr.shell.inspector"
      onKeyDown={handleKeyDown}
    >
      <div className="cr2-proof-head">
        <span className="cr2-proof-kicker">PROOF INSPECTOR</span>
        <button
          aria-label="Close inspector"
          className="cr2-proof-close"
          data-testid="cr.shell.inspector.close"
          onClick={onClose}
          type="button"
        >
          <span aria-hidden="true">{TIMES}</span>
        </button>
      </div>
      <div className="cr2-proof-divider" />

      {payload === null || shown === null ? (
        <p className="cr2-proof-empty" data-testid="cr.shell.inspector.empty">{EMPTY_COPY}</p>
      ) : (
        <div className="cr2-proof-body" data-testid="cr.shell.inspector.claim">
          <div className="cr2-proof-claim">
            <span className="cr2-proof-factid">{payload.factId}</span>
            <div className="cr2-proof-label">{payload.label}</div>
            <div className="cr2-proof-value">
              <TruthChip interactive={false} truthClass={payload.truthClass} />
              <span>{payload.value}</span>
            </div>
          </div>

          {payload.rows === undefined || payload.rows.length === 0 ? null : (
            <div className="cr2-proof-rows">
              {payload.rows.map((row) => (
                <div className="cr2-proof-row" key={row.k}>
                  <span className="cr2-proof-row-k">{row.k}</span>
                  <span className="cr2-proof-row-v">{row.v}</span>
                </div>
              ))}
            </div>
          )}

          <p className="cr2-proof-note">{noteFor(payload)}</p>

          <button
            className="cr2-proof-open"
            data-testid="cr.shell.inspector.open"
            onClick={() => onOpenReceipt?.(payload)}
            title="Opens the ledger entry in the evidence inspector (a later surface)."
            type="button"
          >
            {`Open ${shown.receiptLink} ${ARROW_RIGHT}`}
          </button>
        </div>
      )}
    </aside>
  );
}
