import { EMPTY_NEXT_ALLOWED_COMMANDS } from "@moe/contracts";
import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";
import { createContext, useContext, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";

import type { FixtureAffordanceSnapshot } from "../fixtures.js";
import { ProvenanceProvider } from "./provenance-panel.js";

/**
 * The control-room shell frame: nav rail, context bar, main outlet, inspector, and
 * status strip (spec line 51). Surfaces are mounted into the outlet by the caller;
 * the board is a surface, not part of the frame.
 *
 * The frame is also where affordance state stops. It publishes what the daemon
 * supplied and never recomputes it, so no surface below can talk itself into an
 * action the daemon did not return.
 */
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

/** Nav rail, top to bottom (spec line 58). Timeline and graph are not rail items. */
export const CONTROL_ROOM_NAV_ITEMS = [
  "Goals", "Approvals", "Runs & leases", "Resources", "Health", "Policy",
] as const;

/** Projection tabs on the context bar (spec line 51). */
export const CONTROL_ROOM_TABS = ["board", "graph", "timeline"] as const;
export type ControlRoomTab = (typeof CONTROL_ROOM_TABS)[number];

function NavRail(): JSX.Element {
  return (
    <nav aria-label="Primary" data-testid="cr.shell.navrail">
      {CONTROL_ROOM_NAV_ITEMS.map((item) => (
        <button data-testid={`cr.nav.${item.split(" ")[0]?.toLowerCase() ?? item}`} key={item}
          type="button">
          {item}
        </button>
      ))}
    </nav>
  );
}

function Banners({ affordance }: { readonly affordance: FixtureAffordanceSnapshot }): JSX.Element {
  const disconnected = affordance.connection === "DISCONNECTED";
  if (disconnected) {
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

/**
 * The graph projection is reachable as a tab but mounts nothing in this slice.
 *
 * `CR-J1-002` requires that `cr.graph.*` is never mounted during J1, so selecting the
 * tab renders this placeholder instead of a canvas. The placeholder deliberately
 * carries no `cr.graph.` prefix — a stub with that id would satisfy the eye and fail
 * the bar.
 */
function GraphPlaceholder(): JSX.Element {
  return (
    <p data-testid="cr.shell.graphplaceholder">
      The graph projection is not part of this slice. Everything in J1 is completable
      from the board and the inbox.
    </p>
  );
}

export interface ShellFrameProps {
  readonly affordance: FixtureAffordanceSnapshot;
  readonly children?: ReactNode;
  readonly inspector?: ReactNode;
}

export function ShellFrame({ affordance, children, inspector }: ShellFrameProps): JSX.Element {
  const [tab, setTab] = useState<ControlRoomTab>("board");
  const gating = useMemo<GatingValue>(
    () => ({
      actionsEnabled: affordance.mutationsEnabled,
      commands: affordance.nextAllowedCommands,
      stale: affordance.connection === "LAGGING"
        || affordance.connection === "HISTORICAL"
        || affordance.requiresAffordanceRefresh,
    }),
    [affordance],
  );
  return (
    <GatingContext.Provider value={gating}>
      <ProvenanceProvider>
        <div data-testid="cr.shell.root">
          <NavRail />
          <div data-testid="cr.shell.contextbar">
            {CONTROL_ROOM_TABS.map((name) => (
              <button
                aria-pressed={tab === name}
                data-testid={`cr.shell.tab.${name}`}
                key={name}
                onClick={() => {
                  setTab(name);
                }}
                type="button"
              >
                {name}
              </button>
            ))}
            <Banners affordance={affordance} />
          </div>
          <main data-testid="cr.shell.main">
            {tab === "graph" ? <GraphPlaceholder /> : children}
          </main>
          <aside aria-label="Inspector" data-testid="cr.shell.inspector">
            {inspector}
          </aside>
          <footer
            data-connection={affordance.connection}
            data-stale={String(gating.stale)}
            data-testid="cr.shell.statusstrip"
          >
            <span data-testid="cr.shell.cursor">{affordance.connection}</span>
            {gating.stale ? <span data-testid="cr.shell.stalelabel">Showing stale data</span> : null}
          </footer>
        </div>
      </ProvenanceProvider>
    </GatingContext.Provider>
  );
}
