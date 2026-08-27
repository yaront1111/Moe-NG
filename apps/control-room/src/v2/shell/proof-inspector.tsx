import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";

import "../styles/cordum-proof.css";
import { StatusChip } from "../components/primitives.js";
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
 * context about the class, never a stand-in for a missing measurement. And it
 * offers nothing it cannot do - with no `onOpenReceipt` wired, the tail of the
 * claim is a sentence saying so, not a button that swallows the click.
 *
 * Reaching it without a mouse: focus enters on the heading when it opens, Escape
 * closes it from anywhere on the page, focus goes back to whatever opened it, and
 * once it is narrow enough to cover the main column it carries the
 * `[role='dialog'][aria-modal='true']` contract a11y/keyboard-map.ts already
 * special-cases by this component's testid - and backs it: while it is that
 * dialog, Tab and Shift+Tab cycle between its own controls instead of walking
 * into the column under the scrim, the way src/shell/inspector-sheet.tsx does.
 */

const EMPTY_COPY = "Select any truth chip to read the receipt, decision, report, "
  + "or finding behind that claim. Nothing on this surface is shown without its class.";

/** What Tab can land on inside the drawer; the heading's `tabIndex={-1}` is not in it. */
const FOCUSABLE = [
  "a[href]", "button:not(:disabled)", "input:not(:disabled)", "select:not(:disabled)",
  "textarea:not(:disabled)", "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * The width below which the drawer stops sitting beside the main column and
 * starts covering it. Kept in lockstep with the same query in cordum-proof.css.
 */
const OVERLAY_QUERY = "(max-width: 980px)";

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

/**
 * True only while the drawer covers the main column. A server render has no
 * window, and jsdom implements neither `matchMedia` nor media evaluation; both
 * are read as "wide", which is the honest default - no dialog semantics are
 * claimed for a drawer that is not in fact covering anything.
 */
function useOverlayViewport(): boolean {
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia(OVERLAY_QUERY);
    setOverlay(query.matches);
    if (typeof query.addEventListener !== "function") return undefined;
    const onChange = (event: MediaQueryListEvent): void => { setOverlay(event.matches); };
    query.addEventListener("change", onChange);
    return () => { query.removeEventListener("change", onChange); };
  }, []);
  return overlay;
}

interface ProofPanelProps {
  readonly payload: ProofPayload | null;
  readonly onClose: () => void;
  readonly onOpenReceipt?: ((payload: ProofPayload) => void) | undefined;
}

/** The mounted drawer. Split out so the open/closed gate stays above the hooks. */
function ProofPanel({ payload, onClose, onOpenReceipt }: ProofPanelProps): JSX.Element {
  const asideRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);
  const overlay = useOverlayViewport();

  useEffect(() => {
    // Captured once. StrictMode replays this effect, and a per-run capture would
    // record the drawer's own heading as the thing to go back to.
    const active = document.activeElement;
    if (openerRef.current === null && active !== titleRef.current && active !== document.body) {
      openerRef.current = active;
    }
    titleRef.current?.focus();
    return () => {
      // Opening the keyboard-help dialog unmounts this drawer and takes focus
      // itself; stealing it back would strand the help card. Only restore when
      // focus fell to the body, which is what the browser does to a focused
      // element inside a subtree it has just removed.
      const nowActive = document.activeElement;
      if (nowActive !== null && nowActive !== document.body) return;
      const opener = openerRef.current;
      const target = opener instanceof HTMLElement && opener.isConnected
        ? opener
        : document.getElementById("cr2-main");
      target?.focus();
    };
  }, []);

  useEffect(() => {
    // On the document, not the <aside>: the owner's focus is almost never inside
    // the drawer when they want it gone. Bubble phase, so anything nested that
    // owns this Escape - a dialog portalled over the drawer - handles it first
    // and marks it; a global listener that ignored that would close the wrong
    // thing.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, [onClose]);

  // Only while the drawer is the modal sheet. Beside main it is a plain
  // complementary region and the tab sequence runs on to the status strip.
  const trapTab = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!overlay || event.key !== "Tab" || event.defaultPrevented) return;
    const controls = [...(asideRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    // -1 is the heading, where focus lands on open: Shift+Tab from it wraps to
    // the last control, Tab from it goes to the first.
    const at = controls.findIndex((control) => control === document.activeElement);
    const wraps = event.shiftKey ? at <= 0 : at === -1 || at === controls.length - 1;
    if (!wraps) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };

  const shown = payload === null ? null : sayWho(payload.truthClass);
  return (
    <>
      {!overlay ? null : (
        // Out of the a11y tree on purpose: the dialog's own Close button is the
        // accessible way out, and a second control carrying that same name would
        // just be noise to read past. Same shape as the v1 backdrop.
        <div
          aria-hidden="true"
          className="cr2-proof-scrim"
          data-testid="cr.shell.inspector.scrim"
          onClick={onClose}
        />
      )}
      <aside
        // Named by aria-label, not by the heading: the visible kicker is the
        // all-caps literal below, which some readers spell out letter by letter.
        aria-label="Proof inspector"
        aria-modal={overlay ? true : undefined}
        className="cr2-proof"
        data-testid="cr.shell.inspector"
        onKeyDown={trapTab}
        ref={asideRef}
        role={overlay ? "dialog" : undefined}
      >
        <div className="cr2-proof-head">
          <h2
            className="cr2-proof-kicker"
            data-testid="cr.shell.inspector.title"
            ref={titleRef}
            tabIndex={-1}
          >
            PROOF INSPECTOR
          </h2>
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

        <div aria-live="polite" className="cr2-proof-live" data-testid="cr.shell.inspector.live">
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

              {onOpenReceipt === undefined ? (
                <p className="cr2-proof-soon" data-testid="cr.shell.inspector.open">
                  <StatusChip label="SOON" testId="cr.shell.inspector.open.badge" />
                  <span>
                    {`Opening the full ${shown.receiptLink} needs an evidence surface `
                      + `this build does not have yet. The class and the value above are `
                      + `everything that was supplied for this claim.`}
                  </span>
                </p>
              ) : (
                <button
                  className="cr2-proof-open"
                  data-testid="cr.shell.inspector.open"
                  onClick={() => { onOpenReceipt(payload); }}
                  type="button"
                >
                  {`Open ${shown.receiptLink} ${ARROW_RIGHT}`}
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

export function ProofInspector({
  open,
  payload,
  onClose,
  onOpenReceipt,
}: ProofInspectorProps): JSX.Element | null {
  if (!open) return null;
  return <ProofPanel onClose={onClose} onOpenReceipt={onOpenReceipt} payload={payload} />;
}
