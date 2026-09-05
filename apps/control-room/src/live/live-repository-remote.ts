/**
 * THE PROJECT'S BOUND GIT REMOTE, as the browser reads it: POST /repository/remote/read with
 * EXACTLY `{}`, shaped verbatim into REMOTE / REFUSED / ERROR. READS ONLY; exact-key snapshots
 * at every level, the same discipline as live-sessions.ts.
 *
 * UNBOUND IS A STATE, NOT A FAULT. The daemon answers the same REMOTE frame with `remoteUrl`,
 * `boundAt` and `boundBy` all NULL while nothing is bound (repository-remote-read.ts:34-42), so
 * the decoder admits null for each of the three WITHOUT collapsing "no remote yet" into
 * "malformed". Only `outcome` and `readAt` are always present. A frame carrying any other key
 * set - one key more, one key fewer - is refused rather than defaulted, because a silently
 * defaulted remote is a url this project never bound.
 */

const LIVE_REPOSITORY_REMOTE_LAYER = "CONTROL_ROOM_LIVE_REPOSITORY_REMOTE";
const INVALID_RESPONSE_CODE = "REPOSITORY_REMOTE_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const REPOSITORY_REMOTE_READ_PATH = "/repository/remote/read";
const REQUEST_TIMEOUT_MS = 15_000;

/** The five keys the daemon's RepositoryRemoteView carries, in the order the frame states them. */
export const REPOSITORY_REMOTE_FRAME_KEYS = ["boundAt", "boundBy", "outcome", "readAt", "remoteUrl"] as const;

export type RepositoryRemoteOutcome =
  | {
    readonly status: "REMOTE";
    /** When the binding was decided, or null while nothing is bound. */
    readonly boundAt: string | null;
    /** The PRINCIPAL that bound it, never a credential, or null while nothing is bound. */
    readonly boundBy: string | null;
    readonly readAt: string;
    readonly remoteUrl: string | null;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): RepositoryRemoteOutcome =>
  Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): RepositoryRemoteOutcome =>
  Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): RepositoryRemoteOutcome => errored(INVALID_RESPONSE_CODE, LIVE_REPOSITORY_REMOTE_LAYER);

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-sessions.ts). */
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

function refusalFrom(response: unknown): RepositoryRemoteOutcome | null {
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
/** A bound field is a NON-EMPTY string; null is the unbound state; anything else is malformed. */
const boundField = (value: unknown): value is string | null => value === null || nonEmptyString(value);

/** Maps only an exact daemon REMOTE frame; every other answer is REFUSED or ERROR. PURE. */
export function mapRepositoryRemoteAnswer(status: number, response: unknown): RepositoryRemoteOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, REPOSITORY_REMOTE_FRAME_KEYS);
  if (record === null || record.outcome !== "REMOTE" || !nonEmptyString(record.readAt)) return invalidResponse();
  if (!boundField(record.boundAt) || !boundField(record.boundBy) || !boundField(record.remoteUrl)) return invalidResponse();
  return Object.freeze({
    boundAt: record.boundAt, boundBy: record.boundBy, readAt: record.readAt,
    remoteUrl: record.remoteUrl, status: "REMOTE" as const,
  });
}

/** POSTs exactly `{}` and maps the reply; `post` is injectable for tests. */
export async function readRepositoryRemote(
  headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>,
): Promise<RepositoryRemoteOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(REPOSITORY_REMOTE_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send("{}");
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_REPOSITORY_REMOTE_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapRepositoryRemoteAnswer(response.status, body);
}
