/**
 * THE REQUIRED-VS-SET VARIABLE READ CLIENT: POST `/environments/read` with exactly
 * `{environment}`, decoded EXACT-KEY at every level into rows the Environments screen renders.
 *
 * A VALUE NEVER CROSSES THIS SEAM, AND THIS CLIENT REFUSES ONE RATHER THAN CARRYING IT. The
 * daemon's read side derives each fingerprint from the authenticated plaintext and drops it
 * (`environment-projection.ts` `projectEnvironmentVariables`), so no value should arrive here at
 * all. What this module must not do is become the place one gets through: a row carrying a
 * value-shaped key answers its OWN code, `ENVIRONMENT_VARIABLES_VALUE_PRESENT`, rather than the
 * generic shape refusal. A distinct code is load-bearing rather than tidy - collapsing it into
 * `ENVIRONMENT_VARIABLES_RESPONSE_INVALID` would make the arm that guards it satisfiable by any
 * unrelated shape drift, and the one property this whole slice exists to hold would then be
 * guarded by a test that cannot fail for the right reason.
 *
 * EXACT-KEY MEANS REFUSED, NOT IGNORED. An unknown key and a missing key both refuse, so a
 * daemon-side shape change reds this client's tests instead of reaching an operator as a
 * plausible blank table. The snapshot helper is the one copied across `live-ops.ts` and
 * `live-deployments-health.ts`; it is duplicated rather than shared for the reason those modules
 * state - a shared decoder is a single edit away from widening every read at once.
 *
 * NOTHING IS RETAINED. No storage, no module-level cache, no memo of anything submitted. The
 * screen's test asserts that against this file's own source text.
 */

import { exactDataRecord } from "./live-wire-primitives.js";

const LAYER = "CONTROL_ROOM_ENVIRONMENT_VARIABLES";
const INVALID_RESPONSE_CODE = "ENVIRONMENT_VARIABLES_RESPONSE_INVALID";
const VALUE_PRESENT_CODE = "ENVIRONMENT_VARIABLES_VALUE_PRESENT";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const REQUEST_TIMEOUT_MS = 15_000;

export const ENVIRONMENTS_READ_PATH = "/environments/read";

/**
 * The four keys `EnvironmentVariableRead` carries and no others
 * (`apps/daemon/src/environment/environment-contracts.ts` `ENVIRONMENT_VARIABLE_READ_KEYS`).
 * Restated here because this side must refuse a fifth, and a roster imported from the producer
 * would widen the moment the producer did.
 */
export const ENVIRONMENT_VARIABLE_ROW_KEYS: readonly string[] = Object.freeze([
  "fingerprintSha256", "isSet", "name", "updatedAt",
]);

/**
 * Any key that could carry a secret. Checked BEFORE the exact-key read so the answer names the
 * leak rather than the arity. Broader than `value` on purpose: a future `plaintext` or `secret`
 * slot is the same defect wearing a different name.
 */
const VALUE_SHAPED_KEYS: readonly string[] = Object.freeze([
  "cipher", "plaintext", "secret", "sealed", "value",
]);

export interface EnvironmentVariableRow {
  /** The FULL sha256 of the value's bytes. Never a prefix of the value itself. */
  readonly fingerprintSha256: string;
  readonly isSet: true;
  readonly name: string;
  readonly updatedAt: string;
}

export interface EnvironmentVariablesView {
  readonly status: "ENVIRONMENT_VARIABLES";
  readonly environment: string;
  readonly variables: readonly EnvironmentVariableRow[];
}

/** The refusing authority's OWN code, layer and fixed detail, never summarised or restamped. */
export interface EnvironmentVariablesRefusal {
  readonly status: "REFUSED";
  readonly code: string;
  readonly detail: string | null;
  readonly layer: string;
}

export interface EnvironmentVariablesError {
  readonly status: "ERROR";
  readonly code: string;
  readonly layer: string;
}

export type EnvironmentVariablesOutcome =
  | EnvironmentVariablesError
  | EnvironmentVariablesRefusal
  | EnvironmentVariablesView;

const refused = (
  code: string, layer: string, detail: string | null,
): EnvironmentVariablesRefusal => Object.freeze({ code, detail, layer, status: "REFUSED" as const });

const errored = (code: string, layer: string): EnvironmentVariablesError =>
  Object.freeze({ code, layer, status: "ERROR" as const });

const invalidResponse = (): EnvironmentVariablesError => errored(INVALID_RESPONSE_CODE, LAYER);

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** True when ANY row, at any depth this client reads, carries a key a value could ride on. */
export function carriesValueShapedKey(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  if (Array.isArray(body)) return body.some((entry) => carriesValueShapedKey(entry));
  return Object.keys(body).some((key) => VALUE_SHAPED_KEYS.includes(key)
    || carriesValueShapedKey((body as Record<string, unknown>)[key]));
}

/** One own data property's value, read without touching a getter; `undefined` when absent. */
function ownValue(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The five refusal envelopes this route answers with, each at exact arity so none can shadow
 * another: the store's own `{code, detail, layer, ok}` at 200; the listener's `{code, layer}` at
 * 400/503; the route's own `{code, layer, outcome}` at 200 for a session without ADMIN
 * (apps/daemon/src/http/environments-read.ts:54-58,111-115); the authenticator's PORT_REFUSED
 * frame for a replayed session and HttpRefused for an expired credential or a protocol mismatch
 * (http-command-ingress.ts:73-81,89-111, forwarded whole at environments-read.ts:106-108). The
 * store shape is matched FIRST and kept whole - its `detail` is the fixed prose an operator acts
 * on, and dropping it would leave ENV_STORE_KEY_UNAVAILABLE as a bare code nobody can fix. The
 * port refusal's `detail` and `layer` are kept for the same reason: they name the authority that
 * refused (IDENTITY), which the transport `stage` alone does not.
 */
function refusalFrom(response: unknown): EnvironmentVariablesRefusal | null {
  const store = exactDataRecord(response, ["code", "detail", "layer", "ok"]);
  if (store !== null && store.ok === false && text(store.code) && text(store.layer)) {
    return refused(store.code, store.layer, text(store.detail) ? store.detail : null);
  }
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && text(listener.code) && text(listener.layer)) {
    return refused(listener.code, listener.layer, null);
  }
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED" && text(route.code) && text(route.layer)) {
    return refused(route.code, route.layer, null);
  }
  const port = exactDataRecord(response, ["httpStatus", "ok", "outcome", "refusal", "stage"]);
  if (port !== null && port.ok === false && port.outcome === "PORT_REFUSED" && text(port.stage)) {
    const code = ownValue(port.refusal, "code");
    const layer = ownValue(port.refusal, "layer");
    const detail = ownValue(port.refusal, "detail");
    return text(code) ? refused(code, text(layer) ? layer : port.stage, text(detail) ? detail : null) : null;
  }
  const http = exactDataRecord(response, ["error", "httpStatus", "ok", "outcome", "stage"]);
  if (http !== null && http.ok === false && http.outcome === "REFUSED" && text(http.stage)) {
    const code = ownValue(http.error, "code");
    return text(code) ? refused(code, http.stage, null) : null;
  }
  return null;
}

function rowOf(value: unknown): EnvironmentVariableRow | null {
  const row = exactDataRecord(value, ENVIRONMENT_VARIABLE_ROW_KEYS);
  if (row === null || row.isSet !== true || !text(row.fingerprintSha256)
    || !text(row.name) || !text(row.updatedAt)) return null;
  return Object.freeze({
    fingerprintSha256: row.fingerprintSha256, isSet: true as const,
    name: row.name, updatedAt: row.updatedAt,
  });
}

/**
 * A LEAKED VALUE IS NOT MERELY A MALFORMED FRAME. The value check runs before the shape read and
 * before the refusal read, because a refusal envelope that grew a value slot is the same leak
 * and would otherwise be forwarded to the screen intact.
 */
export function mapEnvironmentVariablesAnswer(
  status: number, body: unknown,
): EnvironmentVariablesOutcome {
  if (carriesValueShapedKey(body)) return errored(VALUE_PRESENT_CODE, LAYER);
  const refusal = refusalFrom(body);
  if (refusal !== null) return refusal;
  const frame = exactDataRecord(body, ["environment", "ok", "variables"]);
  if (status !== 200 || frame === null || frame.ok !== true || !text(frame.environment)
    || !Array.isArray(frame.variables)) return invalidResponse();
  const variables: EnvironmentVariableRow[] = [];
  for (const entry of frame.variables) {
    const row = rowOf(entry);
    if (row === null) return invalidResponse();
    variables.push(row);
  }
  return Object.freeze({
    environment: frame.environment, status: "ENVIRONMENT_VARIABLES" as const,
    variables: Object.freeze(variables),
  });
}

/** POSTs exactly `{environment}`; `send` is injectable so a test drives it without a fetch stub. */
export async function readEnvironmentVariables(
  headers: Readonly<Record<string, string>>,
  environment: string,
  send?: (body: string) => Promise<Response>,
): Promise<EnvironmentVariablesOutcome> {
  const payload = JSON.stringify({ environment });
  const doSend = send ?? ((body: string): Promise<Response> => fetch(ENVIRONMENTS_READ_PATH, {
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
  const answer = mapEnvironmentVariablesAnswer(response.status, parsed);
  // A frame that answers about ANOTHER environment is not this environment's table. Accepting it
  // would render production's set variables under the word preview.
  return answer.status === "ENVIRONMENT_VARIABLES" && answer.environment !== environment
    ? invalidResponse()
    : answer;
}
