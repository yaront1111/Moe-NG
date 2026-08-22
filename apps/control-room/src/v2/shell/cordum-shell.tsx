import { useCallback, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";

import "../styles/cordum-tokens.css";
import "../styles/cordum-shell.css";
import { CONTROL_ROOM_KEYBOARD_MAP, useShellKeyboardController } from "../../a11y/keyboard-map.js";
import type { KeyboardAction } from "../../a11y/keyboard-map.js";
import { useClock } from "../../performance/command-latency.js";
import { MIDDOT } from "../glyphs.js";
import { ContextBar } from "./context-bar.js";
import { NavRail } from "./nav-rail.js";
import type { NavBadge } from "./nav-rail.js";
import { ProofInspector } from "./proof-inspector.js";
import { ProofProvider } from "./proof-context.js";
import type { ProofController, ProofPayload } from "./proof-context.js";
import { ConnectionBanner, StatusStrip } from "./status-strip.js";
import { describeConnection } from "./shell-model.js";
import type { CardTreatment, ConnectionState, NavId, NavItem } from "./shell-model.js";

/**
 * The Cordum shell frame: nav rail, context bar, connection banner, an empty main
 * slot for the next slice to fill, the proof inspector drawer, and the status
 * strip - wired to the kept ClockProvider (via useClock) and keyboard map (via
 * useShellKeyboardController).
 *
 * Connection is honest: a live build with no feed wired yet passes `null`, which
 * the strip renders as "coming online" rather than a fabricated CONNECTED. In
 * fixtures mode the SIMULATE control cycles the four real relay states.
 */

const DEFAULT_EYEBROW = `PROJECT ${MIDDOT} MOE-NG`;

export interface CordumShellProps {
  /** The main content slot. */
  readonly children?: ReactNode;
  readonly eyebrow?: string;
  readonly title?: string;
  readonly navItems?: readonly NavItem[];
  readonly activeNav?: NavId;
  readonly navBadges?: Partial<Record<NavId, NavBadge>> | undefined;
  readonly onNavigate?: ((id: NavId) => void) | undefined;
  /** When present, the context bar shows a "<- <backLabel>" breadcrumb link. */
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
  /** `null` (default) means the daemon feed is not attached yet. */
  readonly initialConnection?: ConnectionState | null;
  /** Fixtures mode: show the SIMULATE relay control. */
  readonly simulatable?: boolean;
  readonly initialTreatment?: CardTreatment;
  readonly initialProofOpen?: boolean;
}

const HELP_LABELS: Readonly<Record<KeyboardAction, string>> = Object.freeze({
  goals: "Go to Goals",
  board: "Board projection",
  graph: "Graph projection",
  timeline: "Timeline projection",
  approvals: "Go to Approvals",
  search: "Focus search",
  help: "Toggle this help",
  "collapse-inspector": "Collapse proof inspector",
  "expand-inspector": "Expand proof inspector",
});

function HelpOverlay({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): JSX.Element | null {
  if (!open) return null;
  return (
    <div
      aria-label="Keyboard shortcuts"
      aria-modal="true"
      className="cr2-help"
      data-testid="cr.shell.help"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
      role="dialog"
    >
      <div className="cr2-help-card">
        <div className="cr2-help-head">
          <span className="cr2-help-kicker">KEYBOARD</span>
          <button autoFocus className="cr2-help-close" onClick={onClose} type="button">Close</button>
        </div>
        <ul className="cr2-help-list">
          {CONTROL_ROOM_KEYBOARD_MAP.map((binding) => (
            <li className="cr2-help-row" key={binding.action}>
              <kbd className="cr2-help-keys">{binding.sequence.join(" ")}</kbd>
              <span>{HELP_LABELS[binding.action]}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function CordumShell({
  children,
  eyebrow = DEFAULT_EYEBROW,
  title = "Goals",
  navItems,
  activeNav = "goals",
  navBadges,
  onNavigate,
  onBack,
  backLabel,
  initialConnection = null,
  simulatable = false,
  initialTreatment = "Compact",
  initialProofOpen = false,
}: CordumShellProps): JSX.Element {
  const clock = useClock();
  const clockPresent = clock !== null;
  const [connection, setConnection] = useState<ConnectionState | null>(initialConnection);
  const [treatment, setTreatment] = useState<CardTreatment>(initialTreatment);
  const [proof, setProof] = useState<ProofPayload | null>(null);
  // The projection chords (g b / g r / g t) update inert tab state until a board
  // slice renders the projections; the wiring is real, the destination is not yet.
  const [, setActiveTab] = useState<"board" | "graph" | "timeline">("board");

  const keyboard = useShellKeyboardController(setActiveTab, initialProofOpen);
  const proofOpen = keyboard.inspectorExpanded && !keyboard.helpOpen;
  const { toggleInspector, inspectorExpanded } = keyboard;

  const controller = useMemo<ProofController>(() => ({
    openProof: (payload) => {
      setProof(payload);
      if (!inspectorExpanded) toggleInspector();
    },
  }), [inspectorExpanded, toggleInspector]);

  const descriptor = describeConnection(connection);
  const handleSimulate = useCallback((next: ConnectionState) => { setConnection(next); }, []);

  return (
    <ProofProvider controller={controller}>
      <div
        className="cr2-shell"
        data-connection={descriptor.key}
        data-inspector={proofOpen ? "open" : "closed"}
        data-testid="cr2.shell.root"
        data-treatment={treatment}
        ref={keyboard.rootRef}
      >
        <a
          className="cr2-skip"
          href="#cr2-main"
          onClick={(event) => { event.preventDefault(); keyboard.focusMain(); }}
        >
          Skip to main content
        </a>

        <NavRail
          activeId={activeNav}
          badges={navBadges}
          items={navItems}
          onNavigate={onNavigate}
        />

        <div className="cr2-panel">
          <ContextBar
            backLabel={backLabel}
            eyebrow={eyebrow}
            onBack={onBack}
            onToggleProof={keyboard.toggleInspector}
            onTreatment={setTreatment}
            proofOpen={proofOpen}
            title={title}
            treatment={treatment}
          />
          <div className="cr2-bannerslot">
            <ConnectionBanner state={connection} />
          </div>
          <div className="cr2-stage">
            <main className="cr2-main" data-testid="cr.shell.main" id="cr2-main" ref={keyboard.mainRef} tabIndex={-1}>
              {children}
            </main>
            <ProofInspector onClose={keyboard.collapseInspector} open={proofOpen} payload={proof} />
          </div>
          <StatusStrip
            clockPresent={clockPresent}
            descriptor={descriptor}
            onSimulate={handleSimulate}
            simulatable={simulatable}
          />
        </div>

        <HelpOverlay onClose={keyboard.closeHelp} open={keyboard.helpOpen} />
      </div>
    </ProofProvider>
  );
}
