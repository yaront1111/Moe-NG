/**
 * The PRD a goal binds: POST /goals/source/read with `{ goalRef }`, answered by the daemon's
 * own full-text reader (the same projection the planning agent compiles from). The text is
 * shown as the daemon stored it; a goal without a source refuses by name and the panel says
 * so instead of inventing a document.
 */

const LIVE_GOAL_SOURCE_LAYER = "CONTROL_ROOM_LIVE_GOAL_SOURCE";
const INVALID_RESPONSE_CODE = "GOAL_SOURCE_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const GOAL_SOURCE_READ_PATH = "/goals/source/read";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GoalSourceView {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly sourceRef: string;
  readonly text: string;
}

export type GoalSourceOutcome =
  | ({ readonly status: "GOAL_SOURCE" } & GoalSourceView)
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): GoalSourceOutcome => Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): GoalSourceOutcome => Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): GoalSourceOutcome => errored(INVALID_RESPONSE_CODE, LIVE_GOAL_SOURCE_LAYER);

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

function refusalFrom(response: unknown): GoalSourceOutcome | null {
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

/** Maps only an exact daemon GOAL_SOURCE frame; every other answer is REFUSED or ERROR. PURE. */
export function mapGoalSourceAnswer(status: number, response: unknown): GoalSourceOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, [
    "byteLength", "contentSha256", "displayPath", "mediaType", "outcome", "sourceRef", "text",
  ]);
  if (record === null || record.outcome !== "GOAL_SOURCE" || !count(record.byteLength)
    || !nonEmptyString(record.contentSha256) || !nonEmptyString(record.displayPath) || !nonEmptyString(record.mediaType)
    || !nonEmptyString(record.sourceRef) || typeof record.text !== "string") return invalidResponse();
  return Object.freeze({
    byteLength: record.byteLength, contentSha256: record.contentSha256, displayPath: record.displayPath,
    mediaType: record.mediaType, sourceRef: record.sourceRef, status: "GOAL_SOURCE" as const, text: record.text,
  });
}

/** POSTs exactly `{ goalRef }` and maps the reply; `post` is injectable for tests. */
export async function readGoalSource(
  headers: Readonly<Record<string, string>>, goalRef: string, post?: (body: string) => Promise<Response>,
): Promise<GoalSourceOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(GOAL_SOURCE_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(JSON.stringify({ goalRef }));
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_GOAL_SOURCE_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapGoalSourceAnswer(response.status, body);
}
