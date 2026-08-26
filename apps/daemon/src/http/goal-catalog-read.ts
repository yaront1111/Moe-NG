/** A bounded catalog of goals this daemon can prove from its own durable GoalCreated rows. */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const GOAL_CATALOG_READ_PATH = "/goals/read" as const;
export const MAX_GOAL_CATALOG_ROWS = 256 as const;

const GOAL_CATALOG_READ_LAYER = "GOAL_CATALOG_READ" as const;
const GOAL_CREATED_EVENT_TYPE = "GoalCreated";
/**
 * NINE keys, exactly. `brief` is the prose the goal was created from, stamped on the fact by the
 * writer; the reader stays STRICT, so a GoalCreated missing it — or carrying anything else — is
 * still refused GOAL_CATALOG_READ_MALFORMED rather than read leniently.
 */
const GOAL_CREATED_KEYS = Object.freeze([
  "brief", "budgetAccountRef", "commandId", "goalId", "kind", "planningRunRef", "projectId",
  "version", "witness",
]);
const PROJECT_READY_KEYS = Object.freeze(["projectReadyRef", "truthClass"]);

export const GOAL_CATALOG_READ_CODES = Object.freeze([
  "GOAL_CATALOG_READ_CAPABILITY_DENIED",
  "GOAL_CATALOG_READ_LIMIT_EXCEEDED",
  "GOAL_CATALOG_READ_MALFORMED",
  "GOAL_CATALOG_READ_PROJECT_MISMATCH",
  "GOAL_CATALOG_READ_UNREADABLE",
] as const);

export type GoalCatalogReadCode = (typeof GOAL_CATALOG_READ_CODES)[number];

export interface GoalCatalogEntry {
  readonly goalId: string;
  readonly planningRunRef: string;
}

export interface GoalCatalogView {
  readonly goals: readonly GoalCatalogEntry[];
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
  readGoals(): GoalCatalogReadResult;
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
  if (!exact(fact, GOAL_CREATED_KEYS) || fact["kind"] !== GOAL_CREATED_EVENT_TYPE
    || fact["version"] !== 1 || fact["commandId"] !== trace.commandId) {
    return refused("GOAL_CATALOG_READ_MALFORMED");
  }
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
  return Object.freeze({ goalId: fact["goalId"], planningRunRef: fact["planningRunRef"] });
}

export function readGoalCatalog(
  store: SqliteEventStore, projectId: string,
): GoalCatalogReadResult {
  try {
    if (store.getHealth().projectId !== projectId) {
      return refused("GOAL_CATALOG_READ_PROJECT_MISMATCH");
    }
    const page = store.readEventsByTypeAfter(
      GOAL_CREATED_EVENT_TYPE, 0n, MAX_GOAL_CATALOG_ROWS + 1,
    );
    if (page.hasMore || page.items.length > MAX_GOAL_CATALOG_ROWS) {
      return refused("GOAL_CATALOG_READ_LIMIT_EXCEEDED");
    }
    const goals: GoalCatalogEntry[] = [];
    const goalIds = new Set<string>();
    for (const event of page.items) {
      const entry = goalEntry(event, projectId);
      if ("code" in entry) return entry;
      if (goalIds.has(entry.goalId)) return refused("GOAL_CATALOG_READ_MALFORMED");
      goalIds.add(entry.goalId);
      goals.push(entry);
    }
    return Object.freeze({ goals: Object.freeze(goals), outcome: "GOALS" as const });
  } catch {
    return refused("GOAL_CATALOG_READ_UNREADABLE");
  }
}

export function createGoalCatalogReadPort(config: {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): GoalCatalogReadPort {
  return Object.freeze({
    boundProjectId: config.projectId,
    readGoals: (): GoalCatalogReadResult => readGoalCatalog(config.store, config.projectId),
  });
}

type GoalCatalogListenerCode =
  | "LISTENER_GOAL_CATALOG_REQUEST_INVALID"
  | "LISTENER_GOAL_CATALOG_UNAVAILABLE";

export type GoalCatalogReadDispatch =
  | { readonly body: HttpPortRefused | HttpRefused | GoalCatalogReadResult;
      readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: GoalCatalogListenerCode; readonly kind: "LISTENER_REFUSAL" };

function exactEmptyRequest(body: unknown): boolean {
  const decoded = decodeBoundedJsonBytes(body);
  return decoded.ok && exact(decoded.value, []);
}

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
  if (!exactEmptyRequest(request.body)) {
    return Object.freeze({ code: "LISTENER_GOAL_CATALOG_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  }
  return Object.freeze({
    body: dependencies.goalCatalog.readGoals(), httpStatus: 200, kind: "REPLY",
  });
}
