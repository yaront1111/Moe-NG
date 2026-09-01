/** A bounded catalog of goals this daemon can prove from its own durable GoalCreated rows. */
import { randomBytes } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  decodeGoalCatalogCursor, encodeGoalCatalogCursor, requestedCursor,
} from "./goal-catalog-cursor.js";
import {
  decodeGoalCatalogEntry, GOAL_CREATED_EVENT_TYPE,
} from "./goal-catalog-entry.js";
import type { GoalCatalogEntry } from "./goal-catalog-entry.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export type { GoalCatalogEntry } from "./goal-catalog-entry.js";

export const GOAL_CATALOG_READ_PATH = "/goals/read" as const;
export const MAX_GOAL_CATALOG_ROWS = 256 as const;

const GOAL_CATALOG_READ_LAYER = "GOAL_CATALOG_READ" as const;

/**
 * `GOAL_CATALOG_READ_LIMIT_EXCEEDED` is GONE: a project past the row bound is paginated now, not
 * refused, and no consumer named it. The four cursor codes are the codec's, stamped at this
 * module's own private layer.
 */
export const GOAL_CATALOG_READ_CODES = Object.freeze([
  "GOAL_CATALOG_CURSOR_MALFORMED",
  "GOAL_CATALOG_CURSOR_OVERSIZED",
  "GOAL_CATALOG_CURSOR_PROJECT_MISMATCH",
  "GOAL_CATALOG_CURSOR_STALE",
  "GOAL_CATALOG_READ_CAPABILITY_DENIED",
  "GOAL_CATALOG_READ_MALFORMED",
  "GOAL_CATALOG_READ_PROJECT_MISMATCH",
  "GOAL_CATALOG_READ_UNREADABLE",
] as const);

export type GoalCatalogReadCode = (typeof GOAL_CATALOG_READ_CODES)[number];

export interface GoalCatalogView {
  readonly goals: readonly GoalCatalogEntry[];
  /** The signed continuation, or `null` when this page ended the pinned enumeration. */
  readonly nextCursor: string | null;
  readonly outcome: "GOALS";
}

export interface GoalCatalogRefused {
  readonly code: GoalCatalogReadCode;
  readonly layer: typeof GOAL_CATALOG_READ_LAYER;
  readonly outcome: "REFUSED";
}

export type GoalCatalogReadResult = GoalCatalogRefused | GoalCatalogView;

export interface GoalCatalogReadPort {
  readonly boundProjectId: string;
  readGoals(cursor?: string): GoalCatalogReadResult;
}

function refused(code: GoalCatalogReadCode): GoalCatalogRefused {
  return Object.freeze({ code, layer: GOAL_CATALOG_READ_LAYER, outcome: "REFUSED" as const });
}

/**
 * ONE PAGE of a PINNED enumeration. Page one pins the store horizon and signs it into the
 * continuation; later pages drop anything past that horizon, so a goal appended mid-drain can
 * neither appear twice nor displace one already being enumerated — it belongs to the next fresh
 * read. The caller shapes nothing: not the page size, not the horizon, not the resume position.
 */
export function readGoalCatalog(
  store: SqliteEventStore, projectId: string, cursorSecret: Buffer, cursor?: string,
): GoalCatalogReadResult {
  try {
    if (store.getHealth().projectId !== projectId) {
      return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
    }
    let after = 0n;
    let horizon: bigint;
    if (cursor === undefined) {
      horizon = store.readEventHorizon();
    } else {
      const decoded = decodeGoalCatalogCursor(
        cursorSecret, { currentHorizon: store.readEventHorizon(), projectId }, cursor,
      );
      if (!decoded.ok) return refused(decoded.code);
      after = decoded.after;
      horizon = decoded.horizon;
    }
    const page = store.readEventsByTypeAfter(
      GOAL_CREATED_EVENT_TYPE, after, MAX_GOAL_CATALOG_ROWS + 1,
    );
    const inHorizon = page.items.filter((event) => event.globalPosition <= horizon);
    const goals: GoalCatalogEntry[] = [];
    const goalIds = new Set<string>();
    let lastPosition = after;
    for (const event of inHorizon.slice(0, MAX_GOAL_CATALOG_ROWS)) {
      const decoded = decodeGoalCatalogEntry(event, projectId);
      if (!decoded.ok) return refused(decoded.code);
      const entry = decoded.entry;
      if (goalIds.has(entry.goalId)) return refused("GOAL_CATALOG_READ_MALFORMED");
      goalIds.add(entry.goalId);
      goals.push(entry);
      lastPosition = event.globalPosition;
    }
    const more = inHorizon.length > MAX_GOAL_CATALOG_ROWS
      || (page.hasMore && inHorizon.length === page.items.length);
    return Object.freeze({
      goals: Object.freeze(goals),
      nextCursor: more
        ? encodeGoalCatalogCursor(cursorSecret, { after: lastPosition, horizon, projectId })
        : null,
      outcome: "GOALS" as const,
    });
  } catch {
    return refused("GOAL_CATALOG_READ_UNREADABLE");
  }
}

/**
 * The signing secret is minted ONCE per port and never leaves it, so a daemon restart invalidates
 * outstanding cursors by construction; the client answers any cursor refusal by draining again
 * from `{}`, which is what the Control Room reader does.
 */
export function createGoalCatalogReadPort(config: {
  readonly cursorSecret?: Buffer | undefined;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): GoalCatalogReadPort {
  const secret = config.cursorSecret ?? randomBytes(32);
  return Object.freeze({
    boundProjectId: config.projectId,
    readGoals: (cursor?: string): GoalCatalogReadResult =>
      readGoalCatalog(config.store, config.projectId, secret, cursor),
  });
}

type GoalCatalogListenerCode =
  | "LISTENER_GOAL_CATALOG_REQUEST_INVALID"
  | "LISTENER_GOAL_CATALOG_UNAVAILABLE";

export type GoalCatalogReadDispatch =
  | { readonly body: HttpPortRefused | HttpRefused | GoalCatalogReadResult;
      readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: GoalCatalogListenerCode; readonly kind: "LISTENER_REFUSAL" };

export function handleGoalCatalogReadRequest(
  dependencies: { readonly authenticator: Authenticator;
    readonly goalCatalog?: GoalCatalogReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null;
    readonly protocolVersion: unknown },
): GoalCatalogReadDispatch {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) {
    return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  }
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("GOAL_CATALOG_READ_CAPABILITY_DENIED"),
      httpStatus: 200, kind: "REPLY" });
  }
  if (dependencies.goalCatalog === undefined) {
    return Object.freeze({ code: "LISTENER_GOAL_CATALOG_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  }
  if (access.principal.projectId !== dependencies.goalCatalog.boundProjectId) {
    return Object.freeze({ body: refused("GOAL_CATALOG_READ_PROJECT_MISMATCH"),
      httpStatus: 200, kind: "REPLY" });
  }
  const requested = requestedCursor(request.body);
  if (!requested.ok) {
    return Object.freeze({ code: "LISTENER_GOAL_CATALOG_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({
    body: dependencies.goalCatalog.readGoals(requested.cursor), httpStatus: 200, kind: "REPLY",
  });
}
