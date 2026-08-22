import type { IncomingMessage } from "node:http";

import { HTTP_INPUT_BOUNDS } from "./http-contract.js";

/**
 * The checks the committed adapter cannot make.
 *
 * `handleCommandRequest` begins at `authenticate` and never sees a header, so
 * Host, Origin, CSRF, the bind interface and the body bound belong to the
 * socket layer or to nobody. They live here rather than beside the routing so
 * neither module grows past its size target.
 */
export const CONTROL_ROOM_LISTENER_LAYER = "CONTROL_ROOM_LISTENER" as const;

/**
 * Every refusal this layer can emit. Frozen and closed so a consumer can switch
 * exhaustively; a code produced here but absent from this list is a defect.
 */
export const LISTENER_REFUSAL_CODES = Object.freeze([
  "LISTENER_AFFORDANCE_REQUEST_INVALID",
  "LISTENER_AFFORDANCES_UNAVAILABLE",
  // The static host's eleven, each naming ONE way a path stops being an asset
  // under the root. They are separate codes because an operator fixes a
  // misspelled root, a missing file and an attempted escape differently. Two of
  // them refuse the START rather than a request: ROOT_INVALID (no such
  // directory, or one that is not a bundle) and ROOT_LEAKS_SECRET (a servable
  // file carries this daemon's credential or CSRF token).
  "LISTENER_ASSET_ENCODING_INVALID",
  "LISTENER_ASSET_METHOD_INVALID",
  "LISTENER_ASSET_NOT_FOUND",
  "LISTENER_ASSET_OUTSIDE_ROOT",
  "LISTENER_ASSET_PATH_TRAVERSAL",
  "LISTENER_ASSET_READ_FAILED",
  "LISTENER_ASSET_ROOT_INVALID",
  "LISTENER_ASSET_ROOT_LEAKS_SECRET",
  "LISTENER_ASSET_SEGMENT_INVALID",
  "LISTENER_ASSET_TOO_LARGE",
  "LISTENER_ASSET_TYPE_UNKNOWN",
  "LISTENER_BODY_TOO_LARGE",
  "LISTENER_CSRF_INVALID",
  "LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID",
  "LISTENER_DOCUMENT_DOSSIER_UNAVAILABLE",
  "LISTENER_GRAPH_REQUEST_INVALID",
  "LISTENER_HOST_INVALID",
  "LISTENER_NON_LOOPBACK_BIND",
  "LISTENER_ORIGIN_INVALID",
  "LISTENER_REQUEST_FAILED",
  "LISTENER_ROUTE_UNKNOWN",
  "LISTENER_BIND_FAILED",
  "LISTENER_STREAM_REQUEST_INVALID",
  "LISTENER_STREAM_UNAVAILABLE",
] as const);

export type ListenerRefusalCode = (typeof LISTENER_REFUSAL_CODES)[number];

export interface ListenerRefused {
  readonly code: ListenerRefusalCode;
  /**
   * A START refusal's operator-facing reason, carried IN PROCESS to the entry's
   * log line: the path the static host could not prove, never a secret. Absent
   * on every request refusal - `refuseRequest` writes code and layer only - so
   * this field never reaches the wire.
   */
  readonly detail?: string;
  readonly layer: typeof CONTROL_ROOM_LISTENER_LAYER;
  readonly ok: false;
}

/** Only these may be bound. A hostname is not accepted: it could resolve off-loopback. */
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1"]);

/** The header the credential travels in. Never a query parameter (design 19.2). */
export const CREDENTIAL_HEADER = "x-moe-session-credential";
export const CSRF_HEADER = "x-moe-csrf";
export const PROTOCOL_VERSION_HEADER = "x-moe-protocol-version";

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

/**
 * The authority a caller must present in `Host`. An IPv6 literal is BRACKETED,
 * per RFC 3986: a `::1` bind whose expected authority were `::1:port` would
 * match no real client's Host header, so every request would refuse and the
 * listener would look bound but be unreachable.
 */
export function authorityOf(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function originOf(host: string, port: number): string {
  return `http://${authorityOf(host, port)}`;
}

export function refuse(code: ListenerRefusalCode, detail?: string): ListenerRefused {
  return Object.freeze({
    code,
    ...(detail === undefined ? {} : { detail }),
    layer: CONTROL_ROOM_LISTENER_LAYER,
    ok: false,
  } as const);
}

export function statusFor(code: ListenerRefusalCode): number {
  if (code === "LISTENER_AFFORDANCE_REQUEST_INVALID") return 400;
  if (code === "LISTENER_AFFORDANCES_UNAVAILABLE") return 503;
  if (code === "LISTENER_ASSET_ENCODING_INVALID") return 400;
  if (code === "LISTENER_ASSET_METHOD_INVALID") return 405;
  if (code === "LISTENER_ASSET_NOT_FOUND") return 404;
  if (code === "LISTENER_ASSET_READ_FAILED") return 500;
  // Named rather than defaulted so the ceiling is visible here: the file exists,
  // is under the root and is the type it claims, and this host still refuses to
  // publish it. A 403 because that is a refusal to publish, not a missing file
  // and not a client fault to retry.
  if (code === "LISTENER_ASSET_TOO_LARGE") return 403;
  if (code === "LISTENER_ASSET_TYPE_UNKNOWN") return 415;
  // The remaining asset codes - OUTSIDE_ROOT, PATH_TRAVERSAL, SEGMENT_INVALID,
  // ROOT_INVALID and ROOT_LEAKS_SECRET - take the 403 default deliberately: each
  // one is a request for something outside what this host may publish, and 404
  // would turn the status itself into an oracle for what exists beyond the root.
  if (code === "LISTENER_BODY_TOO_LARGE") return 413;
  if (code === "LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID") return 400;
  if (code === "LISTENER_DOCUMENT_DOSSIER_UNAVAILABLE") return 503;
  if (code === "LISTENER_GRAPH_REQUEST_INVALID") return 400;
  if (code === "LISTENER_REQUEST_FAILED") return 500;
  if (code === "LISTENER_ROUTE_UNKNOWN") return 404;
  if (code === "LISTENER_STREAM_REQUEST_INVALID") return 400;
  if (code === "LISTENER_STREAM_UNAVAILABLE") return 503;
  return 403;
}

/**
 * Reads the body while enforcing the committed bound, and STOPS at the limit
 * rather than buffering the whole payload first — a limit enforced only after
 * the bytes are already in memory is not a limit.
 *
 * Returns BYTES, not text: `decodeRuntimeCommandEnvelopeBytes` refuses anything
 * that is not a `Uint8Array` with `JSON_INPUT_TYPE_INVALID`, so handing it a
 * string would refuse every well-formed request at the decode stage.
 */
export async function readBoundedBody(request: IncomingMessage): Promise<Uint8Array | null> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > HTTP_INPUT_BOUNDS.maxBodyBytes) return null;
    chunks.push(buffer);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

/** The credential the CALLER presented, so one listener can serve many principals. */
export function credentialOf(request: IncomingMessage): string | null {
  const value = request.headers[CREDENTIAL_HEADER];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function protocolVersionOf(request: IncomingMessage): unknown {
  return request.headers[PROTOCOL_VERSION_HEADER] ?? null;
}

export function checkHeaders(
  request: IncomingMessage,
  expectedAuthority: string,
  origin: string,
  csrfToken: string,
): ListenerRefusalCode | null {
  if (request.headers.host !== expectedAuthority) return "LISTENER_HOST_INVALID";
  // Absent and foreign are both refused: a missing Origin is not a safe default
  // for a state-changing request.
  if (request.headers.origin !== origin) return "LISTENER_ORIGIN_INVALID";
  // An empty token is not a secret: a bare `!==` would let `x-moe-csrf:` (empty)
  // through. An empty configured token therefore satisfies NO request.
  if (csrfToken === "" || request.headers[CSRF_HEADER] !== csrfToken) {
    return "LISTENER_CSRF_INVALID";
  }
  return null;
}

/**
 * Structural only: types and presence, never a domain rule. The event-stream
 * seam owns limit bounds and cursor semantics, and re-deciding either here
 * would be a second authority over the same question.
 */
export function readEventRequest(
  body: Uint8Array,
): { readonly limit?: number; readonly projection: string; readonly subscriberId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const draft = parsed as Record<string, unknown>;
  const { limit, projection, subscriberId } = draft;
  if (typeof projection !== "string" || typeof subscriberId !== "string") return null;
  if (limit !== undefined && typeof limit !== "number") return null;
  return limit === undefined ? { projection, subscriberId } : { limit, projection, subscriberId };
}

export function readEventAcknowledgeRequest(body: Uint8Array): {
  readonly presentedCursor: { readonly generation: number; readonly position: string };
  readonly subscriberId: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const draft = parsed as Record<string, unknown>;
  const cursor = draft["presentedCursor"];
  if (typeof draft["subscriberId"] !== "string"
    || typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return null;
  const fields = cursor as Record<string, unknown>;
  if (typeof fields["generation"] !== "number" || typeof fields["position"] !== "string") {
    return null;
  }
  return {
    presentedCursor: { generation: fields["generation"], position: fields["position"] },
    subscriberId: draft["subscriberId"],
  };
}
