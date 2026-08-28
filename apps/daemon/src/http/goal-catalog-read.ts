/** A bounded catalog of goals this daemon can prove from its own durable GoalCreated rows. */
import { randomBytes } from "node:crypto";

import { admitGoalBrief, decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  decodeGoalCatalogCursor, encodeGoalCatalogCursor, requestedCursor,
} from "./goal-catalog-cursor.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const GOAL_CATALOG_READ_PATH = "/goals/read" as const;
export const MAX_GOAL_CATALOG_ROWS = 256 as const;

const GOAL_CATALOG_READ_LAYER = "GOAL_CATALOG_READ" as const;
const GOAL_CREATED_EVENT_TYPE = "GoalCreated";
/**
 * TWO shapes, each exact, nothing between them.
 *
 * `BRIEF_GOAL_CREATED_KEYS` is the nine the writer stamps today: `brief` is the prose the goal
 * was created from. `LEGACY_GOAL_CREATED_KEYS` is the eight written before the brief existed —
 * such a row is explicitly brief-UNKNOWN and reads back with `brief: null`. The reader NEVER
 * synthesizes prose for it and never upgrades an unknown brief to authority.
 *
 * Anything that is neither roster — a brief-bearing row with an extra key, a legacy row with a
 * foreign ninth — is a HYBRID no writer can produce, and is refused GOAL_CATALOG_READ_MALFORMED
 * rather than read leniently.
 */
const LEGACY_GOAL_CREATED_KEYS = Object.freeze([
  "budgetAccountRef", "commandId", "goalId", "kind", "planningRunRef", "projectId",
  "version", "witness",
]);
const BRIEF_GOAL_CREATED_KEYS = Object.freeze(["brief", ...LEGACY_GOAL_CREATED_KEYS]);
const PROJECT_READY_KEYS = Object.freeze(["projectReadyRef", "truthClass"]);

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

export interface GoalCatalogEntry {
  /** The normalized brief the writer stamped, or `null` for a legacy brief-unknown row. */
  readonly brief: { readonly instructions: string; readonly title: string } | null;
  readonly goalId: string;
  readonly planningRunRef: string;
}

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

function objectOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function exact(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  const record = objectOf(value);
  if (record === null) return false;
  return Object.keys(record).length === keys.length
    && keys.every((key) => Object.hasOwn(record, key));
}

const nonEmptyRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * The stored brief, re-admitted through the PRODUCTION contract rather than re-checked here.
 * Two conditions, both required: `admitGoalBrief` must accept it, so shape and bounds stay the
 * contract's; and it must be its own FIXED POINT, because the writer stores what the contract
 * produced — an untrimmed or CRLF-bearing stored brief re-admits to something DIFFERENT and so
 * cannot have come from the writer. `undefined` means refuse the catalog.
 */
function admittedBrief(value: unknown): GoalCatalogEntry["brief"] | undefined {
  const admitted = admitGoalBrief(value);
  if (!admitted.ok) return undefined;
  const stored = objectOf(value);
  if (stored === null || stored["instructions"] !== admitted.brief.instructions
    || stored["title"] !== admitted.brief.title) {
    return undefined;
  }
  return Object.freeze({
    instructions: admitted.brief.instructions, title: admitted.brief.title,
  });
}

function goalEntry(
  event: StoredEvent, projectId: string,
): GoalCatalogEntry | GoalCatalogRefused {
  const trace = event.decisionTrace;
  if (trace === undefined) return refused("GOAL_CATALOG_READ_MALFORMED");
  if (trace.projectId !== projectId) return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
  if (trace.commandKind !== "goal.create" || event.aggregateSequence !== 1) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok || !Array.isArray(decoded.value) || decoded.value.length !== 1) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const fact = decoded.value[0];
  const briefBearing = exact(fact, BRIEF_GOAL_CREATED_KEYS);
  if ((!briefBearing && !exact(fact, LEGACY_GOAL_CREATED_KEYS))
    || fact["kind"] !== GOAL_CREATED_EVENT_TYPE
    || fact["version"] !== 1 || fact["commandId"] !== trace.commandId) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  const brief = briefBearing ? admittedBrief(fact["brief"]) : null;
  if (brief === undefined) return refused("GOAL_CATALOG_READ_MALFORMED");
  const witness = fact["witness"];
  if (!exact(witness, PROJECT_READY_KEYS)
    || !nonEmptyRef(witness["projectReadyRef"])
    || (witness["truthClass"] !== "DAEMON_VERIFIED"
      && witness["truthClass"] !== "HUMAN_APPROVED")
    || !nonEmptyRef(fact["budgetAccountRef"]) || !nonEmptyRef(fact["goalId"])
    || !nonEmptyRef(fact["planningRunRef"]) || !nonEmptyRef(fact["projectId"])) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
  if (fact["projectId"] !== projectId) return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
  if (fact["goalId"] !== event.aggregateId) return refused("GOAL_CATALOG_READ_MALFORMED");
  return Object.freeze({
    brief, goalId: fact["goalId"], planningRunRef: fact["planningRunRef"],
  });
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
      const entry = goalEntry(event, projectId);
      if ("code" in entry) return entry;
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
