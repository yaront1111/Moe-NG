/**
 * The shell's pure data model: the connection states the status strip renders, the
 * nav destinations, and the board card treatments. Kept free of JSX so every arm
 * can be asserted by value.
 */

/* -------------------------------------------------------------- Connection ---- */

/** The four relay states the daemon feed reports. `null` means "not yet attached". */
export const CONNECTION_STATES = Object.freeze([
  "CONNECTED",
  "LAGGING",
  "DISCONNECTED",
  "HISTORICAL",
] as const);

export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface ConnectionDescriptor {
  /** The state key, or "OFFLINE" for the not-yet-attached surface. */
  readonly key: ConnectionState | "OFFLINE";
  readonly label: string;
  readonly toneVar: string;
  /** The relay is producing frames: the sparkline animates. */
  readonly live: boolean;
  /** Daemon-answered and current enough to act on. */
  readonly actionsEnabled: boolean;
  /** The stale marker beside the state, or "" when data is current. */
  readonly staleLabel: string;
  /** A banner sentence, or "" when the state needs no banner (CONNECTED). */
  readonly banner: string;
}

const STALE = "SHOWING STALE DATA";

const CONNECTION: Readonly<Record<ConnectionState, ConnectionDescriptor>> = Object.freeze({
  CONNECTED: {
    key: "CONNECTED", label: "CONNECTED", toneVar: "--cr-conn-connected",
    live: true, actionsEnabled: true, staleLabel: "", banner: "",
  },
  LAGGING: {
    key: "LAGGING", label: "LAGGING", toneVar: "--cr-conn-lagging",
    live: true, actionsEnabled: true, staleLabel: "",
    banner: "Showing data as of the last relay update; commands remain available.",
  },
  DISCONNECTED: {
    key: "DISCONNECTED", label: "DISCONNECTED", toneVar: "--cr-conn-disconnected",
    live: false, actionsEnabled: false, staleLabel: STALE,
    banner: "Disconnected from the daemon. Actions stay visible and disabled.",
  },
  HISTORICAL: {
    key: "HISTORICAL", label: "HISTORICAL", toneVar: "--cr-conn-historical",
    live: true, actionsEnabled: false, staleLabel: STALE,
    banner: "Replayed view. Refresh affordances before acting.",
  },
});

/**
 * The honest state for a live build whose event feed is not wired yet (this slice
 * ships the shell, not the transport). It is NOT "connected" and shows no
 * fabricated relay - it says, plainly, that the relay is still coming online.
 */
const OFFLINE: ConnectionDescriptor = Object.freeze({
  key: "OFFLINE",
  label: "COMING ONLINE",
  toneVar: "--cr-conn-offline",
  live: false,
  actionsEnabled: false,
  staleLabel: "",
  banner: "The event relay attaches when the daemon feed lands. Nothing on this "
    + "surface is shown as a number until the daemon states it.",
});

export function describeConnection(state: ConnectionState | null): ConnectionDescriptor {
  return state === null ? OFFLINE : CONNECTION[state];
}

/* --------------------------------------------------------------------- Nav ---- */

export const NAV_IDS = Object.freeze([
  "goals",
  "approvals",
  "runs",
  "resources",
  "health",
  "policy",
] as const);

export type NavId = (typeof NAV_IDS)[number];

export type NavBadgeTone = "info" | "danger";

export interface NavItem {
  readonly id: NavId;
  readonly label: string;
  /** A single SVG path drawn at 1.7 stroke, from the design export. */
  readonly icon: string;
}

/** The rail, in the order the design lists it. */
export const CORDUM_NAV_ITEMS: readonly NavItem[] = Object.freeze([
  { id: "goals", label: "Goals", icon: "M12 4a8 8 0 1 0 8 8 M12 7a5 5 0 1 0 5 5 M12 10a2 2 0 1 0 2 2" },
  {
    id: "approvals", label: "Needs you",
    icon: "M5.5 12.5 9.5 16.5 18.5 7.5 M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z",
  },
  {
    id: "runs", label: "Runs & leases",
    icon: "M7 7h7.5a5.5 5.5 0 0 1 0 11H11 M7 7l3-3 M7 7l3 3 M17 17l-3-3 M17 17l-3 3",
  },
  { id: "resources", label: "Resources", icon: "M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5Z M12 8v8 M8 12h8" },
  { id: "health", label: "Health", icon: "M3.5 12h4l2-5 4 10 2.5-5h4.5 M12 3.5a8.5 8.5 0 1 0 8.5 8.5" },
  {
    id: "policy", label: "Policy",
    icon: "M12 3.5 19 6v5.4c0 4.3-2.8 7.5-7 9.1-4.2-1.6-7-4.8-7-9.1V6l7-2.5Z M9 12l2 2 4-4",
  },
]);

export const NAV_BADGE_TONE_VAR: Readonly<Record<NavBadgeTone, string>> = Object.freeze({
  info: "--cr-truth-human-deep",
  danger: "--cr-danger",
});

/* ---------------------------------------------------------------- Treatment --- */

export const CARD_TREATMENTS = Object.freeze(["Compact", "Instrument", "Ledger"] as const);

export type CardTreatment = (typeof CARD_TREATMENTS)[number];
