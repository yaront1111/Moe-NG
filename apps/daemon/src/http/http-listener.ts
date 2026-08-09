import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { handleCommandRequest } from "./http-adapter.js";
import { HTTP_INPUT_BOUNDS } from "./http-contract.js";
import type { CommandAdapterDeps, HttpCommandResult } from "./http-contract.js";

/**
 * The socket, and only the socket.
 *
 * Everything from authentication onward is already committed in
 * `handleCommandRequest`, which begins at `authenticate` and never sees headers.
 * So this module owns exactly what the adapter cannot: the bind, the Host and
 * Origin checks, the CSRF token and the body bound. It performs NO
 * authentication, NO capability check, NO decode and NO error mapping of its
 * own — duplicating any of those would be a second authority that can drift
 * from the first.
 */
export const CONTROL_ROOM_LISTENER_LAYER = "CONTROL_ROOM_LISTENER" as const;

/**
 * Every refusal this layer can emit. Frozen and closed so a consumer can switch
 * exhaustively; a code produced here but absent from this list is a defect.
 */
export const LISTENER_REFUSAL_CODES = Object.freeze([
  "LISTENER_BODY_TOO_LARGE",
  "LISTENER_CSRF_INVALID",
  "LISTENER_HOST_INVALID",
  "LISTENER_NON_LOOPBACK_BIND",
  "LISTENER_ORIGIN_INVALID",
  "LISTENER_ROUTE_UNKNOWN",
  "LISTENER_BIND_FAILED",
] as const);
export type ListenerRefusalCode = (typeof LISTENER_REFUSAL_CODES)[number];

/** Only these may be bound. A hostname is not accepted: it could resolve off-loopback. */
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1"]);

export interface ControlRoomListener {
  close(): Promise<void>;
  readonly ok: true;
  readonly origin: string;
  readonly port: number;
}

export interface ListenerRefused {
  readonly code: ListenerRefusalCode;
  readonly layer: typeof CONTROL_ROOM_LISTENER_LAYER;
  readonly ok: false;
}

export type StartListenerResult = ControlRoomListener | ListenerRefused;

export interface StartListenerOptions {
  readonly credential?: string;
  readonly csrfToken: string;
  readonly deps: CommandAdapterDeps;
  readonly host?: string;
  readonly log?: (line: string) => void;
  readonly onRequest?: () => void;
  readonly port?: number;
}

function refuse(code: ListenerRefusalCode): ListenerRefused {
  return Object.freeze({ code, layer: CONTROL_ROOM_LISTENER_LAYER, ok: false } as const);
}

function statusFor(code: ListenerRefusalCode): number {
  if (code === "LISTENER_BODY_TOO_LARGE") return 413;
  if (code === "LISTENER_ROUTE_UNKNOWN") return 404;
  return 403;
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

function refuseRequest(response: ServerResponse, code: ListenerRefusalCode): void {
  reply(response, statusFor(code), { code, layer: CONTROL_ROOM_LISTENER_LAYER });
}

/**
 * Reads the body while enforcing the committed bound, and STOPS at the limit
 * rather than buffering the whole payload first — a limit enforced only after
 * the bytes are already in memory is not a limit.
 */
async function readBoundedBody(request: IncomingMessage): Promise<string | null> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > HTTP_INPUT_BOUNDS.maxBodyBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function checkHeaders(
  request: IncomingMessage,
  expectedAuthority: string,
  origin: string,
  csrfToken: string,
): ListenerRefusalCode | null {
  if (request.headers.host !== expectedAuthority) return "LISTENER_HOST_INVALID";
  // Absent and foreign are both refused: a missing Origin is not a safe default
  // for a state-changing request.
  if (request.headers.origin !== origin) return "LISTENER_ORIGIN_INVALID";
  if (request.headers["x-moe-csrf"] !== csrfToken) return "LISTENER_CSRF_INVALID";
  return null;
}

/** Serialized verbatim. The adapter chose the status and owns the codes. */
function replyWithAdapterResult(response: ServerResponse, result: HttpCommandResult): void {
  reply(response, result.httpStatus, result);
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
  options.log?.(`${request.method ?? "?"} ${(request.url ?? "").split("?")[0]}`);

  if ((request.url ?? "").split("?")[0] !== "/command") {
    refuseRequest(response, "LISTENER_ROUTE_UNKNOWN");
    return;
  }
  const headerFault = checkHeaders(request, authority, origin, options.csrfToken);
  if (headerFault !== null) {
    refuseRequest(response, headerFault);
    return;
  }
  const body = await readBoundedBody(request);
  if (body === null) {
    refuseRequest(response, "LISTENER_BODY_TOO_LARGE");
    return;
  }

  // The body stays RAW here. `credential` and `protocolVersion` travel out of
  // band precisely so authenticate and compatibility can both answer before
  // anything parses it — parsing first would move a decode ahead of
  // authenticate and change the committed refusal order.
  replyWithAdapterResult(
    response,
    handleCommandRequest(options.deps, {
      body,
      credential: options.credential ?? null,
      protocolVersion: request.headers["x-moe-protocol-version"] ?? null,
    }),
  );
}

export async function startControlRoomListener(
  options: StartListenerOptions,
): Promise<StartListenerResult> {
  const host = options.host ?? "127.0.0.1";
  // Refuses to START, not warns. Design 19.2: loopback is the only default
  // bind, and a transport that reaches a public interface on a host also
  // running agent processes is an exposure rather than a convenience.
  if (!LOOPBACK_HOSTS.includes(host)) return refuse("LISTENER_NON_LOOPBACK_BIND");

  let server: Server | null = null;
  try {
    server = createServer((request, response) => {
      void serve(request, response, options, authorityOf(), originOf()).catch(() => {
        // A throw from the handler must still answer and must still leave the
        // listener closable; it may never surface as a hung socket.
        if (!response.headersSent) reply(response, 500, { layer: CONTROL_ROOM_LISTENER_LAYER });
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

    function authorityOf(): string {
      return `${host}:${port}`;
    }
    function originOf(): string {
      return `http://${host}:${port}`;
    }

    return Object.freeze({
      close: () => closeServer(bound),
      ok: true,
      origin: originOf(),
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
