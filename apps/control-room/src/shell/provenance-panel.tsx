import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";

import type { FixtureFact, FixtureProvenance } from "../fixtures.js";
import { Fact } from "../kernel.js";

/**
 * Provenance drill-down for the shell.
 *
 * The panel renders the shell-local development-only provenance shape and nothing
 * else: it reads a fixture record and displays it. It resolves no reference, follows
 * no link, and asks the daemon for nothing, so an open popover cannot become a second
 * source of truth for a fact the chip already classified.
 */
interface ProvenanceControl {
  readonly open: (provenance: FixtureProvenance) => void;
}

const ProvenanceContext = createContext<ProvenanceControl>({ open: () => undefined });

/** The key that opens provenance on a focused chip (spec §11.2). */
export const PROVENANCE_SHORTCUT_KEY = "p";

function Row({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div data-testid={`cr.provenance.row.${label.toLowerCase().replace(/\s+/gu, "-")}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Typed link wording per §3.2: the link kind names what the evidence actually is. */
const LINK_TITLES: Record<FixtureProvenance["linkKind"], string> = {
  decision: "Decision record",
  finding: "Integrity finding",
  receipt: "Runner receipt",
  report: "Originating report event",
};

interface ProvenancePanelProps {
  readonly onClose: () => void;
  readonly provenance: FixtureProvenance;
}

/**
 * The popover itself. It takes focus on open so the keyboard dismissal has a target,
 * and the caller restores focus to the chip that opened it.
 *
 * Note the test id is `cr.chip.provenance` (§3.2). It is deliberately rendered at
 * shell level rather than inside a fact wrapper, so the "every `cr.fact.*` has a
 * `cr.chip.*` descendant" audit keeps counting chips exactly.
 */
export function ProvenancePanel({ onClose, provenance }: ProvenancePanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  const dismiss = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };
  const epoch = provenance.leaseEpoch === null
    ? "not a leased mutation"
    : String(provenance.leaseEpoch);
  return (
    <div
      aria-label="Provenance"
      data-testid="cr.chip.provenance"
      onKeyDown={dismiss}
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
    >
      <dl>
        <Row label="Event" value={`#${String(provenance.eventSequence)} ${provenance.eventId}`} />
        <Row label="Actor" value={provenance.actor} />
        <Row label="Session" value={provenance.sessionId} />
        <Row label="Lease epoch" value={epoch} />
        <Row label="Timestamp" value={provenance.timestamp} />
        <Row label={LINK_TITLES[provenance.linkKind]} value={provenance.linkRef} />
      </dl>
      <a data-testid="cr.timeline.jump" href={`#timeline/${provenance.eventId}`}>
        Open in timeline
      </a>
      <button data-testid="cr.provenance.close" onClick={onClose} type="button">
        Close
      </button>
    </div>
  );
}

/**
 * Owns which provenance record is open, and the focus that must come back.
 *
 * The element that was focused when the popover opened is captured before the panel
 * mounts, so dismissal returns the keyboard to the chip rather than to the top of the
 * document — the difference between a usable drill-down and a keyboard trap.
 */
export function ProvenanceProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [shown, setShown] = useState<FixtureProvenance | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const open = useCallback((provenance: FixtureProvenance): void => {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement ? active : null;
    setShown(provenance);
  }, []);
  const close = useCallback((): void => {
    setShown(null);
    restoreRef.current?.focus();
  }, []);
  const control = useMemo<ProvenanceControl>(() => ({ open }), [open]);
  return (
    <ProvenanceContext.Provider value={control}>
      {children}
      {shown === null ? null : <ProvenancePanel onClose={close} provenance={shown} />}
    </ProvenanceContext.Provider>
  );
}

/**
 * The only fact renderer the J1 surfaces use.
 *
 * The claim itself goes through the kernel's `Fact`, so the truth chip is a structural
 * child and a displayed fact cannot lose its class. This wrapper adds exactly one
 * thing: the provenance affordance, by click/Enter on the chip (the kernel's own
 * callback) and by the `p` shortcut, which arrives here by bubbling from the focused
 * chip. No truth logic is reimplemented.
 */
export function FactWithProvenance({ fact }: { readonly fact: FixtureFact }): JSX.Element {
  const { open } = useContext(ProvenanceContext);
  const shortcut = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== PROVENANCE_SHORTCUT_KEY) return;
    // Only when a chip itself holds focus. Without this the shortcut would swallow
    // a literal "p" typed into any field a later surface renders inside a fact slot.
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-testid^='cr.chip.']") === null) return;
    event.preventDefault();
    open(fact.provenance);
  };
  return (
    <div data-testid={`cr.factslot.${fact.factId}`} onKeyDown={shortcut}>
      <Fact
        factId={fact.factId}
        label={fact.label}
        onProvenance={() => {
          open(fact.provenance);
        }}
        truthClass={fact.truthClass}
        value={fact.value}
      />
    </div>
  );
}
