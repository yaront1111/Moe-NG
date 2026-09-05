import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { decodeBoundedJsonBytes } from "@moe/contracts";

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
  // The operator ingest route's transport faults, mirroring the dossier pair: a malformed or
  // non-POST body, and a daemon composed without the ingest port.
  "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID",
  "LISTENER_DOCUMENT_INGEST_UNAVAILABLE",
  "LISTENER_GRAPH_REQUEST_INVALID",
  "LISTENER_GOAL_CATALOG_REQUEST_INVALID",
  "LISTENER_GOAL_CATALOG_UNAVAILABLE",
  "LISTENER_HOST_INVALID",
  "LISTENER_NON_LOOPBACK_BIND",
  "LISTENER_ORIGIN_INVALID",
  // The budget commitment read route's transport faults, mirroring the dossier pair: a body
  // that is not exactly `{ runId }` with a STRING value (which is where a caller smuggling a
  // projectId is refused, before the derivation is asked), and a daemon composed without the
  // budget commitment port.
  "LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID",
  "LISTENER_BUDGET_COMMITMENT_UNAVAILABLE",
  // The Gate 1 read route's transport faults, mirroring the dossier pair: a body that is not
  // exactly `{ ref }` (which is where a caller presenting its own authority is refused, before
  // the resolver is asked), and a daemon composed without the gate 1 port.
  "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID",
  "LISTENER_PRODUCT_CONTRACT_GATE_1_UNAVAILABLE",
  // The PRD coverage read: same transport pair (a body that is not exactly one string-valued
  // selector, and a daemon composed without the coverage port).
  "LISTENER_DOCUMENT_COVERAGE_REQUEST_INVALID",
  "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE",
  // The runs read: same transport pair.
  "LISTENER_RUNS_REQUEST_INVALID",
  "LISTENER_RUNS_UNAVAILABLE",
  // Policy, activation receipts and health: same transport pairs, none taking an operand.
  "LISTENER_POLICY_REQUEST_INVALID",
  "LISTENER_POLICY_UNAVAILABLE",
  "LISTENER_ACTIVATION_REQUEST_INVALID",
  "LISTENER_ACTIVATION_UNAVAILABLE",
  "LISTENER_HEALTH_REQUEST_INVALID",
  "LISTENER_HEALTH_UNAVAILABLE",
  // The activity and sessions reads: same transport pairs.
  "LISTENER_ACTIVITY_REQUEST_INVALID",
  "LISTENER_ACTIVITY_UNAVAILABLE",
  "LISTENER_SESSIONS_REQUEST_INVALID",
  "LISTENER_SESSIONS_UNAVAILABLE",
  // The project's bound git remote: same transport pair, one line to hold the file at its cap.
  "LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID", "LISTENER_REPOSITORY_REMOTE_UNAVAILABLE",
  "LISTENER_CRITERIA_REQUEST_INVALID", "LISTENER_CRITERIA_UNAVAILABLE",
  "LISTENER_REPOSITORY_RECOVERY_REQUEST_INVALID", "LISTENER_REPOSITORY_RECOVERY_UNAVAILABLE",
  // The goal-source (PRD text) read: same transport pair.
  "LISTENER_GOAL_SOURCE_REQUEST_INVALID",
  "LISTENER_GOAL_SOURCE_UNAVAILABLE",
  // The design-revision read: same transport pair.
  "LISTENER_DESIGN_REQUEST_INVALID",
  "LISTENER_DESIGN_UNAVAILABLE",
  // The per-environment variable table: same transport pair. REQUEST_INVALID covers a non-POST
  // and any body that is not exactly `{environment}`; an environment NAME this project does not
  // have is NOT here, because that caller is refused by the store's own ENV_ENVIRONMENT_UNKNOWN
  // at its own layer instead.
  "LISTENER_ENVIRONMENTS_REQUEST_INVALID",
  "LISTENER_ENVIRONMENTS_UNAVAILABLE",
  // The pending-contract read (the Gate 1 card's read): same transport pair.
  "LISTENER_PRODUCT_CONTRACT_PENDING_REQUEST_INVALID",
  "LISTENER_PRODUCT_CONTRACT_PENDING_UNAVAILABLE",
  // The activated `/2` current-contract read remains a separate authority plane.
  "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_REQUEST_INVALID",
  "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_UNAVAILABLE",
  "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID",
  "LISTENER_PRODUCT_CONTRACT_V2_PENDING_UNAVAILABLE",
  // The pending-plan read route's transport faults, mirroring the dossier pair: a malformed or
  // non-POST `{runId}` request, and a daemon composed without the read port.
  "LISTENER_PLANNING_RUN_REQUEST_INVALID",
  "LISTENER_PLANNING_RUN_UNAVAILABLE",
  // The session challenge-operands read route's transport faults. REQUEST_INVALID covers a
  // non-POST or a body carrying any key at all; a body naming one of the three operands is
  // NOT here, because that caller is refused by the route's own stable code instead.
  "LISTENER_SESSION_CHALLENGE_OPERANDS_REQUEST_INVALID",
  "LISTENER_SESSION_CHALLENGE_OPERANDS_UNAVAILABLE",
  // The runtime credential handshake, all under this same layer so no new
  // boundary constant enters the security roster. UNAVAILABLE covers a daemon
  // without request/claim authority and the non-minting legacy route tombstone.
  "LISTENER_PAIRING_UNAVAILABLE",
  "LISTENER_PAIRING_METHOD_INVALID",
  "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED",
  "LISTENER_REQUEST_FAILED",
  "LISTENER_ROUTE_UNKNOWN",
  "LISTENER_BIND_FAILED",
  "LISTENER_STREAM_REQUEST_INVALID",
  "LISTENER_STREAM_UNAVAILABLE",
  "LISTENER_V2_COMMAND_UNAVAILABLE",
  "LISTENER_V2_COMMAND_REQUEST_INVALID",
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
  if (code === "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID") return 400;
  if (code === "LISTENER_DOCUMENT_INGEST_UNAVAILABLE") return 503;
  if (code === "LISTENER_GRAPH_REQUEST_INVALID") return 400;
  if (code === "LISTENER_GOAL_CATALOG_REQUEST_INVALID") return 400;
  if (code === "LISTENER_GOAL_CATALOG_UNAVAILABLE") return 503;
  if (code === "LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID") return 400;
  if (code === "LISTENER_BUDGET_COMMITMENT_UNAVAILABLE") return 503;
  if (code === "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID") return 400;
  if (code === "LISTENER_PRODUCT_CONTRACT_GATE_1_UNAVAILABLE") return 503;
  if (code === "LISTENER_DOCUMENT_COVERAGE_REQUEST_INVALID") return 400;
  if (code === "LISTENER_DOCUMENT_COVERAGE_UNAVAILABLE") return 503;
  if (code === "LISTENER_RUNS_REQUEST_INVALID") return 400;
  if (code === "LISTENER_RUNS_UNAVAILABLE") return 503;
  if (code === "LISTENER_POLICY_REQUEST_INVALID") return 400;
  if (code === "LISTENER_POLICY_UNAVAILABLE") return 503;
  if (code === "LISTENER_ACTIVATION_REQUEST_INVALID") return 400;
  if (code === "LISTENER_ACTIVATION_UNAVAILABLE") return 503;
  if (code === "LISTENER_HEALTH_REQUEST_INVALID") return 400;
  if (code === "LISTENER_HEALTH_UNAVAILABLE") return 503;
  if (code === "LISTENER_ACTIVITY_REQUEST_INVALID") return 400;
  if (code === "LISTENER_ACTIVITY_UNAVAILABLE") return 503;
  if (code === "LISTENER_SESSIONS_REQUEST_INVALID") return 400;
  if (code === "LISTENER_SESSIONS_UNAVAILABLE") return 503;
  if (code === "LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID") return 400;
  if (code === "LISTENER_REPOSITORY_REMOTE_UNAVAILABLE") return 503;
  if (code === "LISTENER_GOAL_SOURCE_REQUEST_INVALID") return 400;
  if (code === "LISTENER_GOAL_SOURCE_UNAVAILABLE") return 503;
  if (code === "LISTENER_DESIGN_REQUEST_INVALID") return 400;
  if (code === "LISTENER_DESIGN_UNAVAILABLE") return 503;
  if (code === "LISTENER_ENVIRONMENTS_REQUEST_INVALID") return 400;
  if (code === "LISTENER_ENVIRONMENTS_UNAVAILABLE") return 503;
  if (code === "LISTENER_PRODUCT_CONTRACT_PENDING_REQUEST_INVALID") return 400;
  if (code === "LISTENER_PRODUCT_CONTRACT_PENDING_UNAVAILABLE") return 503;
  if (code === "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID") return 400;
  if (code === "LISTENER_PRODUCT_CONTRACT_V2_PENDING_UNAVAILABLE") return 503;
  if (code === "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_REQUEST_INVALID") return 400;
  if (code === "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_UNAVAILABLE") return 503;
  if (code === "LISTENER_PLANNING_RUN_REQUEST_INVALID") return 400;
  if (code === "LISTENER_PLANNING_RUN_UNAVAILABLE") return 503;
  if (code === "LISTENER_SESSION_CHALLENGE_OPERANDS_REQUEST_INVALID") return 400;
  if (code === "LISTENER_SESSION_CHALLENGE_OPERANDS_UNAVAILABLE") return 503;
  // The handshake statuses. UNAVAILABLE is 503 like the other absent ports;
  // METHOD_INVALID 405 and PROTOCOL_UNSUPPORTED / REQUEST_INVALID 400 are client
  // faults. TOKEN_REJECTED is 401 - a rejected credential attempt, uniform across
  // wrong, reused and expired so the status leaks nothing the code hides.
  // MINT_FAILED is 500: a valid token was accepted but the daemon could not open
  // the session, which is a server fault and not a caller-retryable one.
  if (code === "LISTENER_PAIRING_UNAVAILABLE") return 503;
  if (code === "LISTENER_PAIRING_METHOD_INVALID") return 405;
  if (code === "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED") return 400;
  if (code === "LISTENER_REQUEST_FAILED") return 500;
  if (code === "LISTENER_ROUTE_UNKNOWN") return 404;
  if (code === "LISTENER_STREAM_REQUEST_INVALID") return 400;
  if (code === "LISTENER_STREAM_UNAVAILABLE") return 503;
  if (code === "LISTENER_V2_COMMAND_UNAVAILABLE") return 503;
  if (code === "LISTENER_V2_COMMAND_REQUEST_INVALID") return 405;
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
export async function readBoundedBody(
  request: IncomingMessage,
  maximumBytes: number = HTTP_INPUT_BOUNDS.maxBodyBytes,
): Promise<Uint8Array | null> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maximumBytes) return null;
    chunks.push(buffer);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

/** Exact approval-body shape; authority is intentionally absent from the body. */
export function readPairingApproveRequest(body: unknown): string | null {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok || !isRecord(decoded.value)) return null;
  const keys = Object.keys(decoded.value);
  if (keys.length !== 1 || keys[0] !== "confirmationLabel") return null;
  const confirmationLabel = decoded.value["confirmationLabel"];
  return typeof confirmationLabel === "string" ? confirmationLabel : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * The resume body: the acknowledge shape PLUS the projection, because
 * `resumeFromSnapshot` probes the port with `{projection, subscriberId}` before it
 * compares the presented cursor. Structural only, exactly like the two guards above:
 * the seam owns which cursor may actually resume.
 */
export function readEventResumeRequest(body: Uint8Array): {
  readonly presentedCursor: { readonly generation: number; readonly position: string };
  readonly projection: string;
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
  if (typeof draft["projection"] !== "string" || typeof draft["subscriberId"] !== "string"
    || typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return null;
  const fields = cursor as Record<string, unknown>;
  if (typeof fields["generation"] !== "number" || typeof fields["position"] !== "string") {
    return null;
  }
  return {
    presentedCursor: { generation: fields["generation"], position: fields["position"] },
    projection: draft["projection"],
    subscriberId: draft["subscriberId"],
  };
}

/**
 * Constant-time equality via digest-then-compare, the same posture the session
 * authenticator uses for private manager state: `timingSafeEqual` demands
 * equal-length inputs, and hashing both first makes that hold with no
 * length-dependent branch. An empty expected value matches nothing.
 */
export function secretMatchesConstantTime(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
