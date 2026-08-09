import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { readAffordanceRequest } from "./affordance-contract.js";
import type { AffordancePort } from "./affordance-contract.js";
import { DOCUMENT_DOSSIER_PATH, handleDocumentDossierReadRequest } from "./document-dossier-read.js";
import type { DocumentDossierReadPort } from "./document-dossier-read.js";
import type { SubscriptionPort } from "./event-stream-contract.js";
import { readEventPage } from "./event-stream.js";
import { handleCommandRequest } from "./http-adapter.js";
import type { CommandAdapterDeps, HttpCommandResult } from "./http-contract.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  authorityOf,
  checkHeaders,
  credentialOf,
  isLoopbackHost,
  originOf,
  protocolVersionOf,
  readBoundedBody,
  readEventRequest,
  refuse,
  statusFor,
} from "./http-listener-guards.js";
import type { ListenerRefusalCode, ListenerRefused } from "./http-listener-guards.js";

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
  readonly csrfToken: string;
  readonly deps: CommandAdapterDeps;
  /** Absent means an authenticated dossier read refuses rather than inventing one. */
  readonly documentDossiers?: DocumentDossierReadPort;
  readonly host?: string;
  readonly log?: (line: string) => void;
  readonly onRequest?: () => void;
  readonly port?: number;
  /** Absent means the stream route refuses rather than inventing an empty page. */
  readonly subscriptions?: SubscriptionPort;
}

const COMMAND_PATH = "/command";
const EVENT_PAGE_PATH = "/events/read";
const AFFORDANCE_PATH = "/affordances/read";

function reply(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

function refuseRequest(response: ServerResponse, code: ListenerRefusalCode): void {
  reply(response, statusFor(code), { code, layer: CONTROL_ROOM_LISTENER_LAYER });
}

function serveCommand(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  // The body stays RAW here. `credential` and `protocolVersion` travel out of
  // band precisely so authenticate and compatibility can both answer before
  // anything parses it — parsing first would move a decode ahead of
  // authenticate and change the committed refusal order.
  const result: HttpCommandResult = handleCommandRequest(options.deps, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  // Serialized verbatim. The adapter chose the status and owns the codes.
  reply(response, result.httpStatus, result);
}

function serveEventPage(
  response: ServerResponse,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  if (options.subscriptions === undefined) {
    refuseRequest(response, "LISTENER_STREAM_UNAVAILABLE");
    return;
  }
  const request = readEventRequest(body);
  if (request === null) {
    refuseRequest(response, "LISTENER_STREAM_REQUEST_INVALID");
    return;
  }
  // Always 200: the frame IS the answer and carries its own outcome, code and
  // layer. Minting an HTTP status per frame would be the translation table the
  // seam is forbidden to hold.
  reply(response, 200, readEventPage(options.subscriptions, request));
}

function serveAffordances(
  response: ServerResponse,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  if (options.affordances === undefined) {
    refuseRequest(response, "LISTENER_AFFORDANCES_UNAVAILABLE");
    return;
  }
  if (readAffordanceRequest(body) === null) {
    refuseRequest(response, "LISTENER_AFFORDANCE_REQUEST_INVALID");
    return;
  }
  // Always 200: the frame carries its own outcome, code and layer, exactly
  // like the event page — the seam holds no translation table.
  reply(response, 200, options.affordances.readSurface());
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

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartListenerOptions,
  authority: string,
  origin: string,
): Promise<void> {
  options.onRequest?.();
  // Logged without the credential and without a query string, so neither can
  // leak into a log line (design 19.2).
  const path = (request.url ?? "").split("?")[0] ?? "";
  options.log?.(`${request.method ?? "?"} ${path}`);

  if (path !== COMMAND_PATH && path !== EVENT_PAGE_PATH && path !== AFFORDANCE_PATH
    && path !== DOCUMENT_DOSSIER_PATH) {
    refuseRequest(response, "LISTENER_ROUTE_UNKNOWN");
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

  if (path === COMMAND_PATH) serveCommand(response, request, options, body);
  else if (path === EVENT_PAGE_PATH) serveEventPage(response, options, body);
  else if (path === AFFORDANCE_PATH) serveAffordances(response, options, body);
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

  let server: Server | null = null;
  try {
    server = createServer((request, response) => {
      void serve(request, response, options, authorityOf(host, port), originOf(host, port)).catch(() => {
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

    return Object.freeze({
      close: () => closeServer(bound),
      ok: true,
      origin: originOf(host, port),
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
