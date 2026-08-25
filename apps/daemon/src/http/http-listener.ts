import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { affordanceProjectMismatch, readAffordanceRequest } from "./affordance-contract.js";
import type { AffordancePort } from "./affordance-contract.js";
import { DOCUMENT_DOSSIER_PATH, handleDocumentDossierReadRequest } from "./document-dossier-read.js";
import type { DocumentDossierReadPort } from "./document-dossier-read.js";
import { DOCUMENT_INGEST_PATH, handleDocumentIngestRequest } from "./document-ingest-route.js";
import type { DocumentIngestPort } from "./document-ingest-route.js";
import { GOAL_CATALOG_READ_PATH, handleGoalCatalogReadRequest } from "./goal-catalog-read.js";
import type { GoalCatalogReadPort } from "./goal-catalog-read.js";
import { PLANNING_RUN_READ_PATH, handlePlanningRunReadRequest } from "./planning-run-read.js";
import type { PlanningRunReadPort } from "./planning-run-read.js";
import type { SubscriptionPort } from "./event-stream-contract.js";
import { acknowledgeEventPage, readEventPage } from "./event-stream.js";
import {
  eventStreamAccessUnavailable, eventStreamSubscriberMismatch,
} from "./event-stream-access.js";
import type { EventStreamAccessDecision } from "./event-stream-access.js";
import {
  EVENT_STREAM_RESUME_LAYER, EVENT_STREAM_RESUME_LEGACY_ROUTE_REFUSAL_CODE,
} from "./event-resume-command.js";
import { authenticateHttpRequest, handleAsyncCommandRequest } from "./http-adapter.js";
import type { CommandAdapterDeps, HttpCommandResult } from "./http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { answerGatedGraphQuery, gateGraphQuery } from "../planning/graph-query.js";
import type { GraphQueryPort } from "../planning/graph-query.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  authorityOf,
  checkHeaders,
  credentialOf,
  isLoopbackHost,
  originOf,
  protocolVersionOf,
  readBoundedBody,
  readEventAcknowledgeRequest,
  readEventRequest,
  readPairingToken,
  refuse,
  statusFor,
} from "./http-listener-guards.js";
import type { ListenerRefusalCode, ListenerRefused } from "./http-listener-guards.js";
import {
  CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  assetIsUnchanged,
  locateControlRoomAsset,
  readControlRoomAssetBytes,
  resolveControlRoomAssetRoot,
} from "./static-asset-host.js";
import type { ControlRoomAssetRoot } from "./static-asset-host.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import {
  PAIRING_APPROVAL_MAX_BODY_BYTES,
  PAIRING_CLAIM_PATH,
  PAIRING_REQUEST_PATH,
  createPairingApprovalHandshake,
  pairingApprovalStatusFor,
} from "./pairing-approval-handshake.js";
import type { PairingApprovalHandshakePort } from "./pairing-approval-handshake.js";
import { createPairingApprovalWindow } from "./pairing-approval-window.js";
import type {
  PairingApprovalGranted,
  PairingApprovalRefusal,
} from "./pairing-approval-window.js";
import { createPairingTokenWindow } from "./pairing-token-window.js";
import type { PairingTokenWindow } from "./pairing-token-window.js";

export {
  CONTROL_ROOM_LISTENER_LAYER,
  LISTENER_REFUSAL_CODES,
} from "./http-listener-guards.js";
export type { ListenerRefusalCode, ListenerRefused } from "./http-listener-guards.js";

/**
 * The socket, and only the socket.
 *
 * Everything from authentication onward is already committed in
 * `handleCommandRequest`, and the resumable stream is already committed in
 * `readEventPage`. This module binds, guards the headers the adapter never
 * sees, and routes. Authentication and compatibility stay in their shared
 * adapter gate; this socket performs no capability check, command decode, or
 * error mapping of its own.
 */
export interface ControlRoomListener {
  approvePairing(confirmationLabel: unknown): PairingOperatorApprovalResult;
  close(): Promise<void>;
  readonly ok: true;
  readonly origin: string;
  readonly port: number;
}

export type PairingOperatorApprovalResult =
  | PairingApprovalGranted | PairingApprovalRefusal | ListenerRefused;
export type StartListenerResult = ControlRoomListener | ListenerRefused;

export interface StartListenerOptions {
  /** Absent means the affordance route refuses rather than inventing an offer. */
  readonly affordances?: AffordancePort;
  /**
   * An ABSOLUTE directory of built control-room assets, hosted on this same
   * origin so an operator needs one process and one URL. Absent means this
   * daemon hosts no bundle at all and every path outside the JSON routes stays
   * `LISTENER_ROUTE_UNKNOWN`, exactly as before this option existed. Present, it
   * is resolved ONCE below, before the socket binds, and a root that cannot be
   * proven refuses the START rather than being served from.
   */
  readonly assetRoot?: string;
  /**
   * In-process secrets no hosted asset may contain. The CSRF token is always
   * added here; the caller supplies the rest (the daemon credential). A root
   * whose servable files carry any of them refuses the START with
   * `LISTENER_ASSET_ROOT_LEAKS_SECRET` - see the static host's header for why.
   */
  readonly assetSecrets?: readonly string[];
  readonly csrfToken: string;
  readonly deps: CommandAdapterDeps;
  /** Absent means an authenticated dossier read refuses rather than inventing one. */
  readonly documentDossiers?: DocumentDossierReadPort;
  /** Absent means the operator ingest route refuses rather than recording a document. */
  readonly documentIngest?: DocumentIngestPort;
  /** Absent means the graph route refuses rather than inventing a snapshot. */
  readonly graph?: GraphQueryPort;
  /** Absent means the authenticated goal catalog route refuses rather than inventing rows. */
  readonly goalCatalog?: GoalCatalogReadPort;
  readonly host?: string;
  readonly log?: (line: string) => void;
  readonly onRequest?: () => void;
  /**
   * The runtime credential mint behind `/session/pair`, and the source of the
   * `projectId` `/bootstrap` answers. Absent means neither handshake route is
   * available and both refuse `LISTENER_PAIRING_UNAVAILABLE` - a daemon hosting
   * no page needs no handshake.
   */
  readonly pairing?: SessionHandshakePort;
  /**
   * Monotonic time source for the short-lived pairing bearer. Production omits it and uses
   * `performance.now`; injection exists so a socket-level test can cross the deadline exactly.
   */
  readonly pairingMonotonicNow?: () => number;
  /**
   * The pairing token this listener will honour EXACTLY once and for at most one minute. Minted
   * by the entry when hosting is on and passed in here; written to no durable store and compared
   * in constant time. Absent (hosting off) means `/session/pair` refuses
   * `LISTENER_PAIRING_UNAVAILABLE` - there is nothing to pair against.
   */
  readonly pairingToken?: string;
  /** Absent means the pending-plan read route refuses rather than inventing a run. */
  readonly planningRuns?: PlanningRunReadPort;
  readonly port?: number;
  /** Absent means the stream route refuses rather than inventing an empty page. */
  readonly subscriptions?: SubscriptionPort;
}

const COMMAND_PATH = "/command";
const EVENT_PAGE_PATH = "/events/read";
const EVENT_ACKNOWLEDGE_PATH = "/events/ack";
const EVENT_RESUME_PATH = "/events/resume";
const AFFORDANCE_PATH = "/affordances/read";
const GRAPH_GET_PATH = "/graph/get";

/**
 * The handshake surface. Deliberately OUTSIDE `JSON_ROUTES` because it does not
 * share their guard set: `/bootstrap` carries no credential and no CSRF (a page
 * must be able to call it first), and `/session/pair` carries the CSRF and Origin
 * gate but no credential - it IS the credential mint. Both are Host-checked and
 * both carry the static route's policy headers.
 */
const BOOTSTRAP_PATH = "/bootstrap";
const SESSION_PAIR_PATH = "/session/pair";

/** The JSON surface. Anything else is either a hosted asset or an unknown route. */
const JSON_ROUTES: readonly string[] = Object.freeze([
  AFFORDANCE_PATH,
  COMMAND_PATH,
  DOCUMENT_DOSSIER_PATH,
  DOCUMENT_INGEST_PATH,
  EVENT_ACKNOWLEDGE_PATH,
  EVENT_PAGE_PATH,
  EVENT_RESUME_PATH,
  GRAPH_GET_PATH,
  GOAL_CATALOG_READ_PATH,
  PLANNING_RUN_READ_PATH,
]);

type ReplyHeaders = Readonly<Record<string, string>>;
const PAIRING_APPROVAL_RESPONSE_HEADERS = Object.freeze({
  ...CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  "cache-control": "no-store",
});

function reply(
  response: ServerResponse, status: number, body: unknown, headers: ReplyHeaders = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...headers, "content-type": "application/json" });
  response.end(payload);
}

/** Code and layer only: a refusal's `detail`, where one exists, never reaches the wire. */
function refuseRequest(
  response: ServerResponse, code: ListenerRefusalCode, headers: ReplyHeaders = {},
): void {
  reply(response, statusFor(code), { code, layer: CONTROL_ROOM_LISTENER_LAYER }, headers);
}

function replyEventStreamAccessRefusal(
  response: ServerResponse,
  refusal: Exclude<EventStreamAccessDecision, { readonly ok: true }>,
): void {
  reply(response, refusal.httpStatus, {
    code: refusal.code,
    layer: refusal.layer,
    outcome: "REFUSED",
  });
}

async function serveCommand(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): Promise<void> {
  // The body stays RAW here. `credential` and `protocolVersion` travel out of
  // band precisely so authenticate and compatibility can both answer before
  // anything parses it — parsing first would move a decode ahead of
  // authenticate and change the committed refusal order.
  // The ASYNC entry serves both kinds of registry entry: a synchronous handler runs
  // through the same unchanged synchronous decision port, so routing every command here
  // is not a per-kind decision living outside the registry.
  const result: HttpCommandResult = await handleAsyncCommandRequest(options.deps, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  // Serialized verbatim. The adapter chose the status and owns the codes.
  reply(response, result.httpStatus, result);
}

function serveEventPage(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const access = authenticateHttpRequest(
    options.deps.authenticator,
    credentialOf(request),
    protocolVersionOf(request),
  );
  if (!access.ok) {
    reply(response, access.httpStatus, access);
    return;
  }
  if (options.subscriptions === undefined) {
    refuseRequest(response, "LISTENER_STREAM_UNAVAILABLE");
    return;
  }
  const authority = options.deps.eventStreamAccess?.authorize(access.principal)
    ?? eventStreamAccessUnavailable();
  if (!authority.ok) {
    replyEventStreamAccessRefusal(response, authority);
    return;
  }
  const eventRequest = readEventRequest(body);
  if (eventRequest === null) {
    refuseRequest(response, "LISTENER_STREAM_REQUEST_INVALID");
    return;
  }
  if (eventRequest.subscriberId !== authority.subscriberId) {
    replyEventStreamAccessRefusal(response, eventStreamSubscriberMismatch());
    return;
  }
  // Always 200: the frame IS the answer and carries its own outcome, code and
  // layer. Minting an HTTP status per frame would be the translation table the
  // seam is forbidden to hold.
  reply(response, 200, readEventPage(options.subscriptions, {
    ...eventRequest,
    subscriberId: authority.subscriberId,
  }));
}

function serveEventAcknowledge(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const access = authenticateHttpRequest(
    options.deps.authenticator,
    credentialOf(request),
    protocolVersionOf(request),
  );
  if (!access.ok) {
    reply(response, access.httpStatus, access);
    return;
  }
  if (options.subscriptions === undefined) {
    refuseRequest(response, "LISTENER_STREAM_UNAVAILABLE");
    return;
  }
  const authority = options.deps.eventStreamAccess?.authorize(access.principal)
    ?? eventStreamAccessUnavailable();
  if (!authority.ok) {
    replyEventStreamAccessRefusal(response, authority);
    return;
  }
  const eventRequest = readEventAcknowledgeRequest(body);
  if (eventRequest === null) {
    refuseRequest(response, "LISTENER_STREAM_REQUEST_INVALID");
    return;
  }
  if (eventRequest.subscriberId !== authority.subscriberId) {
    replyEventStreamAccessRefusal(response, eventStreamSubscriberMismatch());
    return;
  }
  reply(response, 200, acknowledgeEventPage(options.subscriptions, {
    ...eventRequest,
    subscriberId: authority.subscriberId,
  }));
}

/** Legacy tombstone. Cursor reseating is a durable operator command, never a direct route. */
function serveEventResume(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
): void {
  const access = authenticateHttpRequest(
    options.deps.authenticator,
    credentialOf(request),
    protocolVersionOf(request),
  );
  if (!access.ok) {
    reply(response, access.httpStatus, access);
    return;
  }
  reply(response, 410, {
    code: EVENT_STREAM_RESUME_LEGACY_ROUTE_REFUSAL_CODE,
    layer: EVENT_STREAM_RESUME_LAYER,
  });
}

function serveAffordances(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const access = authenticateHttpRequest(
    options.deps.authenticator,
    credentialOf(request),
    protocolVersionOf(request),
  );
  if (!access.ok) {
    reply(response, access.httpStatus, access);
    return;
  }
  if (options.affordances === undefined) {
    refuseRequest(response, "LISTENER_AFFORDANCES_UNAVAILABLE");
    return;
  }
  const affordanceRequest = readAffordanceRequest(body);
  if (affordanceRequest === null
    || affordanceProjectMismatch(affordanceRequest, options.affordances.boundProjectId)) {
    // A malformed body OR a request naming a project this daemon does not
    // serve: both are invalid requests for this route, not a surface refusal.
    refuseRequest(response, "LISTENER_AFFORDANCE_REQUEST_INVALID");
    return;
  }
  // Always 200: the frame carries its own outcome, code and layer, exactly
  // like the event page — the seam holds no translation table.
  reply(response, 200, options.affordances.readSurface());
}

/**
 * GATE FIRST, DECODE SECOND. `gateGraphQuery` is the one authenticate ->
 * compatibility -> capability sequence the MCP transport also clears, and it
 * runs here before a single body byte is parsed: decoding ahead of it would
 * hand an unidentified caller a 400 verdict and a full-size `JSON.parse` per
 * request, which every other read route on this socket refuses to do.
 * Availability, the project derivation and the read stay in
 * `answerGatedGraphQuery`, shared with MCP, so neither transport can grow a
 * guard order of its own while both stay green. This function gates, decodes
 * bytes and replies, and decides nothing else.
 */
function serveGraphQuery(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const gated = gateGraphQuery(
    options.deps.authenticator,
    credentialOf(request),
    protocolVersionOf(request),
  );
  // An AUTHENTICATE or COMPATIBILITY refusal keeps the status the adapter chose,
  // as every other route does. Everything else replies 200: the frame IS the
  // answer and carries its own outcome, code and layer, and minting an HTTP
  // status per frame would be the translation table this seam may not hold.
  if (!gated.ok) {
    reply(response, "outcome" in gated ? gated.httpStatus : 200, gated);
    return;
  }
  // An empty body is a request that names no project, which is the normal call.
  // Bytes that are not JSON are a decode fault of THIS transport, so they carry
  // the listener's own code exactly as a malformed stream request does.
  let parsed: unknown = {};
  if (body.length > 0) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      refuseRequest(response, "LISTENER_GRAPH_REQUEST_INVALID");
      return;
    }
  }
  reply(response, 200, answerGatedGraphQuery(gated.principal, options.graph, parsed));
}

function serveDocumentDossier(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleDocumentDossierReadRequest({
    authenticator: options.deps.authenticator,
    documentDossiers: options.documentDossiers,
  }, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function servePlanningRun(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handlePlanningRunReadRequest({
    authenticator: options.deps.authenticator,
    planningRuns: options.planningRuns,
  }, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveGoalCatalog(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleGoalCatalogReadRequest({
    authenticator: options.deps.authenticator,
    goalCatalog: options.goalCatalog,
  }, {
    body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveDocumentIngest(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleDocumentIngestRequest({
    authenticator: options.deps.authenticator,
    documentIngest: options.documentIngest,
  }, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

/**
 * Host is checked; Origin and CSRF deliberately are NOT.
 *
 * A browser sends neither on the top-level navigation that fetches this bundle,
 * so demanding them would make the hosted control room unloadable - the very
 * thing this route exists to fix. What the CSRF gate protects is the
 * state-changing JSON surface, and that surface keeps the full header check
 * untouched; an asset read changes nothing. The Host check stays because it is
 * what keeps a rebound DNS name off this socket, and it is the only one of the
 * three a plain navigation can satisfy. What the route serves on those terms
 * is bounded elsewhere: the start-time bundle and secret proofs in the static
 * host, and the policy headers below, which travel on EVERY reply this route
 * writes - success, 304 and refusal - so a framed, probed or embedded load of
 * the same-origin board is refused by the browser even when the bytes exist.
 *
 * ORDER: locate (one stat, no read) -> HEAD answers from the stat -> a matching
 * If-None-Match answers 304 -> only then is the file read. A request that will
 * carry no body never costs a read, and the length a HEAD reports is the real
 * file's length from the same stat the validator came from.
 */
function serveAsset(
  response: ServerResponse,
  request: IncomingMessage,
  assets: ControlRoomAssetRoot,
  authority: string,
  path: string,
): void {
  const policy = CONTROL_ROOM_ASSET_RESPONSE_HEADERS;
  if (request.headers.host !== authority) {
    refuseRequest(response, "LISTENER_HOST_INVALID", policy);
    return;
  }
  const located = locateControlRoomAsset(assets, request.method ?? "", path);
  if (located.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, located.code, policy);
    return;
  }
  const headers = { ...policy, "content-type": located.contentType, etag: located.etag };
  if (request.method === "HEAD") {
    response.writeHead(200, { ...headers, "content-length": located.size });
    response.end();
    return;
  }
  if (assetIsUnchanged(located, request.headers["if-none-match"])) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const bytes = readControlRoomAssetBytes(located);
  if (!(bytes instanceof Uint8Array)) {
    refuseRequest(response, bytes.code, policy);
    return;
  }
  // The length of the bytes actually sent, never the stat's: a file replaced
  // between the stat and the read must not leave a client holding a wrong length.
  response.writeHead(200, { ...headers, "content-length": bytes.byteLength });
  response.end(bytes);
}

/**
 * Host is checked; Origin, CSRF and the credential deliberately are NOT.
 *
 * A same-origin page must be able to call this FIRST, before it holds a CSRF
 * token, to learn one. The reason that is safe: this route carries the static
 * host's `cross-origin-resource-policy: same-origin` and sends no
 * `access-control-allow-origin`, so only same-origin script - the page this
 * daemon hosts - can READ the answer; a foreign origin cannot. A non-browser
 * loopback client CAN read it, but the CSRF token is only a cross-site-forgery
 * defence and is worthless to a client that can already forge Origin. The
 * credential is what gates authority, and this route never carries or answers
 * one. The answer is a fixed small JSON: the CSRF token, the wire protocol
 * version, and this daemon's bound project id.
 */
function serveBootstrap(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  authority: string,
): void {
  const policy = CONTROL_ROOM_ASSET_RESPONSE_HEADERS;
  if (request.headers.host !== authority) {
    refuseRequest(response, "LISTENER_HOST_INVALID", policy);
    return;
  }
  // A read with no body and no state change: GET, and nothing else.
  if (request.method !== "GET") {
    refuseRequest(response, "LISTENER_PAIRING_METHOD_INVALID", policy);
    return;
  }
  const pairing = options.pairing;
  if (pairing === undefined) {
    refuseRequest(response, "LISTENER_PAIRING_UNAVAILABLE", policy);
    return;
  }
  reply(response, 200, {
    csrfToken: options.csrfToken,
    projectId: pairing.boundProjectId,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, policy);
}

/**
 * The full JSON-route header gate (Host, Origin, CSRF) MINUS the credential,
 * because this route IS the credential mint. It also checks the protocol header
 * so an incompatible build never reaches the mint. The pairing token is consumed
 * EXACTLY once, in process: the latch is reserved synchronously before the mint
 * and released only if the mint itself refuses, so a replay arriving during an
 * in-flight mint refuses while a transient mint failure stays retryable. A wrong,
 * reused or expired token all receive the one `LISTENER_PAIRING_TOKEN_REJECTED`
 * code at one status, so nothing distinguishes them. Every reply, success and
 * refusal alike, carries the static host's policy headers, so the minted
 * credential cannot be read cross-origin.
 */
async function serveSessionPair(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  pairingState: PairingTokenWindow,
  authority: string,
  origin: string,
): Promise<void> {
  const policy = PAIRING_APPROVAL_RESPONSE_HEADERS;
  const headerFault = checkHeaders(request, authority, origin, options.csrfToken);
  if (headerFault !== null) {
    refuseRequest(response, headerFault, policy);
    return;
  }
  if (request.method !== "POST") {
    refuseRequest(response, "LISTENER_PAIRING_METHOD_INVALID", policy);
    return;
  }
  if (protocolVersionOf(request) !== WIRE_PROTOCOL_VERSION) {
    refuseRequest(response, "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED", policy);
    return;
  }
  const pairing = options.pairing;
  const token = options.pairingToken;
  if (pairing === undefined || token === undefined || token === "") {
    refuseRequest(response, "LISTENER_PAIRING_UNAVAILABLE", policy);
    return;
  }
  const body = await readBoundedBody(request);
  if (body === null) {
    refuseRequest(response, "LISTENER_BODY_TOO_LARGE", policy);
    return;
  }
  const presented = readPairingToken(body);
  if (presented === null) {
    refuseRequest(response, "LISTENER_PAIRING_REQUEST_INVALID", policy);
    return;
  }
  // From here to the reserve there is no `await`: the consumed check and the
  // reservation are one synchronous step, so two concurrent valid presentations
  // cannot both pass. A used latch, or a token that does not match in constant
  // time, is the SAME refusal.
  if (!pairingState.reserve(presented, token)) {
    refuseRequest(response, "LISTENER_PAIRING_TOKEN_REJECTED", policy);
    return;
  }
  const minted = pairing.mint();
  if (!minted.ok) {
    // The token bought nothing, so it is released for a retry: no credential was
    // issued, and a mint refusal is a daemon-side fault, not a spent token.
    pairingState.release();
    refuseRequest(response, "LISTENER_PAIRING_MINT_FAILED", policy);
    return;
  }
  reply(response, 200, {
    capabilities: minted.capabilities,
    expiresAt: minted.expiresAt,
    projectId: pairing.boundProjectId,
    protocolVersion: WIRE_PROTOCOL_VERSION,
    sessionCredential: minted.credential,
  }, policy);
}

async function servePairingApproval(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  handshake: PairingApprovalHandshakePort | null,
  authority: string,
  origin: string,
  path: typeof PAIRING_REQUEST_PATH | typeof PAIRING_CLAIM_PATH,
  exactPath: boolean,
): Promise<void> {
  const policy = PAIRING_APPROVAL_RESPONSE_HEADERS;
  const headerFault = checkHeaders(request, authority, origin, options.csrfToken);
  if (headerFault !== null) {
    refuseRequest(response, headerFault, policy);
    return;
  }
  if (!exactPath) {
    refuseRequest(response, "LISTENER_ROUTE_UNKNOWN", policy);
    return;
  }
  if (request.method !== "POST") {
    refuseRequest(response, "LISTENER_PAIRING_METHOD_INVALID", policy);
    return;
  }
  if (protocolVersionOf(request) !== WIRE_PROTOCOL_VERSION) {
    refuseRequest(response, "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED", policy);
    return;
  }
  if (handshake === null) {
    refuseRequest(response, "LISTENER_PAIRING_UNAVAILABLE", policy);
    return;
  }
  const body = await readBoundedBody(request, PAIRING_APPROVAL_MAX_BODY_BYTES);
  if (body === null) {
    refuseRequest(response, "LISTENER_BODY_TOO_LARGE", policy);
    return;
  }
  const outcome = path === PAIRING_REQUEST_PATH
    ? handshake.request(body)
    : handshake.claim(body);
  if (!outcome.ok) {
    reply(response, pairingApprovalStatusFor(outcome.code), {
      code: outcome.code,
      layer: outcome.layer,
    }, policy);
    return;
  }
  reply(response, 200, path === PAIRING_CLAIM_PATH
    ? { ...outcome, protocolVersion: WIRE_PROTOCOL_VERSION }
    : outcome, policy);
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartListenerOptions,
  authority: string,
  origin: string,
  assets: ControlRoomAssetRoot | null,
  pairingState: PairingTokenWindow,
  pairingApproval: PairingApprovalHandshakePort | null,
): Promise<void> {
  options.onRequest?.();
  // Logged without the credential and without a query string, so neither can
  // leak into a log line (design 19.2). The pairing token travels only in a POST
  // body, never on the request line, so it never reaches this log either.
  const rawPath = request.url ?? "";
  const path = rawPath.split("?")[0] ?? "";
  options.log?.(`${request.method ?? "?"} ${path}`);

  // The handshake surface answers ahead of the asset/JSON split: it is neither an
  // asset nor a member of the shared-guard JSON set, and each route owns its own
  // guard order stated in its handler.
  if (path === BOOTSTRAP_PATH) {
    serveBootstrap(response, request, options, authority);
    return;
  }
  if (path === SESSION_PAIR_PATH) {
    await serveSessionPair(response, request, options, pairingState, authority, origin);
    return;
  }
  if (path === PAIRING_REQUEST_PATH || path === PAIRING_CLAIM_PATH) {
    await servePairingApproval(
      response, request, options, pairingApproval, authority, origin, path, rawPath === path,
    );
    return;
  }

  if (!JSON_ROUTES.includes(path)) {
    // No hosted bundle means the answer is the one it always was. The static
    // host is reached only when a root was resolved at startup, so a daemon
    // started without one behaves exactly as it did before it existed.
    if (assets === null) {
      refuseRequest(response, "LISTENER_ROUTE_UNKNOWN");
      return;
    }
    serveAsset(response, request, assets, authority, path);
    return;
  }
  const headerFault = checkHeaders(request, authority, origin, options.csrfToken);
  if (headerFault !== null) {
    refuseRequest(response, headerFault);
    return;
  }
  if (path === DOCUMENT_DOSSIER_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID");
    return;
  }
  if (path === PLANNING_RUN_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_PLANNING_RUN_REQUEST_INVALID");
    return;
  }
  if (path === GOAL_CATALOG_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_GOAL_CATALOG_REQUEST_INVALID");
    return;
  }
  if (path === DOCUMENT_INGEST_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID");
    return;
  }
  const body = await readBoundedBody(request);
  if (body === null) {
    refuseRequest(response, "LISTENER_BODY_TOO_LARGE");
    return;
  }

  if (path === COMMAND_PATH) await serveCommand(response, request, options, body);
  else if (path === EVENT_PAGE_PATH) serveEventPage(response, request, options, body);
  else if (path === EVENT_ACKNOWLEDGE_PATH) serveEventAcknowledge(response, request, options, body);
  else if (path === EVENT_RESUME_PATH) serveEventResume(response, request, options);
  else if (path === AFFORDANCE_PATH) serveAffordances(response, request, options, body);
  else if (path === GRAPH_GET_PATH) serveGraphQuery(response, request, options, body);
  else if (path === GOAL_CATALOG_READ_PATH) serveGoalCatalog(response, request, options, body);
  else if (path === PLANNING_RUN_READ_PATH) servePlanningRun(response, request, options, body);
  else if (path === DOCUMENT_INGEST_PATH) serveDocumentIngest(response, request, options, body);
  else serveDocumentDossier(response, request, options, body);
}

export async function startControlRoomListener(
  options: StartListenerOptions,
): Promise<StartListenerResult> {
  const host = options.host ?? "127.0.0.1";
  // Refuses to START, not warns. Design 19.2: loopback is the only default
  // bind, and a transport that reaches a public interface on a host also
  // running agent processes is an exposure rather than a convenience.
  if (!isLoopbackHost(host)) return refuse("LISTENER_NON_LOOPBACK_BIND");

  // Resolved ONCE, here, before a socket exists. A root re-derived per request
  // is a root a caller can race, and one that cannot be proven now is a reason
  // not to start rather than a reason to serve from an unproven directory.
  let assets: ControlRoomAssetRoot | null = null;
  if (options.assetRoot !== undefined) {
    // The CSRF token is this listener's own secret, so it joins the scan here;
    // the caller's list carries the rest. An empty caller list still scans for
    // the token, and an empty token is dropped by the host, not matched everywhere.
    const resolvedRoot = resolveControlRoomAssetRoot(
      options.assetRoot, [options.csrfToken, ...(options.assetSecrets ?? [])],
    );
    if (resolvedRoot.kind === "LISTENER_REFUSAL") {
      return refuse(resolvedRoot.code, resolvedRoot.detail);
    }
    assets = resolvedRoot;
  }

  // Filled in AFTER the bind, when the port is known; the handler closes over
  // the variables rather than over a `const` declared further down, so a request
  // that somehow raced the bind would fail the Host check rather than throw a
  // ReferenceError out of the request handler.
  let authority = "";
  let origin = "";
  let server: Server | null = null;
  // One short-lived consume window for this listener. A restart mints a new token and therefore
  // a fresh deadline; expiry is monotonic and latches, so a wall-clock rollback cannot revive it.
  const pairingState = createPairingTokenWindow(options.pairingMonotonicNow);
  const pairingApprovalWindow = createPairingApprovalWindow(
    options.pairingMonotonicNow === undefined
      ? {}
      : { now: options.pairingMonotonicNow },
  );
  const pairingApproval = options.pairing === undefined
    ? null
    : createPairingApprovalHandshake(pairingApprovalWindow.requests, options.pairing);
  try {
    server = createServer((request, response) => {
      const served = serve(
        request, response, options, authority, origin, assets, pairingState, pairingApproval,
      );
      void served.catch(() => {
        // A throw from the handler must still answer and must still leave the
        // listener closable; it may never surface as a hung socket.
        if (!response.headersSent) refuseRequest(response, "LISTENER_REQUEST_FAILED");
        else response.end();
      });
    });

    const bound = server;
    await new Promise<void>((resolve, reject) => {
      bound.once("error", reject);
      bound.listen(options.port ?? 0, host, resolve);
    });

    const address = bound.address();
    if (address === null || typeof address === "string") {
      pairingApprovalWindow.close();
      await closeServer(bound);
      return refuse("LISTENER_BIND_FAILED");
    }
    const port = address.port;
    authority = authorityOf(host, port);
    origin = originOf(host, port);
    let closed = false;

    return Object.freeze({
      approvePairing: (confirmationLabel: unknown): PairingOperatorApprovalResult =>
        closed || options.pairing === undefined
          ? refuse("LISTENER_PAIRING_UNAVAILABLE")
          : pairingApprovalWindow.operator.approve(confirmationLabel),
      close: async (): Promise<void> => {
        closed = true;
        pairingApprovalWindow.close();
        await closeServer(bound);
      },
      ok: true,
      origin,
      port,
    } as const);
  } catch {
    pairingApprovalWindow.close();
    // Closed on the failure path too: a half-bound server left behind surfaces
    // later as EBUSY on Windows rather than as the real error.
    if (server !== null) await closeServer(server);
    return refuse("LISTENER_BIND_FAILED");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
