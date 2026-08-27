import type { FetchLike } from "@moe/control-room-client";

/**
 * Reads the project-bound durable goal catalog from POST /goals/read.
 *
 * Project authority remains entirely at the daemon boundary: this client sends
 * the exact empty request and carries only the authenticated headers supplied by
 * the live handshake. It never accepts a project id from UI state, puts one in
 * the body, or rewrites a returned ref. The daemon therefore chooses the catalog
 * from the authenticated session's project and the UI can only render that
 * answer.
 */

const GOAL_CATALOG_READ_PATH = "/goals/read";
const LIVE_GOAL_CATALOG_UNREADABLE = "LIVE_GOAL_CATALOG_UNREADABLE";
const TRANSPORT_REQUEST_FAILED = "TRANSPORT_REQUEST_FAILED";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_GOAL_CATALOG_ROWS = 256;

export interface LiveGoalCatalogEntry {
  /** The normalized brief the daemon stamped, or `null` for a legacy brief-unknown row. */
  readonly brief: { readonly instructions: string; readonly title: string } | null;
  readonly goalId: string;
  readonly planningRunRef: string;
}

export interface GoalCatalogFrame {
  readonly connection: "CONNECTED" | "DISCONNECTED";
  readonly detail: string;
  readonly goals: readonly LiveGoalCatalogEntry[];
  readonly outcome: "GOALS" | "REFUSED" | "UNDELIVERED" | "UNREADABLE";
}

export interface ReadGoalCatalogOptions {
  /** The authenticated header set returned by the live handshake. */
  readonly headers: Readonly<Record<string, string>>;
  /** Injectable for focused tests; production uses the page's same-origin fetch. */
  readonly fetchImpl?: FetchLike | undefined;
  /** Applies only to the default/injected fetch call made by this reader. */
  readonly requestTimeoutMs?: number | undefined;
}

export interface GoalCatalogFeedOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly intervalMs: number;
  readonly onFrame: (frame: GoalCatalogFrame) => void;
  /** Injectable complete read for deterministic scheduling and stale-response tests. */
  readonly read?: (() => Promise<GoalCatalogFrame>) | undefined;
  readonly schedule?: ((run: () => void, delayMs: number) => () => void) | undefined;
}

export interface GoalCatalogFeed {
  /** Supersedes any in-flight generation and reads again immediately. */
  refresh(): void;
  start(): void;
  stop(): void;
}

function frame(
  connection: GoalCatalogFrame["connection"],
  outcome: GoalCatalogFrame["outcome"],
  detail: string,
  goals: readonly LiveGoalCatalogEntry[] = [],
): GoalCatalogFrame {
  return Object.freeze({
    connection,
    detail,
    goals: Object.freeze([...goals]),
    outcome,
  });
}

function unreadable(): GoalCatalogFrame {
  return frame("CONNECTED", "UNREADABLE", LIVE_GOAL_CATALOG_UNREADABLE);
}

/**
 * Returns an own-enumerable exact-key snapshot and rejects prototypes,
 * symbols, non-enumerable fields, and accessors. A decoded network object is
 * ordinarily plain; accepting anything richer would let unvouched behavior run
 * while the UI is deciding which project goal to open.
 */
function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Reads one own data property without invoking an accessor. */
function ownString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && nonEmptyString(descriptor.value)
      ? descriptor.value : null;
  } catch {
    return null;
  }
}

function refusalDetail(response: unknown): string | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && nonEmptyString(listener["code"])
    && nonEmptyString(listener["layer"])) return listener["code"];

  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route["outcome"] === "REFUSED"
    && nonEmptyString(route["code"]) && nonEmptyString(route["layer"])) return route["code"];

  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port["ok"] === false && port["outcome"] === "PORT_REFUSED"
    && nonEmptyString(port["stage"])) return ownString(port["refusal"], "code");

  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http !== null && http["ok"] === false && http["outcome"] === "REFUSED"
    && nonEmptyString(http["stage"])) return ownString(http["error"], "code");
  return null;
}

/**
 * Both wire generations arrive: a legacy two-key row is brief-UNKNOWN and decodes to `null`,
 * never to invented prose. A present brief must be `null` or exactly `{instructions, title}`,
 * both non-empty, under the row's own `exactDataRecord` discipline — so a nested accessor is
 * refused rather than invoked. `undefined` means fail the whole catalog closed, as before.
 */
function briefOf(value: unknown): LiveGoalCatalogEntry["brief"] | undefined {
  if (value === null) return null;
  const record = exactDataRecord(value, ["instructions", "title"]);
  if (record === null || !nonEmptyString(record["instructions"])
    || !nonEmptyString(record["title"])) return undefined;
  return Object.freeze({ instructions: record["instructions"], title: record["title"] });
}

function entryOf(value: unknown): LiveGoalCatalogEntry | null {
  const briefBearing = exactDataRecord(value, ["brief", "goalId", "planningRunRef"]);
  const record = briefBearing ?? exactDataRecord(value, ["goalId", "planningRunRef"]);
  if (record === null || !nonEmptyString(record["goalId"])
    || !nonEmptyString(record["planningRunRef"])) return null;
  const brief = briefBearing === null ? null : briefOf(briefBearing["brief"]);
  if (brief === undefined) return null;
  return Object.freeze({
    brief, goalId: record["goalId"], planningRunRef: record["planningRunRef"],
  });
}

/** Pure exact decoder for the complete wire answer. */
export function mapGoalCatalogAnswer(status: number, response: unknown): GoalCatalogFrame {
  // Refusals can be HTTP 200 (route) or non-200 (listener/auth). Recognise
  // their exact envelopes before the status gate so their stable code survives.
  const refused = refusalDetail(response);
  if (refused !== null) return frame("CONNECTED", "REFUSED", refused);
  if (status !== 200) return unreadable();

  const catalog = exactDataRecord(response, ["goals", "outcome"]);
  if (catalog === null || catalog["outcome"] !== "GOALS"
    || !Array.isArray(catalog["goals"])
    || catalog["goals"].length > MAX_GOAL_CATALOG_ROWS) return unreadable();

  const goals: LiveGoalCatalogEntry[] = [];
  const goalIds = new Set<string>();
  for (const raw of catalog["goals"]) {
    const entry = entryOf(raw);
    if (entry === null || goalIds.has(entry.goalId)) return unreadable();
    goalIds.add(entry.goalId);
    goals.push(entry);
  }
  return frame("CONNECTED", "GOALS", "", goals);
}

/**
 * Sends exactly `{}` to the authenticated, same-origin catalog route. A daemon
 * answer with unreadable JSON remains CONNECTED/UNREADABLE; only an undelivered
 * round trip is DISCONNECTED/UNDELIVERED.
 */
export async function readGoalCatalog(
  options: ReadGoalCatalogOptions,
): Promise<GoalCatalogFrame> {
  const send = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await send(GOAL_CATALOG_READ_PATH, {
      body: "{}",
      headers: options.headers,
      method: "POST",
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    return frame("DISCONNECTED", "UNDELIVERED", TRANSPORT_REQUEST_FAILED);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unreadable();
  }
  return mapGoalCatalogAnswer(response.status, body);
}

/**
 * Kept polling loop for one authenticated project. A generation guards every
 * completion: switching projects, refreshing after goal.create, or unmounting
 * makes any older response inert, even though fetch itself may already be in
 * flight and cannot be synchronously cancelled.
 */
export function createGoalCatalogFeed(options: GoalCatalogFeedOptions): GoalCatalogFeed {
  const read = options.read ?? (() => readGoalCatalog({ headers: options.headers }));
  const schedule = options.schedule
    ?? ((run: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(run, delayMs);
      return () => { clearTimeout(timer); };
    });
  let cancel: (() => void) | null = null;
  let generation = 0;
  let running = false;

  const poll = async (run: number): Promise<void> => {
    const next = await read();
    if (!running || run !== generation) return;
    options.onFrame(next);
    if (run === generation) {
      cancel = schedule(() => { void poll(run); }, options.intervalMs);
    }
  };

  const begin = (): void => {
    generation += 1;
    cancel?.();
    cancel = null;
    void poll(generation);
  };

  return Object.freeze({
    refresh: (): void => { if (running) begin(); },
    start: (): void => {
      if (running) return;
      running = true;
      begin();
    },
    stop: (): void => {
      running = false;
      generation += 1;
      cancel?.();
      cancel = null;
    },
  });
}
