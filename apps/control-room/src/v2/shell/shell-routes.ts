import { NAV_IDS } from "./shell-model.js";
import type { NavId } from "./shell-model.js";

/**
 * THE ONE typed route source of truth for the Cordum shell.
 *
 * Every navigation button is driven from `resolveNavDestinations()`. A second
 * place that knows how to build a route is a second source of truth and will
 * drift, so the rail holds no route knowledge of its own: it renders what this
 * module states.
 *
 * A destination the build cannot reach is DISABLED with the reason it is
 * unavailable, never merely inert. The difference is the whole clause: an inert
 * control that silently does nothing looks broken, while a disabled one carrying
 * `NAV_UNAVAILABLE_LABELS[reason]` tells the operator what is missing. The reason
 * is MEASURED - it comes from this roster - rather than inferred from a lookup
 * that happened to return undefined or from whether a handler was passed.
 */

/**
 * Every route kind the shell can be at. The `CordumRoute` union below DERIVES its
 * discriminants from this roster, so a kind removed here fails to typecheck at
 * the union rather than silently shrinking the surface.
 */
export const CORDUM_ROUTE_KINDS = Object.freeze(["approvals", "board", "goals", "health", "policy", "resources", "runs"] as const);

export type CordumRouteKind = (typeof CORDUM_ROUTE_KINDS)[number];

/**
 * A route carries the DURABLE identifiers its surface reads. `board` names BOTH
 * the goal it was opened for and that goal's own planning run, because the surfaces
 * behind it read different ones: the plan review is per RUN, the board chrome is
 * per GOAL. Nothing here is synthesised, placeholder, or derived by
 * string-formatting some other value.
 */
export type CordumRoute =
  | { readonly kind: Extract<CordumRouteKind, "approvals"> }
  | { readonly kind: Extract<CordumRouteKind, "goals"> }
  | { readonly kind: Extract<CordumRouteKind, "runs"> }
  | { readonly kind: Extract<CordumRouteKind, "policy"> }
  | { readonly kind: Extract<CordumRouteKind, "health"> }
  | { readonly kind: Extract<CordumRouteKind, "resources"> }
  | {
    readonly goalId: string;
    readonly kind: Extract<CordumRouteKind, "board">;
    readonly planningRunRef: string;
    readonly title: string;
  };

export type BoardRoute = Extract<CordumRoute, { kind: "board" }>;

/**
 * The ONE constructor for a board route. Callers hand over the identifiers the
 * durable catalog gave them; a second place that assembles this shape by hand is a
 * second source of truth and will drift.
 */
export function boardRoute(goalId: string, planningRunRef: string, title: string): BoardRoute {
  return Object.freeze({ goalId, kind: "board" as const, planningRunRef, title });
}

/** Stable reason codes for a destination the operator cannot reach. */
export const NAV_UNAVAILABLE_REASONS = Object.freeze([
  "NAV_DESTINATION_NOT_BUILT",
  "NAV_ROUTE_SUBJECT_ABSENT",
] as const);

export type NavUnavailableReason = (typeof NAV_UNAVAILABLE_REASONS)[number];

/** What each reason code says to the operator, in their words rather than the code. */
export const NAV_UNAVAILABLE_LABELS: Readonly<Record<NavUnavailableReason, string>> = Object.freeze({
  NAV_DESTINATION_NOT_BUILT: "This destination is not built yet in this release.",
  NAV_ROUTE_SUBJECT_ABSENT: "No durable subject has been stated for this destination yet.",
});

export interface NavDestination {
  readonly id: NavId;
  /** The route this destination navigates to, or `null` when it is unavailable. */
  readonly route: CordumRoute | null;
  /** `null` exactly when the destination is reachable. */
  readonly reason: NavUnavailableReason | null;
}

/**
 * The destinations this build actually implements. Absence from this map is the
 * measurement behind `NAV_DESTINATION_NOT_BUILT`: a surface is listed here when it
 * exists, not when someone hopes it does.
 */
const BUILT_NAV_ROUTES: Partial<Readonly<Record<NavId, CordumRoute>>> = Object.freeze({
  approvals: Object.freeze({ kind: "approvals" }),
  goals: Object.freeze({ kind: "goals" }),
  runs: Object.freeze({ kind: "runs" }),
  policy: Object.freeze({ kind: "policy" }),
  health: Object.freeze({ kind: "health" }),
  resources: Object.freeze({ kind: "resources" }),
});

/** One destination per nav id, in the rail's declared order. */
export function resolveNavDestinations(): readonly NavDestination[] {
  return Object.freeze(NAV_IDS.map((id): NavDestination => {
    const route = BUILT_NAV_ROUTES[id];
    return route === undefined
      ? Object.freeze({ id, reason: "NAV_DESTINATION_NOT_BUILT" as const, route: null })
      : Object.freeze({ id, reason: null, route });
  }));
}
