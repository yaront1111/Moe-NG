/**
 * THE DEPLOYMENT-ENVIRONMENT HEALTH READ CLIENT: POST `/deployments/health/read` with exactly
 * `{environment}`, shaped verbatim into an outcome or a refusal at its own layer. READ ONLY,
 * exact-key snapshots at every level (the discipline of live-ops.ts).
 *
 * IT DERIVES NOTHING. `state` is the daemon's own UP / DEGRADED / DOWN, computed from the probe
 * ring by `deriveHealthState` on the serving side and carried across untouched. A recomputation
 * here would be a second opinion about one history, and the browser is the one an operator sees
 * when the two disagree.
 *
 * EXACT-KEY MEANS REFUSED, NOT IGNORED. A frame carrying a key this client does not expect is
 * rejected rather than silently narrowed, which is what makes a daemon-side shape change red
 * this client's tests instead of reaching production as a plausible blank.
 */

const LAYER = "CONTROL_ROOM_DEPLOYMENTS_HEALTH";
const INVALID_RESPONSE_CODE = "DEPLOYMENTS_HEALTH_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const REQUEST_TIMEOUT_MS = 15_000;

export const DEPLOYMENTS_HEALTH_READ_PATH = "/deployments/health/read";

/** The probe row's own verdict on one attempt. Mirrors `HealthProbe["status"]`. */
export type EnvironmentProbeStatus = "FAILURE" | "SUCCESS" | "UNPROBEABLE";
/** The DAEMON's derived state. This client never computes a member of this union. */
export type EnvironmentHealthState = "DEGRADED" | "DOWN" | "UP";

export interface EnvironmentProbeView {
  readonly at: string;
  readonly latencyMs: number;
  readonly status: EnvironmentProbeStatus;
}
/** The deploy tool's own last line, carried beside the code and layer that recorded it. */
export interface EnvironmentErrorLineView {
  readonly at: string;
  readonly code: string;
  readonly layer: string;
  readonly line: string;
  readonly source: "DEPLOY_RECEIPT";
}
export interface EnvironmentIncidentView {
  readonly id: number;
  readonly openedAt: string;
}
/** Why this environment cannot be probed at all, in the probe row's own code and layer. */
export interface EnvironmentProbeRefusalView {
  readonly code: string;
  readonly layer: string;
}

export interface EnvironmentHealthView {
  readonly status: "DEPLOYMENTS_HEALTH";
  readonly environment: string;
  readonly incident: EnvironmentIncidentView | null;
  readonly lastError: EnvironmentErrorLineView | null;
  readonly lastProbe: EnvironmentProbeView | null;
  readonly probeRefusal: EnvironmentProbeRefusalView | null;
  readonly rollbackSha: string | null;
  readonly state: EnvironmentHealthState;
}

export type DeploymentsHealthOutcome =
  | EnvironmentHealthView
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string };

type Failure = { readonly status: "ERROR"; readonly code: string; readonly layer: string };
type Refusal = { readonly status: "REFUSED"; readonly code: string; readonly layer: string };

const refused = (code: string, layer: string): Refusal =>
  Object.freeze({ code, layer, status: "REFUSED" as const });
const errored = (code: string, layer: string): Failure =>
  Object.freeze({ code, layer, status: "ERROR" as const });
const invalidResponse = (): Failure => errored(INVALID_RESPONSE_CODE, LAYER);

/** An own-enumerable EXACT-key snapshot (copied verbatim from live-ops.ts). */
function exactDataRecord(
  value: unknown, expectedKeys: readonly string[],
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
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The three refusal envelopes this route can answer with. The third, `{code, layer, ok:false}`,
 * is the probe store's own shape and is NOT matched by the shared `effectRefusal` helper, whose
 * key lists stop at `{code, layer}` and `{outcome, code, layer}`. Omitting it here is how
 * PROBE_STORE_UNAVAILABLE would arrive as a generic invalid response with its cause erased.
 */
function refusalFrom(response: unknown): Refusal | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && text(listener.code) && text(listener.layer)) {
    return refused(listener.code, listener.layer);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED" && text(route.code) && text(route.layer)) {
    return refused(route.code, route.layer);
  }
  const store = exactDataRecord(response, ["code", "layer", "ok"]);
  if (store !== null && store.ok === false && text(store.code) && text(store.layer)) {
    return refused(store.code, store.layer);
  }
  return null;
}

function probeOf(value: unknown): EnvironmentProbeView | null {
  if (value === null) return null;
  const row = exactDataRecord(value, ["at", "latencyMs", "status"]);
  if (row === null || !text(row.at) || !count(row.latencyMs)) return null;
  if (row.status !== "FAILURE" && row.status !== "SUCCESS" && row.status !== "UNPROBEABLE") return null;
  return Object.freeze({ at: row.at, latencyMs: row.latencyMs, status: row.status });
}

function errorLineOf(value: unknown): EnvironmentErrorLineView | null {
  if (value === null) return null;
  const row = exactDataRecord(value, ["at", "code", "layer", "line", "source"]);
  if (row === null || !text(row.at) || !text(row.code) || !text(row.layer)
    || typeof row.line !== "string" || row.source !== "DEPLOY_RECEIPT") return null;
  return Object.freeze({
    at: row.at, code: row.code, layer: row.layer, line: row.line, source: "DEPLOY_RECEIPT" as const,
  });
}

function incidentOf(value: unknown): EnvironmentIncidentView | null {
  if (value === null) return null;
  const row = exactDataRecord(value, ["id", "openedAt"]);
  if (row === null || !count(row.id) || !text(row.openedAt)) return null;
  return Object.freeze({ id: row.id, openedAt: row.openedAt });
}

function probeRefusalOf(value: unknown): EnvironmentProbeRefusalView | null {
  if (value === null) return null;
  const row = exactDataRecord(value, ["code", "layer", "ok"]);
  if (row === null || row.ok !== false || !text(row.code) || !text(row.layer)) return null;
  return Object.freeze({ code: row.code, layer: row.layer });
}

/**
 * A NULL MEMBER AND AN UNREADABLE MEMBER ARE DIFFERENT. Every nested decoder above answers null
 * for both, so each one is checked against the raw member here: a malformed `lastProbe` must
 * refuse the whole frame rather than read as "no probe yet", which is what would put a green
 * card in front of an operator whose environment has never answered.
 */
export function mapDeploymentsHealthAnswer(
  status: number, body: unknown,
): DeploymentsHealthOutcome {
  const refusal = refusalFrom(body);
  if (refusal !== null) return refusal;
  const row = exactDataRecord(body, [
    "environment", "incident", "lastError", "lastProbe", "ok", "probeRefusal", "rollbackSha", "state",
  ]);
  if (status !== 200 || row === null || row.ok !== true || !text(row.environment)
    || !nullableText(row.rollbackSha)) return invalidResponse();
  if (row.state !== "DEGRADED" && row.state !== "DOWN" && row.state !== "UP") return invalidResponse();
  const lastProbe = probeOf(row.lastProbe);
  const lastError = errorLineOf(row.lastError);
  const incident = incidentOf(row.incident);
  const probeRefusal = probeRefusalOf(row.probeRefusal);
  if ((lastProbe === null && row.lastProbe !== null) || (lastError === null && row.lastError !== null)
    || (incident === null && row.incident !== null)
    || (probeRefusal === null && row.probeRefusal !== null)) return invalidResponse();
  return Object.freeze({
    environment: row.environment, incident, lastError, lastProbe, probeRefusal,
    rollbackSha: row.rollbackSha, state: row.state, status: "DEPLOYMENTS_HEALTH" as const,
  });
}

/** POSTs exactly `{environment}` to the deployment-health read; `send` is injectable for tests. */
export async function readDeploymentsHealth(
  headers: Readonly<Record<string, string>>,
  environment: string,
  send?: (body: string) => Promise<Response>,
): Promise<DeploymentsHealthOutcome> {
  const payload = JSON.stringify({ environment });
  const doSend = send ?? ((body: string): Promise<Response> => fetch(DEPLOYMENTS_HEALTH_READ_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await doSend(payload);
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LAYER);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return invalidResponse();
  }
  const answer = mapDeploymentsHealthAnswer(response.status, parsed);
  // A frame that answers about ANOTHER environment is not this environment's health. Accepting
  // it would render one environment's green under a different environment's name.
  return answer.status === "DEPLOYMENTS_HEALTH" && answer.environment !== environment
    ? invalidResponse()
    : answer;
}
