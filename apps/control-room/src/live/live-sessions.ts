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

export interface SessionView {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  readonly holding: readonly string[];
  readonly liveness: SessionLiveness;
  readonly principalId: string;
  readonly sessionId: string;
  readonly status: "CLOSED" | "OPEN";
}

export type SessionsOutcome =
  | {
    readonly status: "SESSIONS";
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

function sessionOf(value: unknown): SessionView | null {
  const record = exactDataRecord(value, ["capabilities", "expiresAt", "holding", "liveness", "principalId", "sessionId", "status"]);
  if (record === null || !nonEmptyString(record.expiresAt) || !nonEmptyString(record.principalId) || !nonEmptyString(record.sessionId)
    || (record.status !== "CLOSED" && record.status !== "OPEN") || typeof record.liveness !== "string"
    || !(SESSION_LIVENESS as readonly string[]).includes(record.liveness)) return null;
  const capabilities = stringList(record.capabilities);
  const holding = stringList(record.holding);
  if (capabilities === null || holding === null) return null;
  return Object.freeze({
    capabilities, expiresAt: record.expiresAt, holding, liveness: record.liveness as SessionLiveness,
    principalId: record.principalId, sessionId: record.sessionId, status: record.status,
  });
}

/** Maps only an exact daemon SESSIONS frame; every other answer is REFUSED or ERROR. PURE. */
export function mapSessionsAnswer(status: number, response: unknown): SessionsOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, ["outcome", "readAt", "sessions", "totals", "unreadable"]);
  if (record === null || record.outcome !== "SESSIONS" || !nonEmptyString(record.readAt) || typeof record.unreadable !== "boolean") return invalidResponse();
  const totals = exactDataRecord(record.totals, ["closed", "expired", "live"]);
  if (totals === null || !count(totals.closed) || !count(totals.expired) || !count(totals.live) || !Array.isArray(record.sessions)) return invalidResponse();
  const sessions: SessionView[] = [];
  for (const raw of record.sessions) {
    const session = sessionOf(raw);
    if (session === null) return invalidResponse();
    sessions.push(session);
  }
  return Object.freeze({
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
