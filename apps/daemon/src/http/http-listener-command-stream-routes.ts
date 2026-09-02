import type { IncomingMessage, ServerResponse } from "node:http";

import {
  affordanceProjectMismatch,
  affordanceProjectRefusal,
  readAffordanceRequest,
} from "./affordance-contract.js";
import { acknowledgeEventPage, readEventPage } from "./event-stream.js";
import {
  eventStreamAccessUnavailable, eventStreamSubscriberMismatch,
} from "./event-stream-access.js";
import type { EventStreamAccessDecision } from "./event-stream-access.js";
import {
  EVENT_STREAM_RESUME_LAYER, EVENT_STREAM_RESUME_LEGACY_ROUTE_REFUSAL_CODE,
} from "./event-resume-command.js";
import { authenticateHttpRequest, handleAsyncCommandRequest } from "./http-adapter.js";
import type { HttpCommandResult } from "./http-contract.js";
import { answerGatedGraphQuery, gateGraphQuery } from "../planning/graph-query.js";
import {
  CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  assetIsUnchanged,
  locateControlRoomAsset,
  readControlRoomAssetBytes,
} from "./static-asset-host.js";
import type { ControlRoomAssetRoot } from "./static-asset-host.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  credentialOf,
  protocolVersionOf,
  readEventAcknowledgeRequest,
  readEventRequest,
  statusFor,
} from "./http-listener-guards.js";
import type { ListenerRefusalCode } from "./http-listener-guards.js";
// TYPE-ONLY, and it must stay that way. `StartListenerOptions` is declared in the facade
// this module is dispatched FROM, so a value import here would close a real runtime cycle
// through the .js bridges - one that typechecks clean and can leave a handler undefined at
// bind time. A type import is erased before the module ever runs.
import type { StartListenerOptions } from "./http-listener.js";

/**
 * THE COMMAND AND STREAM SURFACE, extracted VERBATIM from `http-listener.ts`, which kept
 * the socket, the dispatch order and the public contract. Nothing here decides
 * differently than it did in the facade: the same guards run in the same order and the
 * same codes travel out. The wire helpers live here because this is the first module that
 * needs them; the read dispatch and the handshake ingress consume them from here rather
 * than growing a second copy that could drift.
 *
 * `serveAsset` sits here for a SIZE reason, stated plainly rather than dressed up as a
 * concern: origin/main added the product-contract-v2 route family after this split was
 * planned, and with the asset handler included the read dispatch measured 436 physical
 * lines - past the 400 cap. The owned-path roster is fixed at ten, so a third route
 * module is not available; `serveAsset` is the one whole, self-contained handler whose
 * relocation rebalances the two files without cutting a function in half. It is
 * dispatched from `http-listener-read-dispatch.ts`, which still owns the asset FALLBACK
 * decision (`assets === null`) and therefore still owns the routing behaviour.
 */

export const COMMAND_PATH = "/command";
export const V2_COMMAND_PATH = "/v2/command";
export const EVENT_PAGE_PATH = "/events/read";
export const EVENT_ACKNOWLEDGE_PATH = "/events/ack";
export const EVENT_RESUME_PATH = "/events/resume";
export const AFFORDANCE_PATH = "/affordances/read";
export const GRAPH_GET_PATH = "/graph/get";

export type ReplyHeaders = Readonly<Record<string, string>>;

export function reply(
  response: ServerResponse, status: number, body: unknown, headers: ReplyHeaders = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...headers, "content-type": "application/json" });
  response.end(payload);
}

/** Code and layer only: a refusal's `detail`, where one exists, never reaches the wire. */
export function refuseRequest(
  response: ServerResponse, code: ListenerRefusalCode, headers: ReplyHeaders = {},
): void {
  reply(response, statusFor(code), { code, layer: CONTROL_ROOM_LISTENER_LAYER }, headers);
}

export function replyEventStreamAccessRefusal(
  response: ServerResponse,
  refusal: Exclude<EventStreamAccessDecision, { readonly ok: true }>,
): void {
  reply(response, refusal.httpStatus, {
    code: refusal.code,
    layer: refusal.layer,
    outcome: "REFUSED",
  });
}

export async function serveCommand(
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
  }, "HTTP_LISTENER");
  // Serialized verbatim. The adapter chose the status and owns the codes.
  reply(response, result.httpStatus, result);
}

export async function serveV2Command(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): Promise<void> {
  if (options.v2Deps === undefined) {
    refuseRequest(response, "LISTENER_V2_COMMAND_UNAVAILABLE");
    return;
  }
  const result: HttpCommandResult = await handleAsyncCommandRequest(options.v2Deps, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  }, "HTTP_LISTENER");
  reply(response, result.httpStatus, result);
}

export function serveEventPage(
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

export function serveEventAcknowledge(
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
export function serveEventResume(
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

export function serveAffordances(
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
  if (access.principal.projectId !== options.affordances.boundProjectId) {
    reply(response, 200, affordanceProjectRefusal());
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
export function serveGraphQuery(
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
export function serveAsset(
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
