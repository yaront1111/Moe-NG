import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { affordanceProjectMismatch, readAffordanceRequest } from "./affordance-contract.js";
import type { AffordancePort } from "./affordance-contract.js";
import { DOCUMENT_DOSSIER_PATH, handleDocumentDossierReadRequest } from "./document-dossier-read.js";
import type { DocumentDossierReadPort } from "./document-dossier-read.js";
import type { SubscriptionPort } from "./event-stream-contract.js";
import { acknowledgeEventPage, readEventPage } from "./event-stream.js";
import { authenticateHttpRequest, handleAsyncCommandRequest } from "./http-adapter.js";
import type { CommandAdapterDeps, HttpCommandResult } from "./http-contract.js";
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
  close(): Promise<void>;
  readonly ok: true;
  readonly origin: string;
  readonly port: number;
}

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
  /** Absent means the graph route refuses rather than inventing a snapshot. */
  readonly graph?: GraphQueryPort;
  readonly host?: string;
  readonly log?: (line: string) => void;
  readonly onRequest?: () => void;
  readonly port?: number;
  /** Absent means the stream route refuses rather than inventing an empty page. */
  readonly subscriptions?: SubscriptionPort;
}

const COMMAND_PATH = "/command";
const EVENT_PAGE_PATH = "/events/read";
const EVENT_ACKNOWLEDGE_PATH = "/events/ack";
const AFFORDANCE_PATH = "/affordances/read";
const GRAPH_GET_PATH = "/graph/get";

/** The JSON surface. Anything else is either a hosted asset or an unknown route. */
const JSON_ROUTES: readonly string[] = Object.freeze([
  AFFORDANCE_PATH,
  COMMAND_PATH,
  DOCUMENT_DOSSIER_PATH,
  EVENT_ACKNOWLEDGE_PATH,
  EVENT_PAGE_PATH,
  GRAPH_GET_PATH,
]);

type ReplyHeaders = Readonly<Record<string, string>>;

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
  const eventRequest = readEventRequest(body);
  if (eventRequest === null) {
    refuseRequest(response, "LISTENER_STREAM_REQUEST_INVALID");
    return;
  }
  // Always 200: the frame IS the answer and carries its own outcome, code and
  // layer. Minting an HTTP status per frame would be the translation table the
  // seam is forbidden to hold.
  reply(response, 200, readEventPage(options.subscriptions, eventRequest));
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
  const eventRequest = readEventAcknowledgeRequest(body);
  if (eventRequest === null) {
    refuseRequest(response, "LISTENER_STREAM_REQUEST_INVALID");
    return;
  }
  reply(response, 200, acknowledgeEventPage(options.subscriptions, eventRequest));
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

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartListenerOptions,
  authority: string,
  origin: string,
  assets: ControlRoomAssetRoot | null,
): Promise<void> {
  options.onRequest?.();
  // Logged without the credential and without a query string, so neither can
  // leak into a log line (design 19.2).
  const path = (request.url ?? "").split("?")[0] ?? "";
  options.log?.(`${request.method ?? "?"} ${path}`);

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
  const body = await readBoundedBody(request);
  if (body === null) {
    refuseRequest(response, "LISTENER_BODY_TOO_LARGE");
    return;
  }

  if (path === COMMAND_PATH) await serveCommand(response, request, options, body);
  else if (path === EVENT_PAGE_PATH) serveEventPage(response, request, options, body);
  else if (path === EVENT_ACKNOWLEDGE_PATH) serveEventAcknowledge(response, request, options, body);
  else if (path === AFFORDANCE_PATH) serveAffordances(response, request, options, body);
  else if (path === GRAPH_GET_PATH) serveGraphQuery(response, request, options, body);
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
  try {
    server = createServer((request, response) => {
      const served = serve(request, response, options, authority, origin, assets);
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
      await closeServer(bound);
      return refuse("LISTENER_BIND_FAILED");
    }
    const port = address.port;
    authority = authorityOf(host, port);
    origin = originOf(host, port);

    return Object.freeze({
      close: () => closeServer(bound),
      ok: true,
      origin,
      port,
    } as const);
  } catch {
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
