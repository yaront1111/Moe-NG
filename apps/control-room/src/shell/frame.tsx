import { EMPTY_NEXT_ALLOWED_COMMANDS } from "@moe/contracts";
import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import "./shell-layout.css";
import { useShellKeyboardController } from "../a11y/keyboard-map.js";
import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import type { CircuitBreakerFact } from "./circuit-breaker-banner.js";
import { InspectorSheet } from "./inspector-sheet.js";
import { NavRail } from "./nav-rail.js";
import type { NavLabel } from "./nav-rail.js";
import { ProvenanceProvider } from "./provenance-panel.js";
import {
  ContextBar, GraphPlaceholder, HelpOverlay, StatusStrip, TimelinePlaceholder,
} from "./shell-chrome.js";
import type { ControlRoomTab } from "./shell-chrome.js";
import { useViewportMode } from "./viewport.js";

export { CONTROL_ROOM_NAV_ITEMS } from "./nav-rail.js";

/** Shell layout and the fail-closed boundary for daemon-supplied affordances. */
export interface GatingValue {
  readonly actionsEnabled: boolean;
  readonly commands: readonly NextAllowedCommand[];
  readonly stale: boolean;
}

/** Fail closed: a surface rendered outside a frame gets no authority at all. */
const GatingContext = createContext<GatingValue>({
  actionsEnabled: false,
  commands: EMPTY_NEXT_ALLOWED_COMMANDS,
  stale: false,
});

export function useGating(): GatingValue {
  return useContext(GatingContext);
}

/**
 * Test id for one allowed command. `approval.decide` carries the spec-pinned
 * `cr.action.approval-decide.approve` (§12 `CR-J1-001`); the rest are derived from
 * the command kind so a new kind cannot silently reuse another's id.
 */
export function actionTestId(command: NextAllowedCommand): string {
  const slug = command.commandKind.replace(/[._]/gu, "-");
  return command.commandKind === "approval.decide"
    ? `cr.action.${slug}.approve`
    : `cr.action.${slug}`;
}

const ACTION_LABELS: Partial<Record<RuntimeCommandKind, string>> = {
  "approval.decide": "Approve",
  "goal.close": "Close goal",
  "integration.accept_output": "Accept output",
};

function actionLabel(command: NextAllowedCommand): string {
  return ACTION_LABELS[command.commandKind] ?? command.commandKind;
}

/**
 * One control for one daemon-supplied command.
 *
 * A control exists only because a `NextAllowedCommand` exists, which is the testable
 * form of "every enabled action originates from `nextAllowedCommands`". It is enabled
 * only when the supplied snapshot says mutations are enabled — a disconnected view
 * keeps its controls visible and disabled rather than hiding them (§6.3).
 *
 * There is no disabled-reason text here on purpose. `NextAllowedCommand` carries no
 * reason field, so any explanation would be invented; §8.1 requires absence instead.
 * The control also dispatches nothing: this frame renders affordances, it never
 * constructs a command envelope.
 */
export function ActionButton({ command }: { readonly command: NextAllowedCommand }): JSX.Element {
  const { actionsEnabled } = useGating();
  const label = actionLabel(command);
  return (
    <button
      aria-label={`${label}: ${command.targetAggregateId}`}
      data-command-id={command.commandId}
      data-command-kind={command.commandKind}
      data-testid={actionTestId(command)}
      disabled={!actionsEnabled}
      type="button"
    >
      {label}
    </button>
  );
}

export interface ActionBarProps {
  readonly kind?: RuntimeCommandKind;
}

/** Renders the supplied commands, optionally narrowed to one kind for a surface. */
export function ActionBar({ kind }: ActionBarProps): JSX.Element {
  const { commands } = useGating();
  const shown = kind === undefined
    ? commands
    : commands.filter((command) => command.commandKind === kind);
  return (
    <div data-testid="cr.shell.actionbar">
      {shown.map((command) => (
        <ActionButton command={command} key={command.commandId} />
      ))}
    </div>
  );
}

export interface ShellFrameProps {
  readonly activeNavItem?: NavLabel | undefined;
  readonly affordance: FixtureAffordanceSnapshot;
  /** Absent means the daemon reported no circuit breaker; the banner then renders nothing. */
  readonly breaker?: CircuitBreakerFact | undefined;
  readonly children?: ReactNode;
  readonly contextEyebrow?: string | undefined;
  readonly contextTitle?: string | undefined;
  readonly inspector?: ReactNode;
  readonly navigationUnavailableReason?: string | undefined;
  readonly onNavigate?: ((label: NavLabel) => void) | undefined;
  readonly projectionEnabled?: boolean | undefined;
  readonly timeline?: ReactNode;
}

export function ShellFrame(
  {
    activeNavItem = "Goals", affordance, breaker, children,
    contextEyebrow = "Active goal", contextTitle = "Moe control room", inspector,
    navigationUnavailableReason, onNavigate, projectionEnabled = true, timeline,
  }: ShellFrameProps,
): JSX.Element {
  const [tab, setTab] = useState<ControlRoomTab>("board");
  const viewport = useViewportMode();
  const narrow = viewport.ok && viewport.mode === "NARROW";
  const previousNarrow = useRef(narrow);
  const focusWasInInspector = useRef(false);
  const enteringNarrow = narrow && !previousNarrow.current;
  const keyboard = useShellKeyboardController(setTab, !narrow);
  useLayoutEffect(() => {
    if (enteringNarrow) {
      keyboard.collapseInspector();
      if (focusWasInInspector.current) {
        keyboard.rootRef.current
          ?.querySelector<HTMLElement>("[data-testid='cr.shell.inspector.toggle']")
          ?.focus();
      }
    }
    previousNarrow.current = narrow;
  }, [enteringNarrow, keyboard.collapseInspector, narrow]);
  const gating = useMemo<GatingValue>(
    () => ({
      actionsEnabled: affordance.mutationsEnabled,
      commands: affordance.nextAllowedCommands,
      stale: affordance.connection !== "CONNECTED" || affordance.requiresAffordanceRefresh,
    }),
    [affordance],
  );
  const inspectorExpanded = keyboard.inspectorExpanded && !enteringNarrow;
  const inspectorVisible = inspectorExpanded && !keyboard.helpOpen;
  const projection = !projectionEnabled
    ? children
    : tab === "graph"
      ? <GraphPlaceholder />
      : tab === "timeline"
        ? (timeline ?? <TimelinePlaceholder />)
        : children;
  return (
    <GatingContext.Provider value={gating}>
      <ProvenanceProvider>
        <div data-banner={affordance.statusLabel !== "" || breaker !== undefined ? "true" : undefined}
          data-inspector={inspectorExpanded ? "open" : "closed"}
          data-narrow={narrow ? "true" : undefined} data-testid="cr.shell.root"
          onFocusCapture={(event) => {
            const sheet = keyboard.rootRef.current?.querySelector("#cr-shell-inspector");
            focusWasInInspector.current = sheet?.contains(event.target) ?? false;
          }}
          data-theme="ledger"
          ref={keyboard.rootRef}>
          <a
            data-testid="cr.shell.skiplink"
            href="#cr-shell-main"
            onClick={(event) => { event.preventDefault(); keyboard.focusMain(); }}
            style={{ outline: "2px solid currentColor", outlineOffset: "2px" }}
          >
            Skip to main content
          </a>
          <NavRail activeItem={activeNavItem} narrow={narrow} onNavigate={onNavigate}
            unavailableReason={navigationUnavailableReason} />
          <ContextBar affordance={affordance} breaker={breaker} eyebrow={contextEyebrow}
            inspectorExpanded={inspectorVisible} narrow={narrow}
            onInspectorToggle={keyboard.toggleInspector} onTab={setTab}
            projectionEnabled={projectionEnabled} tab={tab} title={contextTitle} />
          <HelpOverlay onClose={keyboard.closeHelp} open={keyboard.helpOpen} />
          <main data-testid="cr.shell.main" id="cr-shell-main" ref={keyboard.mainRef} tabIndex={-1}>
            {projection}
          </main>
          <InspectorSheet expanded={inspectorExpanded} narrow={narrow}
            obscured={keyboard.helpOpen}
            onDismiss={keyboard.collapseInspector}>
            {inspector}
          </InspectorSheet>
          <StatusStrip affordance={affordance} stale={gating.stale} />
        </div>
      </ProvenanceProvider>
    </GatingContext.Provider>
  );
}
