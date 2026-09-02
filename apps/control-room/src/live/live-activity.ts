/**
 * The ACTIVITY read client: POST /activity/read with EXACTLY `{}` or `{ goalRef }`, shaped
 * verbatim into ACTIVITY / REFUSED / ERROR. READS ONLY; exact-key snapshots at every level.
 */

const LIVE_ACTIVITY_LAYER = "CONTROL_ROOM_LIVE_ACTIVITY";
const INVALID_RESPONSE_CODE = "ACTIVITY_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const ACTIVITY_READ_PATH = "/activity/read";
const REQUEST_TIMEOUT_MS = 15_000;

export interface ActivityEntryView {
  readonly commandKind: string;
  readonly decidedAt: string;
  readonly disposition: "COMMITTED" | "VERSION_CONFLICT";
  readonly principalId: string;
  readonly targetAggregateId: string;
  readonly version: number | null;
}

export type ActivityOutcome =
  | {
    readonly status: "ACTIVITY";
    readonly entries: readonly ActivityEntryView[];
    readonly refusalsRecorded: false;
    readonly scope: { readonly goalId: string | null; readonly targets: number };
    readonly totalDecisions: number;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): ActivityOutcome => Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): ActivityOutcome => Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): ActivityOutcome => errored(INVALID_RESPONSE_CODE, LIVE_ACTIVITY_LAYER);

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

function refusalFrom(response: unknown): ActivityOutcome | null {
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

function entryOf(value: unknown): ActivityEntryView | null {
  const record = exactDataRecord(value, ["commandKind", "decidedAt", "disposition", "principalId", "targetAggregateId", "version"]);
  if (record === null || !nonEmptyString(record.commandKind) || !nonEmptyString(record.decidedAt)
    || (record.disposition !== "COMMITTED" && record.disposition !== "VERSION_CONFLICT")
    || !nonEmptyString(record.principalId) || !nonEmptyString(record.targetAggregateId)
    || !(record.version === null || count(record.version))) return null;
  return Object.freeze({
    commandKind: record.commandKind, decidedAt: record.decidedAt, disposition: record.disposition,
    principalId: record.principalId, targetAggregateId: record.targetAggregateId, version: record.version as number | null,
  });
}

/** Maps only an exact daemon ACTIVITY frame; every other answer is REFUSED or ERROR. PURE. */
export function mapActivityAnswer(status: number, response: unknown): ActivityOutcome {
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, ["entries", "outcome", "refusalsRecorded", "scope", "totalDecisions"]);
  if (record === null || record.outcome !== "ACTIVITY" || record.refusalsRecorded !== false || !count(record.totalDecisions)) return invalidResponse();
  const scope = exactDataRecord(record.scope, ["goalId", "targets"]);
  if (scope === null || !(scope.goalId === null || nonEmptyString(scope.goalId)) || !count(scope.targets)) return invalidResponse();
  if (!Array.isArray(record.entries)) return invalidResponse();
  const entries: ActivityEntryView[] = [];
  for (const raw of record.entries) {
    const entry = entryOf(raw);
    if (entry === null) return invalidResponse();
    entries.push(entry);
  }
  return Object.freeze({
    entries: Object.freeze(entries), refusalsRecorded: false as const,
    scope: Object.freeze({ goalId: scope.goalId as string | null, targets: scope.targets }),
    status: "ACTIVITY" as const, totalDecisions: record.totalDecisions,
  });
}

/** POSTs exactly `{}` or `{ goalRef }` and maps the reply; `post` is injectable for tests. */
export async function readActivity(
  headers: Readonly<Record<string, string>>, goalRef: string | null, post?: (body: string) => Promise<Response>,
): Promise<ActivityOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(ACTIVITY_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(goalRef === null ? "{}" : JSON.stringify({ goalRef }));
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_ACTIVITY_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapActivityAnswer(response.status, body);
}
