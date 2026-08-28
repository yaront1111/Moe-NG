import { admitByWireProtocol, createControlRoomTransport } from "@moe/control-room-client";
import type { FetchLike } from "@moe/control-room-client";
import { LIVE_PROJECTION, LIVE_SUBSCRIBER } from "./live-config.js";
import type { LiveConfigRefusalCode, LiveRefused, LiveSetupResult } from "./live-config.js";

/** Inputs remain caller-owned; no credential or pairing identity is persisted here. */
export interface HandshakeInput {
  readonly fetchImpl: FetchLike;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface LivePairingPending {
  claim(): Promise<LiveHandshakeResult>;
  readonly confirmationLabel: string;
  readonly status: "AWAITING_OPERATOR";
}
/**
 * The daemon runs with no terminal it can read a pairing label from. This is a
 * factual, non-authoritative runtime state rather than a refusal, so it carries no
 * claim, no label and no request id - nothing here can be mistaken for authority.
 */
export interface LiveOperatorChannelUnavailable {
  readonly status: "OPERATOR_CHANNEL_UNAVAILABLE";
}

export type LiveHandshakeResult =
  | LiveOperatorChannelUnavailable | LivePairingPending | LiveSetupResult;
type CompatGate = Extract<ReturnType<typeof admitByWireProtocol>, { readonly ok: true }>;
type LiveSetup = Extract<LiveSetupResult, { readonly ok: true }>;

interface BootstrapContext {
  readonly client: CompatGate["client"];
  readonly csrfToken: string;
  readonly projectId: string;
  readonly protocolVersion: string;
}
interface JsonResult {
  readonly body: unknown;
  readonly response: Response;
}

const CONFIRMATION_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;
const REQUEST_ID = /^[0-9a-f]{64}$/u;
const SAFE_DAEMON_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UNREADABLE_BODY = Symbol("unreadable-body");
const RETRY_CLAIM = Symbol("retry-claim");
/**
 * Terminal availability is stated on this RESPONSE HEADER, deliberately kept out of
 * the compatibility-frozen `[confirmationLabel, ok, requestId]` pairing body. Only
 * the exact strings below are admitted: an absent, duplicated (WHATWG Headers
 * comma-joins repeats), or otherwise-spelled value gains no terminal authority and
 * is refused at this boundary rather than defaulted to available.
 */
const OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel";
const OPERATOR_CHANNEL_AVAILABLE = "true";
const OPERATOR_CHANNEL_UNAVAILABLE_HEADER = "false";
const OPERATOR_CHANNEL_UNAVAILABLE: LiveOperatorChannelUnavailable = Object.freeze({
  status: "OPERATOR_CHANNEL_UNAVAILABLE" as const,
});
const MAX_TIMEOUT_MS = 2_147_483_647;
export const LIVE_HANDSHAKE_REQUEST_TIMEOUT_MS = 15_000;
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value)
    && Number.isFinite(Date.parse(value));
}
function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function refused(code: LiveConfigRefusalCode, detail: string): LiveRefused {
  return Object.freeze({ code, detail, ok: false } as const);
}
async function fetchJson(
  fetchImpl: FetchLike,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<JsonResult> {
  const response = await fetchImpl(path, { ...init, signal });
  try { return { body: await response.json(), response }; }
  catch { return { body: UNREADABLE_BODY, response }; }
}

async function boundedJson(
  input: HandshakeInput,
  timeoutMs: number,
  path: string,
  init: RequestInit,
): Promise<JsonResult> {
  if (input.signal?.aborted === true) throw new Error("handshake request cancelled");
  const controller = new AbortController();
  const relayAbort = (): void => { controller.abort(); };
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => { reject(new Error("handshake request cancelled")); };
  });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(relayAbort, timeoutMs);
  const operation = fetchJson(input.fetchImpl, path, init, controller.signal);
  void operation.catch(() => undefined);
  try { return await Promise.race([operation, aborted]); }
  finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", relayAbort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
function daemonTokens(body: unknown): string {
  if (!isPlainObject(body)) return "";
  const tokens: string[] = [];
  for (const key of ["code", "layer"] as const) {
    const value = body[key];
    if (typeof value === "string" && SAFE_DAEMON_TOKEN.test(value)) {
      tokens.push(`${key} ${value}`);
    }
  }
  return tokens.length === 0 ? "" : `; ${tokens.join("; ")}`;
}

function statusDetail(prefix: string, result: JsonResult): string {
  return `${prefix} (status ${result.response.status}${daemonTokens(result.body)})`;
}
async function readBootstrap(
  input: HandshakeInput,
  timeoutMs: number,
): Promise<BootstrapContext | LiveRefused> {
  let result: JsonResult;
  try { result = await boundedJson(input, timeoutMs, "/bootstrap", { method: "GET" }); }
  catch { return refused("LIVE_BOOTSTRAP_UNAVAILABLE", "daemon bootstrap unavailable"); }
  if (!result.response.ok) {
    return refused("LIVE_BOOTSTRAP_UNAVAILABLE", statusDetail("daemon bootstrap unavailable", result));
  }
  const body = result.body;
  if (!isPlainObject(body) || !isNonEmptyString(body["csrfToken"])
    || !isNonEmptyString(body["projectId"]) || !isNonEmptyString(body["protocolVersion"])) {
    return refused("LIVE_BOOTSTRAP_UNAVAILABLE", statusDetail("daemon bootstrap unavailable", result));
  }
  const gate = admitByWireProtocol(body["protocolVersion"]);
  if (!gate.ok) {
    return refused("LIVE_COMPAT_REFUSED", `compat gate refused for daemon protocol ${body["protocolVersion"]}`);
  }
  return {
    client: gate.client, csrfToken: body["csrfToken"], projectId: body["projectId"],
    protocolVersion: body["protocolVersion"],
  };
}

function makeSetup(context: BootstrapContext, input: HandshakeInput, credential: string): LiveSetup {
  const transport = createControlRoomTransport({
    csrfToken: context.csrfToken, fetch: input.fetchImpl, origin: "",
    sessionCredential: credential, wireProtocolVersion: context.protocolVersion,
  });
  return Object.freeze({
    client: context.client,
    headers: Object.freeze({
      "content-type": "application/json", "x-moe-csrf": context.csrfToken,
      "x-moe-protocol-version": context.protocolVersion,
      "x-moe-session-credential": credential,
    }),
    ok: true, projectId: context.projectId, projection: LIVE_PROJECTION,
    sessionCredential: credential, subscriberId: LIVE_SUBSCRIBER, transport,
  } as const);
}
async function claimSession(
  input: HandshakeInput,
  timeoutMs: number,
  context: BootstrapContext,
  requestId: string,
): Promise<LiveSetupResult | typeof RETRY_CLAIM> {
  let result: JsonResult;
  try {
    result = await boundedJson(input, timeoutMs, "/session/pair/claim", {
      body: JSON.stringify({ requestId }), headers: pairingHeaders(context), method: "POST",
    });
  } catch { return refused("LIVE_PAIRING_REFUSED", "session pairing refused"); }
  const body = result.body;
  if (!result.response.ok) {
    if (result.response.status === 409 && isPlainObject(body)
      && (body["code"] === "PAIRING_APPROVAL_REQUIRED" || body["code"] === "PAIRING_REQUEST_BUSY")) {
      return RETRY_CLAIM;
    }
    return refused("LIVE_PAIRING_REFUSED", statusDetail("session pairing refused", result));
  }
  if (!isPlainObject(body) || !exactKeys(body, [
    "capabilities", "expiresAt", "ok", "projectId", "protocolVersion", "sessionCredential",
  ]) || body["ok"] !== true || body["protocolVersion"] !== context.protocolVersion
    || !Array.isArray(body["capabilities"]) || body["capabilities"].length === 0
    || !body["capabilities"].every(isNonBlankString)
    || !isIsoInstant(body["expiresAt"])
    || !isNonBlankString(body["sessionCredential"])) {
    return refused("LIVE_PAIRING_REFUSED", "session pairing refused");
  }
  if (!isNonEmptyString(body["projectId"]) || body["projectId"] !== context.projectId) {
    return refused("LIVE_PAIRING_REFUSED", "session pairing project mismatch");
  }
  return makeSetup(context, input, body["sessionCredential"]);
}

function pairingHeaders(context: BootstrapContext): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json", "x-moe-csrf": context.csrfToken,
    "x-moe-protocol-version": context.protocolVersion,
  };
}
function createPending(
  input: HandshakeInput,
  timeoutMs: number,
  context: BootstrapContext,
  confirmationLabel: string,
  requestId: string,
): LivePairingPending {
  let active: Promise<LiveHandshakeResult> | null = null;
  let settled: LiveSetup | null = null;
  let pending!: LivePairingPending;
  const claim = (): Promise<LiveHandshakeResult> => {
    if (settled !== null) return Promise.resolve(settled);
    if (active !== null) return active;
    active = claimSession(input, timeoutMs, context, requestId).then((result) => {
      if (result === RETRY_CLAIM) return pending;
      if (result.ok) settled = result;
      return result;
    }).finally(() => { active = null; });
    return active;
  };
  pending = Object.freeze({ claim, confirmationLabel, status: "AWAITING_OPERATOR" as const });
  return pending;
}

async function requestPairing(
  input: HandshakeInput,
  timeoutMs: number,
  context: BootstrapContext,
): Promise<LiveHandshakeResult> {
  let result: JsonResult;
  try {
    result = await boundedJson(input, timeoutMs, "/session/pair/request", {
      body: "{}", headers: pairingHeaders(context), method: "POST",
    });
  } catch { return refused("LIVE_PAIRING_REFUSED", "pairing request refused"); }
  if (!result.response.ok) {
    return refused("LIVE_PAIRING_REFUSED", statusDetail("pairing request refused", result));
  }
  const operatorChannel = result.response.headers.get(OPERATOR_CHANNEL_HEADER);
  if (operatorChannel !== OPERATOR_CHANNEL_AVAILABLE) {
    return operatorChannel === OPERATOR_CHANNEL_UNAVAILABLE_HEADER
      ? OPERATOR_CHANNEL_UNAVAILABLE
      : refused("LIVE_PAIRING_REFUSED", "pairing request refused");
  }
  const body = result.body;
  if (!isPlainObject(body) || !exactKeys(body, ["confirmationLabel", "ok", "requestId"])
    || body["ok"] !== true || typeof body["confirmationLabel"] !== "string"
    || !CONFIRMATION_LABEL.test(body["confirmationLabel"])
    || typeof body["requestId"] !== "string" || !REQUEST_ID.test(body["requestId"])) {
    return refused("LIVE_PAIRING_REFUSED", "pairing request refused");
  }
  return createPending(input, timeoutMs, context, body["confirmationLabel"], body["requestId"]);
}
function isValidTimeout(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

export async function resolveLiveSetupFromHandshake(
  input: HandshakeInput,
): Promise<LiveHandshakeResult> {
  const timeoutMs = input.requestTimeoutMs ?? LIVE_HANDSHAKE_REQUEST_TIMEOUT_MS;
  if (!isValidTimeout(timeoutMs)) {
    return refused("LIVE_BOOTSTRAP_UNAVAILABLE", "invalid handshake request timeout");
  }
  const context = await readBootstrap(input, timeoutMs);
  if ("ok" in context) return context;
  return requestPairing(input, timeoutMs, context);
}
