import { MAX_JSON_BODY_BYTES, createRuntimeError } from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";

/**
 * The refusals the HTTP adapter runs BEFORE the SDK transport is reached, and the stable
 * responses they are rendered as. Everything here is pure: it reads a `Request` or a decoded
 * body and returns a verdict, and it owns no session, no registry, and no dispatch. The
 * adapter keeps that authority — this module only tells it what to refuse.
 *
 * Split out of `http-server.ts` because that file had grown past this repository's
 * split-before-400 bound; the ordering guarantee it documents ("every refusal precedes
 * dispatch") is unchanged, and so is each helper's behaviour.
 */

/** Loopback is the whole allowlist: this endpoint is not meant to be reachable off-host. */
export const LOOPBACK_HOSTNAMES: readonly string[] = Object.freeze([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

/**
 * Renders a refusal as a JSON-RPC error. `status` overrides the registry's HTTP status only for
 * transport-routing facts the registry does not model — an unroutable session id (404) and an
 * undefined method (405) — never for an authority decision.
 */
export function errorResponse(error: RuntimeError, status?: number): Response {
  return new Response(
    JSON.stringify({
      error: { code: error.transport.mcpCode, data: error, message: error.code },
      id: null,
      jsonrpc: "2.0",
    }),
    {
      headers: { "content-type": "application/json" },
      status: status ?? error.transport.httpStatus,
    },
  );
}

export function refusalResponse(
  code: "CAPABILITY_DENIED" | "INPUT_INVALID",
  status?: number,
): Response {
  return errorResponse(createRuntimeError({ code }), status);
}

const LOOPBACK_AUTHORITY_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]+))?$/i;

function isLoopbackAuthority(value: string): boolean {
  const match = LOOPBACK_AUTHORITY_PATTERN.exec(value);
  if (match === null) return false;
  const port = match[2];
  return port === undefined || Number(port) <= 65_535;
}

/**
 * Strict Host and Origin screening, owned by this adapter rather than delegated. The SDK's
 * equivalent defaults to OFF, its options are deprecated, and it cannot express "any loopback
 * port". Refusing here also guarantees the refusal precedes every dispatch.
 */
export function loopbackRefusal(request: Request): Response | undefined {
  const host = request.headers.get("host");
  if (host === null || !isLoopbackAuthority(host)) return refusalResponse("CAPABILITY_DENIED");
  const origin = request.headers.get("origin");
  if (origin === null) return undefined;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return refusalResponse("CAPABILITY_DENIED");
  }
  return isLoopbackAuthority(originHost) ? undefined : refusalResponse("CAPABILITY_DENIED");
}

function limitRefusal(): Response {
  return errorResponse(
    createRuntimeError({
      code: "INPUT_LIMIT_EXCEEDED",
      details: { limitBytes: MAX_JSON_BODY_BYTES, limitName: "httpJsonBody" },
    }),
  );
}

export type BoundedBody =
  | { readonly ok: false; readonly response: Response }
  | { readonly ok: true; readonly value: unknown };

/**
 * Reads at most `MAX_JSON_BODY_BYTES` and cancels the stream the moment the cap is passed, so a
 * hostile body is never fully buffered. Buffering first and measuring afterwards would let a
 * chunked request with no `Content-Length` consume memory the bound is supposed to deny.
 */
async function readCappedBytes(request: Request): Promise<Uint8Array | undefined> {
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true) break;
    total += value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The SDK parses the body with no size bound at all, so the adapter reads it first under a hard
 * cap and hands the parsed value over via `parsedBody`; the transport then never re-reads it.
 * A declared over-large `Content-Length` is refused before a single byte is read.
 */
export async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_JSON_BODY_BYTES) {
    return { ok: false, response: limitRefusal() };
  }
  const bytes = await readCappedBytes(request);
  if (bytes === undefined) return { ok: false, response: limitRefusal() };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, response: refusalResponse("INPUT_INVALID") };
  }
}

export function isInitializePayload(value: unknown): boolean {
  const messages = Array.isArray(value) ? value : [value];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { method?: unknown }).method === "initialize",
  );
}

/**
 * The verdict of `screenRequestIds`. `accepted` is the body's DISTINCT request ids, and it is
 * present only on acceptance — there is no shape in which a caller can read ids out of a
 * refusal and register them anyway.
 */
export type RequestIdScreen =
  | { readonly accepted: readonly (number | string)[]; readonly ok: true }
  | { readonly ok: false };

const REQUEST_IDS_REFUSED: RequestIdScreen = Object.freeze({ ok: false });

/**
 * Screens the correlatable ids of a decoded body in ONE pass, against the ids this session is
 * already serving AND against the rest of the same body.
 *
 * WHY BOTH. The SDK maps each pending request to its response stream by bare `message.id`, so a
 * repeated id OVERWRITES the earlier mapping: one result is delivered under the wrong request
 * and the other pends until the session closes. A cross-POST screen alone cannot see the
 * within-batch case, because at the moment a batch is screened its own repeated id is in flight
 * nowhere — both members pass the in-flight test and both dispatch.
 *
 * Only a message carrying BOTH an id and a method is a request. A response (no method) and a
 * notification (no id, or `id: null`, which is not a correlatable id) never enter the SDK's
 * stream mapping, so neither is screened and neither can collide. Numeric and string ids are
 * compared as themselves, so `1` and `"1"` remain distinct.
 *
 * PURE. `inflight` is read-only here and nothing is registered: the caller adds the accepted
 * ids only after the WHOLE body has proved unique and disjoint, so a refusal can never leave a
 * partially registered batch behind.
 */
export function screenRequestIds(
  value: unknown,
  inflight: ReadonlySet<number | string>,
): RequestIdScreen {
  const messages = Array.isArray(value) ? value : [value];
  const seen = new Set<number | string>();
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { id, method } = message as { id?: unknown; method?: unknown };
    if (typeof method !== "string") continue;
    if (typeof id !== "number" && typeof id !== "string") continue;
    if (seen.has(id) || inflight.has(id)) return REQUEST_IDS_REFUSED;
    seen.add(id);
  }
  return Object.freeze({ accepted: Object.freeze([...seen]), ok: true });
}
