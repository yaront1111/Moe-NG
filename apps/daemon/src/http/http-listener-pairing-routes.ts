import { createRuntimeError } from "@moe/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { authenticateHttpRequest } from "./http-adapter.js";
import type {
  AuthenticatedPrincipal,
  Authenticator,
  HttpPortRefused,
  HttpRefused,
} from "./http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  checkHeaders,
  credentialOf,
  protocolVersionOf,
  readBoundedBody,
  readPairingApproveRequest,
  statusFor,
} from "./http-listener-guards.js";
import type { ListenerRefusalCode } from "./http-listener-guards.js";
import {
  PAIRING_APPROVAL_LAYER,
  refusePairingApproval,
} from "./pairing-approval-window.js";
import type {
  PairingApprovalGranted,
  PairingApprovalRefusal,
  PairingApprovalRefusalCode,
  PairingApprovalWindow,
} from "./pairing-approval-window.js";
import {
  PAIRING_APPROVAL_MAX_BODY_BYTES,
  PAIRING_CLAIM_PATH,
  PAIRING_REQUEST_PATH,
  pairingApprovalStatusFor,
} from "./pairing-approval-handshake.js";
import type { PairingApprovalHandshakePort } from "./pairing-approval-handshake.js";
import { CONTROL_ROOM_ASSET_RESPONSE_HEADERS } from "./static-asset-host.js";

export const PAIRING_APPROVE_PATH = "/session/pair/approve" as const;
export const PAIRING_OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel" as const;

const OPERATOR_PROMPT =
  "A browser wants to pair. Type the code shown in that browser here, then press Enter.";
const NO_OPERATOR_PROMPT =
  "A browser wants to pair, but this daemon has no operator terminal. Stop it and run pnpm start from a terminal window.";

export interface PairingApproveDependencies {
  readonly approvalWindow: PairingApprovalWindow;
  readonly authenticator: Authenticator;
  readonly pairing?: SessionHandshakePort | undefined;
}

export interface PairingApproveRequest {
  readonly body: unknown;
  readonly credential: string | null;
  readonly protocolVersion: unknown;
}

export interface ServePairingApproveOptions extends PairingApproveDependencies {
  readonly authority: string;
  readonly csrfToken: string;
  readonly exactPath: boolean;
  readonly origin: string;
}

export interface ServePairingHandshakeOptions {
  readonly authority: string;
  readonly csrfToken: string;
  readonly exactPath: boolean;
  readonly handshake: PairingApprovalHandshakePort | null;
  readonly log: (line: string) => void;
  readonly operatorChannelAvailable: boolean;
  readonly origin: string;
  readonly path: typeof PAIRING_REQUEST_PATH | typeof PAIRING_CLAIM_PATH;
}

export interface PairingApprovalRouteRefused {
  readonly code: PairingApprovalRefusalCode;
  readonly layer: typeof PAIRING_APPROVAL_LAYER;
}

export interface PairingApprovalRouteReply {
  readonly body:
    | HttpPortRefused
    | HttpRefused
    | PairingApprovalGranted
    | PairingApprovalRouteRefused;
  readonly httpStatus: number;
  readonly kind: "REPLY";
}

const CAPABILITY_DENIED = createRuntimeError({ code: "CAPABILITY_DENIED" });
const SAFE_AUTHENTICATION_DETAIL = "authentication refused";
const RESPONSE_HEADERS = Object.freeze({
  ...CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  "cache-control": "no-store",
});

function reply(
  httpStatus: number,
  body: PairingApprovalRouteReply["body"],
): PairingApprovalRouteReply {
  return Object.freeze({ body, httpStatus, kind: "REPLY" as const });
}

function authorizeRefusal(): PairingApprovalRouteReply {
  return reply(CAPABILITY_DENIED.transport.httpStatus, Object.freeze({
    error: CAPABILITY_DENIED,
    httpStatus: CAPABILITY_DENIED.transport.httpStatus,
    ok: false as const,
    outcome: "REFUSED" as const,
    stage: "AUTHORIZE" as const,
  }));
}

function accessRefusal(access: HttpPortRefused | HttpRefused): PairingApprovalRouteReply {
  if (access.outcome !== "PORT_REFUSED") return reply(access.httpStatus, access);
  return reply(access.httpStatus, Object.freeze({
    ...access,
    refusal: Object.freeze({
      ...access.refusal,
      detail: SAFE_AUTHENTICATION_DETAIL,
    }),
  }));
}

function pairingRefusal(
  refusal: PairingApprovalRefusal,
): PairingApprovalRouteReply {
  return reply(pairingApprovalStatusFor(refusal.code), Object.freeze({
    code: refusal.code,
    layer: refusal.layer,
  }));
}

export function handlePairingApproveRequest(
  dependencies: PairingApproveDependencies,
  request: PairingApproveRequest,
): PairingApprovalRouteReply {
  const access = authenticateHttpRequest(
    dependencies.authenticator, request.credential, request.protocolVersion,
  );
  if (!access.ok) return accessRefusal(access);
  return approveAuthenticated(dependencies, access.principal, request.body);
}

function approveAuthenticated(
  dependencies: PairingApproveDependencies,
  principal: AuthenticatedPrincipal,
  body: unknown,
): PairingApprovalRouteReply {
  if (dependencies.pairing === undefined) {
    return pairingRefusal(refusePairingApproval("PAIRING_APPROVAL_UNAVAILABLE"));
  }
  if (principal.projectId !== dependencies.pairing.boundProjectId) {
    return authorizeRefusal();
  }
  if (!principal.capabilities.includes(CAPABILITIES.ADMIN)) return authorizeRefusal();

  const confirmationLabel = readPairingApproveRequest(body);
  if (confirmationLabel === null) {
    return pairingRefusal(refusePairingApproval("PAIRING_CONFIRMATION_INVALID"));
  }
  const outcome = dependencies.approvalWindow.operator.approve(confirmationLabel);
  return outcome.ok ? reply(200, outcome) : pairingRefusal(outcome);
}

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

export async function servePairingApproveRoute(
  response: ServerResponse,
  request: IncomingMessage,
  options: ServePairingApproveOptions,
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
  const access = authenticateHttpRequest(
    options.authenticator, credentialOf(request), protocolVersionOf(request),
  );
  if (!access.ok) {
    const dispatch = accessRefusal(access);
    return wireReply(response, dispatch.httpStatus, dispatch.body);
  }
  const body = await readBoundedBody(request, PAIRING_APPROVAL_MAX_BODY_BYTES);
  if (body === null) return wireRefusal(response, "LISTENER_BODY_TOO_LARGE");
  const dispatch = approveAuthenticated(options, access.principal, body);
  wireReply(response, dispatch.httpStatus, dispatch.body);
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
  if (options.handshake === null) return wireRefusal(response, "LISTENER_PAIRING_UNAVAILABLE");
  const body = await readBoundedBody(request, PAIRING_APPROVAL_MAX_BODY_BYTES);
  if (body === null) return wireRefusal(response, "LISTENER_BODY_TOO_LARGE");
  const outcome = options.path === PAIRING_REQUEST_PATH
    ? options.handshake.request(body)
    : options.handshake.claim(body);
  if (!outcome.ok) {
    return wireReply(response, pairingApprovalStatusFor(outcome.code), {
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
