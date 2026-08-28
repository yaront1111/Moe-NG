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
  PAIRING_CLAIM_PATH,
  PAIRING_REQUEST_PATH,
  pairingApprovalStatusFor,
} from "./pairing-approval-handshake.js";
import type { PairingApprovalHandshakePort } from "./pairing-approval-handshake.js";
import { CONTROL_ROOM_ASSET_RESPONSE_HEADERS } from "./static-asset-host.js";

export const PAIRING_OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel" as const;

const OPERATOR_PROMPT =
  "A browser wants to pair. Type the code shown in that browser here, then press Enter.";
const NO_OPERATOR_PROMPT =
  "A browser wants to pair, but this daemon has no operator terminal. Stop it and run pnpm start from a terminal window.";

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
