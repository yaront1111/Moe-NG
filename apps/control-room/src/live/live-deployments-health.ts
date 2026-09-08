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
/** One plotted observation. NO per-point status: the daemon owns the one opinion, `state`. */
export interface EnvironmentLatencyPointView {
  readonly at: string;
  readonly latencyMs: number;
}
/** The bounded series and the window the DAEMON took it over, newest LAST. */
export interface EnvironmentLatencySeriesView {
  readonly points: readonly EnvironmentLatencyPointView[];
  readonly windowMinutes: number;
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

/** The daemon's rollback binding: which receipt, which image, which commit. */
export interface EnvironmentRollbackTargetView {
  readonly imageDigest: string;
  readonly sha: string;
  readonly toReceiptRef: string;
}

export interface EnvironmentHealthView {
  readonly status: "DEPLOYMENTS_HEALTH";
  readonly environment: string;
  readonly incident: EnvironmentIncidentView | null;
  readonly lastError: EnvironmentErrorLineView | null;
  readonly lastProbe: EnvironmentProbeView | null;
  /**
   * The series a sparkline draws, with the window it was taken over carried BESIDE it. The window
   * is read, never inferred from the instants: an empty series has none to infer from, and a
   * consumer that guessed could not assert it plotted the span the daemon actually windowed.
   */
  readonly latencySeries: EnvironmentLatencySeriesView;
  /**
   * The EFFECTIVE health-probe interval the daemon is running this environment at: its stored
   * value, or the daemon default when none is stored. ALWAYS PRESENT and never null - the daemon
   * resolves stored-or-default before serving, so this client never re-applies a default of its
   * own. Required, not optional: an optional member would let a fixture omit what production
   * always sends, and the fixture would then stop testing the wire.
   */
  readonly probeIntervalMs: number;
  readonly probeRefusal: EnvironmentProbeRefusalView | null;
  /** DISPLAY ONLY: the sha the daemon says sat before this receipt. Never spend it - it is
   *  positional over the raw ledger and can name the deploy running right now. */
  readonly rollbackSha: string | null;
  /**
   * THE ONLY SPENDABLE ROLLBACK AUTHORITY, or null when the daemon has none for this
   * environment. `toReceiptRef` travels VERBATIM into a `deployment.rollback` payload; a card
   * never constructs one from `rollbackSha`. The daemon re-resolves it on every poll and it
   * carries no lease, so a refused dispatch means RE-POLL and spend the fresh tuple.
   */
  readonly rollbackTarget: EnvironmentRollbackTargetView | null;
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
/** The daemon's receipt id: a sha256 hex digest, and the rollback payload's own gate. */
const HEX64 = /^[0-9a-f]{64}$/u;
/** `sha256:<64 hex>`, the form `docker inspect` reports an image digest in. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const hex64 = (value: unknown): value is string => text(value) && HEX64.test(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/**
 * A DURATION, so STRICTLY positive. `count` admits 0, and a zero probe interval rendered as a
 * rate is a busy loop an operator would read as a real setting. `Number.isSafeInteger` already
 * rules out NaN, Infinity and 1.5, so this adds only the lower bound. It deliberately does NOT
 * re-assert the daemon's 5s..1h admission range: that record is the one authority on what an
 * operator may store, and a second copy of the bounds here would refuse a widened range as
 * malformed the day the daemon widened it.
 */
const duration = (value: unknown): value is number => count(value) && value > 0;

/**
 * The most series points this client will accept. The daemon windows the series to an hour out
 * of a ring bounded at 1440 rows, so anything longer than the WHOLE ring cannot be a real answer
 * and is refused rather than rendered. This is a crash guard, not a style rule: the sparkline
 * takes `Math.min(...latencies)`, and spreading an array of a few hundred thousand elements
 * throws `RangeError: Maximum call stack size exceeded` and takes the render down with it.
 */
const MAX_SERIES_POINTS = 1440;

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

/**
 * THE SERIES, AND ITS ONE DIFFERENCE FROM EVERY OTHER NESTED MEMBER HERE. `latencySeries` is
 * never null on the wire: the daemon serves an EMPTY `points` for an environment with no history
 * rather than omitting the member. So a null answer from this decoder means UNREADABLE ONLY, and
 * the top-level check refuses the whole frame - an unreadable series narrowed to "no points yet"
 * would draw an empty chart for an environment whose history simply failed to decode.
 *
 * A single malformed point refuses the WHOLE series rather than being dropped: silently skipping
 * it would plot a gap the operator was never told about. An OVERLONG series is refused for the
 * same fail-closed reason and one concrete one: see `MAX_SERIES_POINTS`.
 */
function latencySeriesOf(value: unknown): EnvironmentLatencySeriesView | null {
  const row = exactDataRecord(value, ["points", "windowMinutes"]);
  if (row === null || !count(row.windowMinutes) || row.windowMinutes === 0) return null;
  if (!Array.isArray(row.points) || row.points.length > MAX_SERIES_POINTS) return null;
  const points: EnvironmentLatencyPointView[] = [];
  for (const raw of row.points as readonly unknown[]) {
    const point = exactDataRecord(raw, ["at", "latencyMs"]);
    if (point === null || !text(point.at) || !count(point.latencyMs)) return null;
    points.push(Object.freeze({ at: point.at, latencyMs: point.latencyMs }));
  }
  return Object.freeze({ points: Object.freeze(points), windowMinutes: row.windowMinutes });
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
 * THE MEMBER AN OPERATOR SPENDS DURING AN INCIDENT, so every field is shape-checked rather than
 * merely present. `toReceiptRef` is the daemon's receipt id and the rollback handler's payload
 * gate is `/^[0-9a-f]{64}$/u`, so anything else could only ever refuse at dispatch; `imageDigest`
 * is docker's own `sha256:<64 hex>`. A malformed member here refuses the WHOLE frame at the
 * caller (see the null-vs-unreadable rule below) rather than reading as "no target", which would
 * hide a spendable control from the one person who needs it.
 */
function rollbackTargetOf(value: unknown): EnvironmentRollbackTargetView | null {
  if (value === null) return null;
  const row = exactDataRecord(value, ["imageDigest", "sha", "toReceiptRef"]);
  if (row === null || !text(row.sha) || !hex64(row.toReceiptRef)
    || typeof row.imageDigest !== "string" || !IMAGE_DIGEST.test(row.imageDigest)) return null;
  return Object.freeze({
    imageDigest: row.imageDigest, sha: row.sha, toReceiptRef: row.toReceiptRef,
  });
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
    "environment", "incident", "lastError", "lastProbe", "latencySeries", "ok",
    "probeIntervalMs", "probeRefusal", "rollbackSha", "rollbackTarget", "state",
  ]);
  // `probeIntervalMs` is checked HERE rather than through a nested decoder because it has no
  // legitimate null: a malformed one must refuse the whole frame, never be dropped to leave a
  // view whose interval silently disappeared.
  if (status !== 200 || row === null || row.ok !== true || !text(row.environment)
    || !duration(row.probeIntervalMs) || !nullableText(row.rollbackSha)) return invalidResponse();
  if (row.state !== "DEGRADED" && row.state !== "DOWN" && row.state !== "UP") return invalidResponse();
  const lastProbe = probeOf(row.lastProbe);
  const lastError = errorLineOf(row.lastError);
  const incident = incidentOf(row.incident);
  const probeRefusal = probeRefusalOf(row.probeRefusal);
  // `latencySeries` has no legitimate null, so ANY null answer refuses the frame outright.
  const latencySeries = latencySeriesOf(row.latencySeries);
  const rollbackTarget = rollbackTargetOf(row.rollbackTarget);
  if ((lastProbe === null && row.lastProbe !== null) || (lastError === null && row.lastError !== null)
    || (incident === null && row.incident !== null) || latencySeries === null
    || (rollbackTarget === null && row.rollbackTarget !== null)
    || (probeRefusal === null && row.probeRefusal !== null)) return invalidResponse();
  return Object.freeze({
    environment: row.environment, incident, lastError, lastProbe, latencySeries,
    probeIntervalMs: row.probeIntervalMs, probeRefusal, rollbackSha: row.rollbackSha,
    rollbackTarget, state: row.state, status: "DEPLOYMENTS_HEALTH" as const,
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
