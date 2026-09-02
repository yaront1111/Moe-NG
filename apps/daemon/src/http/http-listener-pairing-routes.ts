import type { IncomingMessage, ServerResponse } from "node:http";

import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  checkHeaders,
  protocolVersionOf,
  readBoundedBody,
  statusFor,
} from "./http-listener-guards.js";
import type { ListenerRefusalCode } from "./http-listener-guards.js";
import {
  PAIRING_APPROVAL_MAX_BODY_BYTES,
  PAIRING_CLAIM_MAX_BODY_BYTES,
  PAIRING_CLAIM_PATH,
  PAIRING_REQUEST_PATH,
  pairingApprovalStatusFor,
} from "./pairing-approval-handshake.js";
import type { PairingApprovalHandshakePort } from "./pairing-approval-handshake.js";
import {
  PAIRING_OPEN_MAX_BODY_BYTES,
  PAIRING_OPEN_PATH,
  pairingOpenStatusFor,
} from "./pairing-open-completion.js";
import type { PairingOpenCompletionPort } from "./pairing-open-completion.js";
import { CONTROL_ROOM_ASSET_RESPONSE_HEADERS } from "./static-asset-host.js";
// The ONE copy of the wire helpers, consumed rather than duplicated. `refuseRequest`
// emits content-type plus whatever policy headers the caller passes, which is exactly
// what the ingress routes below have always emitted; `wireRefusal` would additionally
// stamp RESPONSE_HEADERS on every refusal and change bytes on the wire.
import { refuseRequest, reply } from "./http-listener-command-stream-routes.js";
import { COMMAND_AUTHORITY_PLANES } from "./http-contract.js";
import type { CommandAuthorityPlane } from "./http-contract.js";
// TYPE-ONLY. A value import of a symbol declared in the facade that dispatches to this
// module would close a real runtime cycle through the .js bridges - one that typechecks
// clean and can leave a handler undefined at bind time.
import type { StartListenerOptions } from "./http-listener.js";

export const PAIRING_OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel" as const;

const OPERATOR_PROMPT =
  "A browser wants to pair. Type the code shown in that browser here, then press Enter.";
const NO_OPERATOR_PROMPT =
  "A browser wants to pair, but this daemon has no operator terminal. Stop it and run pnpm start from a terminal window.";

export interface ServePairingHandshakeOptions {
  readonly authority: string;
  /**
   * The open completion, or null when this daemon composes no session authority. A
   * missing port refuses like a missing handshake rather than answering: a route that
   * cannot verify a proof must never look like one that verified it.
   */
  readonly completion: PairingOpenCompletionPort | null;
  readonly csrfToken: string;
  readonly exactPath: boolean;
  readonly handshake: PairingApprovalHandshakePort | null;
  readonly log: (line: string) => void;
  readonly operatorChannelAvailable: boolean;
  readonly origin: string;
  readonly path:
    | typeof PAIRING_CLAIM_PATH
    | typeof PAIRING_OPEN_PATH
    | typeof PAIRING_REQUEST_PATH;
}

const RESPONSE_HEADERS = Object.freeze({
  ...CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  "cache-control": "no-store",
});

function wireReply(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { ...RESPONSE_HEADERS, ...headers, "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function wireRefusal(response: ServerResponse, code: ListenerRefusalCode): void {
  wireReply(response, statusFor(code), { code, layer: CONTROL_ROOM_LISTENER_LAYER });
}

export async function servePairingHandshakeRoute(
  response: ServerResponse,
  request: IncomingMessage,
  options: ServePairingHandshakeOptions,
): Promise<void> {
  const headerFault = checkHeaders(request, options.authority, options.origin, options.csrfToken);
  if (headerFault !== null) return wireRefusal(response, headerFault);
  if (!options.exactPath) return wireRefusal(response, "LISTENER_ROUTE_UNKNOWN");
  if (request.method !== "POST") {
    return wireRefusal(response, "LISTENER_PAIRING_METHOD_INVALID");
  }
  if (protocolVersionOf(request) !== WIRE_PROTOCOL_VERSION) {
    return wireRefusal(response, "LISTENER_PAIRING_PROTOCOL_UNSUPPORTED");
  }
  // THE OPEN COMPLETION IS ITS OWN LEG. It composes the session authority rather than the
  // approval window, so it needs neither an approval handshake nor the operator channel
  // header, and its refusals carry the AUTHORITY's codes. Handling it above the shared
  // body is what keeps `pairingApprovalStatusFor` from being asked about a code that is
  // not in its roster.
  if (options.path === PAIRING_OPEN_PATH) {
    if (options.completion === null) {
      return wireRefusal(response, "LISTENER_PAIRING_UNAVAILABLE");
    }
    const openBody = await readBoundedBody(request, PAIRING_OPEN_MAX_BODY_BYTES);
    if (openBody === null) return wireRefusal(response, "LISTENER_BODY_TOO_LARGE");
    const completed = options.completion.complete(openBody);
    return completed.ok
      ? wireReply(response, 200, { ...completed, protocolVersion: WIRE_PROTOCOL_VERSION })
      : wireReply(response, pairingOpenStatusFor(completed.code), {
        code: completed.code, layer: completed.layer,
      });
  }
  if (options.handshake === null) return wireRefusal(response, "LISTENER_PAIRING_UNAVAILABLE");
  // PER-ROUTE BOUND, selected by path. The REQUEST path keeps the 96 it shares with the manager
  // surface; only the CLAIM path gets the wider bound, because only a claim carries a possession
  // proof. Reading both with one constant is what would have coupled the two authorities.
  const maxBodyBytes = options.path === PAIRING_CLAIM_PATH
    ? PAIRING_CLAIM_MAX_BODY_BYTES
    : PAIRING_APPROVAL_MAX_BODY_BYTES;
  const body = await readBoundedBody(request, maxBodyBytes);
  if (body === null) return wireRefusal(response, "LISTENER_BODY_TOO_LARGE");
  const outcome = options.path === PAIRING_REQUEST_PATH
    ? options.handshake.request(body)
    : options.handshake.claim(body);
  if (!outcome.ok) {
    return wireReply(response, pairingApprovalStatusFor(outcome.code), {
      ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
      code: outcome.code,
      layer: outcome.layer,
    });
  }
  if (options.path === PAIRING_CLAIM_PATH) {
    return wireReply(response, 200, { ...outcome, protocolVersion: WIRE_PROTOCOL_VERSION });
  }
  wireReply(response, 200, outcome, {
    [PAIRING_OPERATOR_CHANNEL_HEADER]: String(options.operatorChannelAvailable),
  });
  options.log(options.operatorChannelAvailable ? OPERATOR_PROMPT : NO_OPERATOR_PROMPT);
}

/**
 * The path the retired authenticated approval route used to occupy. Kept ONLY as a
 * literal to answer with, never re-advertised: a hosted listener must not fall through
 * to the asset host for it, and both listeners must answer a probe the same way.
 */
const RETIRED_PAIRING_APPROVE_PATH = "/session/pair/approve";

/**
 * The handshake surface. Deliberately OUTSIDE `JSON_ROUTES` because its request
 * and claim routes have their own guard order: bootstrap and request carry no
 * credential, while claim carries CSRF/Origin and may mint only after in-process
 * operator approval. The legacy path below is a non-minting tombstone.
 */
const BOOTSTRAP_PATH = "/bootstrap";
const SESSION_PAIR_PATH = "/session/pair";

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
  const body = composeBootstrapBody(options, pairing.boundProjectId);
  // A plane this listener cannot serve is not stated. V2 with no `/2` registry
  // would send every browser write to a 503; the same unavailable code is the
  // honest answer here, before the browser commits to a route.
  if (body.commandAuthorityPlane === "V2" && options.v2Deps === undefined) {
    refuseRequest(response, "LISTENER_V2_COMMAND_UNAVAILABLE", policy);
    return;
  }
  reply(response, 200, body, policy);
}

/**
 * The exact `/bootstrap` body. Exported for `tests/integration`, where the real
 * browser-client admission is fed THIS composition rather than a hand-written
 * fixture of it. The plane is read per request: a daemon that activates `/2`
 * while a browser is open answers V2 to that browser's next bootstrap without a
 * restart. A reader that answers outside the plane roster THROWS, which the
 * request loop reports as LISTENER_REQUEST_FAILED; it is never coerced to V1.
 */
export function composeBootstrapBody(
  options: Pick<StartListenerOptions, "commandAuthorityPlane" | "csrfToken">,
  boundProjectId: string,
): Readonly<{
  readonly commandAuthorityPlane: CommandAuthorityPlane;
  readonly csrfToken: string;
  readonly projectId: string;
  readonly protocolVersion: typeof WIRE_PROTOCOL_VERSION;
}> {
  const plane: unknown = options.commandAuthorityPlane === undefined
    ? "V1" : options.commandAuthorityPlane.readPlane();
  if (typeof plane !== "string"
    || !(COMMAND_AUTHORITY_PLANES as readonly string[]).includes(plane)) {
    throw new Error("COMMAND_AUTHORITY_PLANE_INVALID");
  }
  return Object.freeze({
    commandAuthorityPlane: plane as CommandAuthorityPlane,
    csrfToken: options.csrfToken,
    projectId: boundProjectId,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

/**
 * Compatibility tombstone for the removed bearer mint. It retains the route's
 * transport guard order but owns no token state and can never mint a session.
 */
async function serveSessionPair(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  authority: string,
  origin: string,
): Promise<void> {
  const policy = RESPONSE_HEADERS;
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
  refuseRequest(response, "LISTENER_PAIRING_UNAVAILABLE", policy);
}

/**
 * What the facade knows and this ingress needs: the request identity it already derived
 * and the two ports it composed at startup. Bundled so the dispatch below stays the bytes
 * it was inside `serve()`.
 */
export interface HandshakeIngressContext {
  readonly authority: string;
  readonly completion: PairingOpenCompletionPort | null;
  readonly handshake: PairingApprovalHandshakePort | null;
  readonly origin: string;
  readonly path: string;
  /** The URL before the query string was stripped; `exactPath` is derived from it. */
  readonly rawPath: string;
}

/**
 * THE WHOLE HANDSHAKE SURFACE, answered BEFORE the JSON/asset split. Returns true when it
 * answered, so the facade delegates to the read dispatch only for a path no route here
 * owns. ORDER IS THE BEHAVIOUR: bootstrap, session-pair, request/claim/open, then the
 * retired-approve tombstone - and the tombstone still precedes any hosted-asset fallback,
 * so a hosted and an unhosted listener answer a probe identically.
 */
export async function serveHandshakeIngress(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  context: HandshakeIngressContext,
): Promise<boolean> {
  const { authority, origin, path, rawPath } = context;
  const pairingApproval = context.handshake;
  const pairingCompletion = context.completion;
  // The handshake surface answers ahead of the asset/JSON split: it is neither an
  // asset nor a member of the shared-guard JSON set, and each route owns its own
  // guard order stated in its handler.
  if (path === BOOTSTRAP_PATH) {
    serveBootstrap(response, request, options, authority);
    return true;
  }
  if (path === SESSION_PAIR_PATH) {
    await serveSessionPair(response, request, options, authority, origin);
    return true;
  }
  if (path === PAIRING_REQUEST_PATH || path === PAIRING_CLAIM_PATH
    || path === PAIRING_OPEN_PATH) {
    await servePairingHandshakeRoute(response, request, {
      authority,
      completion: pairingCompletion,
      csrfToken: options.csrfToken,
      exactPath: rawPath === path,
      handshake: pairingApproval,
      log: options.log ?? (() => undefined),
      operatorChannelAvailable: options.pairingOperatorChannelAvailable ?? false,
      origin,
      path,
    });
    return true;
  }
  // task-82c28bf1 (R3-1): there is NO authenticated HTTP approval route. ADMIN is a reach
  // capability, so an ADMIN-only gate never asked WHO was approving and a scoped agent
  // could approve its own pairing label and claim operator capabilities. Approval is
  // terminal-only now, through ControlRoomListener.approvePairing, which the operator's
  // own stdin line reaches. The literal path is answered here - before any hosted-asset
  // fallback, and without authenticating, reading a body, or naming what used to live at
  // it - so a hosted and an unhosted listener answer a probe identically.
  if (path === RETIRED_PAIRING_APPROVE_PATH) {
    refuseRequest(response, "LISTENER_ROUTE_UNKNOWN");
    return true;
  }
  return false;
}
