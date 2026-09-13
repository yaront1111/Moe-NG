/**
 * The SESSIONS read client: POST /sessions/read with EXACTLY `{}`, shaped verbatim into
 * SESSIONS / REFUSED / ERROR. READS ONLY; exact-key snapshots at every level.
 */

const LIVE_SESSIONS_LAYER = "CONTROL_ROOM_LIVE_SESSIONS";
const INVALID_RESPONSE_CODE = "SESSIONS_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const SESSIONS_READ_PATH = "/sessions/read";
const REQUEST_TIMEOUT_MS = 15_000;

export const SESSION_LIVENESS = ["CLOSED", "EXPIRED", "LIVE"] as const;
export type SessionLiveness = (typeof SESSION_LIVENESS)[number];

/**
 * What the daemon STATED about ONE seat. `providerAtStart` and `agentVersionAtStart` are what
 * the WRAPPER measured when it spawned this seat and wrote down — second-hand facts about the
 * past, never a live reading, which is why both names end in `AtStart`. Either can be the
 * daemon's stated unknown; the browser shapes them verbatim and never substitutes a default.
 */
export interface SessionView {
  readonly agentVersionAtStart: string;
  readonly capabilities: readonly string[];
  /**
   * How the daemon STATED this seat ended, quoted from the wrapper's own exit record, or null
   * when no record speaks for it (still running, or exited before the exit ledger existed). The
   * screen says "reason not recorded" for null and never guesses a kind.
   */
  readonly exit: SeatExitView | null;
  readonly expiresAt: string;
  readonly holding: readonly string[];
  readonly liveness: SessionLiveness;
  readonly principalId: string;
  readonly providerAtStart: string;
  readonly sessionId: string;
  /**
   * The wrapper's clock when it spawned this seat, or null for a seat with no start record — a
   * paired browser, and every seat older than the start ledger. Null renders as "start not
   * recorded"; the browser never substitutes its own clock.
   */
  readonly startedAt: string | null;
  readonly status: "CLOSED" | "OPEN";
}

/**
 * How one seat ended, as the daemon stated it. `exitCode` is null when the seat died on a signal
 * rather than an exit code — the record's documented meaning, mirrored from
 * apps/daemon/src/orchestrator/provider-pause-contracts.ts — and `lastLine` is the last non-empty
 * line the seat printed, or null. Shaped verbatim; the words are the screen's concern.
 */
export interface SeatExitView {
  readonly at: string;
  readonly exitCode: number | null;
  readonly kind: string;
  readonly lastLine: string | null;
}

/**
 * THE ONE STATED UNKNOWN the daemon publishes when nobody measured a seat's start, mirrored
 * here so a screen can ask "is this a reading or an absence?" without matching a bare literal.
 * Kept in step with `SEAT_FACT_UNMEASURED` in apps/daemon/src/orchestrator/seat-start-contracts.ts.
 */
export const SEAT_FACT_UNMEASURED = "UNKNOWN";

/**
 * What the daemon STATED about concurrency. `configuredAgentLimit` is the agent limit the
 * daemon process was launched with — configured, not a live measurement of the wrapper;
 * `activeSeats` is live seats holding work at the read's clock. Shaped verbatim: the
 * browser adds no interpretation of its own.
 */
export interface SessionsConcurrency {
  readonly activeSeats: number;
  readonly configuredAgentLimit: number;
}

/**
 * What the daemon STATED about the agent provider. `configured` is the provider this
 * PROJECT is configured to staff seats with — the daemon's own env plus its durable
 * project setting, never a measurement of what the wrapper actually spawned, and never a
 * per-goal override (that read is project-scoped). `envOverride` says MOE_AGENT_COMMAND in
 * the daemon's environment is what decided it. Shaped verbatim: no interpretation here.
 */
export interface SessionsAgentProvider {
  readonly configured: string;
  readonly envOverride: boolean;
}

export type SessionsOutcome =
  | {
    readonly status: "SESSIONS";
    readonly agentProvider: SessionsAgentProvider;
    readonly concurrency: SessionsConcurrency;
    readonly readAt: string;
    readonly sessions: readonly SessionView[];
    readonly totals: { readonly closed: number; readonly expired: number; readonly live: number };
    readonly unreadable: boolean;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): SessionsOutcome => Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): SessionsOutcome => Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): SessionsOutcome => errored(INVALID_RESPONSE_CODE, LIVE_SESSIONS_LAYER);

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-planning-run.ts). */
function exactDataRecord(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> | null {
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
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function refusalFrom(response: unknown): SessionsOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED" && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port.ok === false && port.outcome === "PORT_REFUSED" && typeof port.stage === "string") {
    const portCode = typeof port.refusal === "object" && port.refusal !== null
      ? Object.getOwnPropertyDescriptor(port.refusal, "code") : undefined;
    if (portCode !== undefined && "value" in portCode && typeof portCode.value === "string") {
      return refused(portCode.value, port.stage);
    }
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED" || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const stringList = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? Object.freeze([...(value as string[])]) : null;

/**
 * ONE SEAT, key for key. Exported for the same reason `SESSIONS_FRAME_KEYS` is: this decode is
 * EXACT-ARITY too, so a PER-SEAT member added on the daemon and not here does not degrade the
 * Seats screen, it BLANKS it — `sessionOf` returns null and the whole frame becomes an ERROR.
 */
export const SESSION_KEYS = [
  "agentVersionAtStart", "capabilities", "exit", "expiresAt", "holding", "liveness", "principalId",
  "providerAtStart", "sessionId", "startedAt", "status",
] as const;

/** The exit object, key for key, exact-arity like the seat that carries it. */
export const SEAT_EXIT_KEYS = ["at", "exitCode", "kind", "lastLine"] as const;

/**
 * The daemon's exit for one seat: null, an exact record, or `false` for a shape this decode
 * refuses. `null` is a VALUE here (no record speaks for the seat) and is passed through as such;
 * `exitCode` and `lastLine` are each null-or-typed, never truthiness-tested, because `0` is a
 * real exit code and `""` is not a line the record would carry.
 */
function seatExitOf(value: unknown): SeatExitView | null | false {
  if (value === null) return null;
  const record = exactDataRecord(value, SEAT_EXIT_KEYS);
  if (record === null || !nonEmptyString(record.at) || !nonEmptyString(record.kind)
    || !(record.exitCode === null || (typeof record.exitCode === "number" && Number.isInteger(record.exitCode)))
    || !(record.lastLine === null || typeof record.lastLine === "string")) return false;
  return Object.freeze({
    at: record.at, exitCode: record.exitCode as number | null, kind: record.kind, lastLine: record.lastLine as string | null,
  });
}

function sessionOf(value: unknown): SessionView | null {
  const record = exactDataRecord(value, SESSION_KEYS);
  // `providerAtStart` and `agentVersionAtStart` are STRINGS, checked as strings: a truthiness
  // test would accept `0`, `false` or `[]` and render an absence as if it were a reading. The
  // daemon states its unknown as a word, so "empty" is never a value this decode may accept.
  if (record === null || !nonEmptyString(record.expiresAt) || !nonEmptyString(record.principalId) || !nonEmptyString(record.sessionId)
    || !nonEmptyString(record.providerAtStart) || !nonEmptyString(record.agentVersionAtStart)
    || (record.status !== "CLOSED" && record.status !== "OPEN") || typeof record.liveness !== "string"
    || !(SESSION_LIVENESS as readonly string[]).includes(record.liveness)) return null;
  // `startedAt` is null-or-instant: `undefined` (key present, value missing) is neither.
  if (!(record.startedAt === null || nonEmptyString(record.startedAt))) return null;
  const exit = seatExitOf(record.exit);
  if (exit === false) return null;
  const capabilities = stringList(record.capabilities);
  const holding = stringList(record.holding);
  if (capabilities === null || holding === null) return null;
  return Object.freeze({
    agentVersionAtStart: record.agentVersionAtStart, capabilities, exit, expiresAt: record.expiresAt,
    holding, liveness: record.liveness as SessionLiveness, principalId: record.principalId,
    providerAtStart: record.providerAtStart, sessionId: record.sessionId,
    startedAt: record.startedAt as string | null, status: record.status,
  });
}

/**
 * The daemon's SESSIONS frame, key for key. Exported so a test can hold it against the
 * daemon's own `SessionsView` members: this decode is EXACT-ARITY, so a member added on
 * one side and not the other does not degrade the Seats screen, it BLANKS it.
 */
export const SESSIONS_FRAME_KEYS = ["agentProvider", "concurrency", "outcome", "readAt", "sessions", "totals", "unreadable"] as const;

/** Maps only an exact daemon SESSIONS frame; every other answer is REFUSED or ERROR. PURE. */
export function mapSessionsAnswer(status: number, response: unknown): SessionsOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, SESSIONS_FRAME_KEYS);
  if (record === null || record.outcome !== "SESSIONS" || !nonEmptyString(record.readAt) || typeof record.unreadable !== "boolean") return invalidResponse();
  const totals = exactDataRecord(record.totals, ["closed", "expired", "live"]);
  if (totals === null || !count(totals.closed) || !count(totals.expired) || !count(totals.live) || !Array.isArray(record.sessions)) return invalidResponse();
  const concurrency = exactDataRecord(record.concurrency, ["activeSeats", "configuredAgentLimit"]);
  if (concurrency === null || !count(concurrency.activeSeats) || !count(concurrency.configuredAgentLimit)) return invalidResponse();
  // `envOverride` is a FLAG, so it is type-checked as one: a truthiness test would let the
  // string "false" through and render an override that the daemon never claimed.
  const agentProvider = exactDataRecord(record.agentProvider, ["configured", "envOverride"]);
  if (agentProvider === null || !nonEmptyString(agentProvider.configured) || typeof agentProvider.envOverride !== "boolean") return invalidResponse();
  const sessions: SessionView[] = [];
  for (const raw of record.sessions) {
    const session = sessionOf(raw);
    if (session === null) return invalidResponse();
    sessions.push(session);
  }
  return Object.freeze({
    agentProvider: Object.freeze({ configured: agentProvider.configured, envOverride: agentProvider.envOverride }),
    concurrency: Object.freeze({ activeSeats: concurrency.activeSeats, configuredAgentLimit: concurrency.configuredAgentLimit }),
    readAt: record.readAt, sessions: Object.freeze(sessions), status: "SESSIONS" as const,
    totals: Object.freeze({ closed: totals.closed, expired: totals.expired, live: totals.live }), unreadable: record.unreadable,
  });
}

/** POSTs exactly `{}` and maps the reply; `post` is injectable for tests. */
export async function readSessions(
  headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>,
): Promise<SessionsOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(SESSIONS_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send("{}");
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_SESSIONS_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapSessionsAnswer(response.status, body);
}
