import { useEffect, useRef } from "react";
import type { JSX, KeyboardEvent, MouseEvent } from "react";

import { CONTROL_ROOM_KEYBOARD_MAP } from "../a11y/keyboard-map.js";
import type { KeyboardAction } from "../a11y/keyboard-map.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { CONTROL_ROOM_NAV_ITEMS } from "./nav-rail.js";
import { CircuitBreakerBanner } from "./circuit-breaker-banner.js";
import type { CircuitBreakerFact } from "./circuit-breaker-banner.js";

/** Projection tabs belong to a goal context; rail destinations can suppress them. */
export const CONTROL_ROOM_TABS = ["board", "graph", "timeline"] as const;
export type ControlRoomTab = (typeof CONTROL_ROOM_TABS)[number];

function Banners({ affordance }: { readonly affordance: FixtureAffordanceSnapshot }): JSX.Element {
  if (affordance.connection === "DISCONNECTED") {
    return (
      <div data-testid="cr.banner.disconnected" role="status">
        {affordance.statusLabel}
      </div>
    );
  }
  if (affordance.statusLabel === "") return <></>;
  return (
    <div data-testid="cr.banner.lag" role="status">
      {affordance.statusLabel}
    </div>
  );
}

export interface ContextBarProps {
  readonly affordance: FixtureAffordanceSnapshot;
  readonly breaker?: CircuitBreakerFact | undefined;
  readonly eyebrow: string;
  readonly inspectorExpanded: boolean;
  readonly narrow: boolean;
  readonly onInspectorToggle: () => void;
  readonly onTab: (tab: ControlRoomTab) => void;
  readonly projectionEnabled: boolean;
  readonly tab: ControlRoomTab;
  readonly title: string;
}

export function ContextBar(props: ContextBarProps): JSX.Element {
  const {
    affordance, breaker, eyebrow, inspectorExpanded, narrow, onInspectorToggle,
    onTab, projectionEnabled, tab, title,
  } = props;
  return (
    <header data-testid="cr.shell.contextbar">
      <div className="cr-shell-context-identity">
        <span className="cr-shell-context-eyebrow">{eyebrow}</span>
        <strong data-testid="cr.shell.context.title">{title}</strong>
      </div>
      <div className="cr-shell-context-actions">
        {projectionEnabled ? (
          <div aria-label="Goal projection" className="cr-shell-tabs" role="group">
            {CONTROL_ROOM_TABS.map((name) => (
              <button
                aria-pressed={tab === name}
                data-testid={`cr.shell.tab.${name}`}
                key={name}
                onClick={() => { onTab(name); }}
                type="button"
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}
        <button
          aria-controls="cr-shell-inspector"
          aria-expanded={inspectorExpanded}
          aria-label={inspectorExpanded ? "Close inspector" : "Open inspector"}
          className="cr-shell-inspector-toggle"
          data-narrow={narrow ? "true" : undefined}
          data-testid="cr.shell.inspector.toggle"
          onClick={onInspectorToggle}
          type="button"
        >
          <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
            <path d="M4 5.5h16v13H4z M15.5 5.5v13 M8 9h3 M8 12h3"
              stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
              strokeWidth="1.6" />
          </svg>
          <span className="cr-shell-inspector-toggle-label">Proof</span>
        </button>
      </div>
      <div className="cr-shell-banner-stack">
        <Banners affordance={affordance} />
        <CircuitBreakerBanner breaker={breaker} />
      </div>
    </header>
  );
}

const HELP_LABELS: Readonly<Record<KeyboardAction, string>> = Object.freeze({
  approvals: "Focus Approvals when navigation is available",
  board: "Show board in goal views",
  "collapse-inspector": "Close proof inspector",
  "expand-inspector": "Open proof inspector",
  goals: "Focus Goals when navigation is available",
  graph: "Show graph in goal views",
  help: "Open command map",
  search: "Focus search when present",
  timeline: "Show timeline in goal views",
});

export function HelpOverlay({ onClose, open }: {
  readonly onClose: () => void;
  readonly open: boolean;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  if (!open) return <></>;
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      closeRef.current?.focus();
    }
  };
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };
  return (
    <div className="cr-shell-modal-backdrop" onMouseDown={closeFromBackdrop}>
      <section aria-label="Keyboard shortcuts" aria-modal="true"
        data-testid="cr.shell.help" onKeyDown={handleKeyDown} role="dialog">
        <header>
          <span>Command map</span>
          <h2>Keyboard shortcuts</h2>
        </header>
        <p>Move through the control room without leaving the operational flow.</p>
        <div className="cr-shell-help-grid">
          <section aria-label="Keyboard commands">
            <h3>Commands</h3>
            <ul className="cr-shell-command-map">
              {CONTROL_ROOM_KEYBOARD_MAP.map((binding) => (
                <li data-testid={`cr.shell.help.binding.${binding.action}`} key={binding.action}>
                  <kbd data-testid="cr.shell.help.keys">{binding.sequence.join(" ")}</kbd>
                  <span data-testid="cr.shell.help.description">{HELP_LABELS[binding.action]}</span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Navigation destinations">
            <h3>Destinations</h3>
            <ul className="cr-shell-help-destinations">
              {CONTROL_ROOM_NAV_ITEMS.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </section>
        </div>
        <button onClick={onClose} ref={closeRef} type="button">Close keyboard help</button>
      </section>
    </div>
  );
}

/** J1 intentionally exposes no graph surface; this remains an honest empty projection. */
export function GraphPlaceholder(): JSX.Element {
  return (
    <section className="cr-projection-empty" data-testid="cr.shell.graphplaceholder">
      <span aria-hidden="true">◇</span>
      <p className="cr-projection-kicker">Graph on demand</p>
      <h2>This goal is already legible from the board.</h2>
      <p>The graph projection joins the workspace when topology adds information.</p>
    </section>
  );
}

export function TimelinePlaceholder(): JSX.Element {
  return (
    <section className="cr-projection-empty" data-testid="cr.shell.timelineplaceholder">
      <span aria-hidden="true">│</span>
      <p className="cr-projection-kicker">Causal ledger</p>
      <h2>No timeline projection is attached to this development fixture.</h2>
      <p>Receipt provenance remains available from every truth chip.</p>
    </section>
  );
}

export function StatusStrip({ affordance, stale }: {
  readonly affordance: FixtureAffordanceSnapshot;
  readonly stale: boolean;
}): JSX.Element {
  return (
    <footer
      data-connection={affordance.connection}
      data-stale={String(stale)}
      data-testid="cr.shell.statusstrip"
    >
      <span className="cr-shell-status-label">Event relay</span>
      <span aria-hidden="true" data-testid="cr.shell.eventspine" className="cr-event-spine">
        {Array.from({ length: 11 }, (_, index) => <i key={index} />)}
      </span>
      <span className="cr-shell-connection" data-testid="cr.shell.cursor">
        <i aria-hidden="true" />{affordance.connection}
      </span>
      {stale ? <span data-testid="cr.shell.stalelabel">Showing stale data</span> : null}
    </footer>
  );
}
