import type { RuntimeCommandEnvelope } from "@moe/contracts";

/**
 * The send path, and only the send path.
 *
 * It carries an envelope a GENERATED builder produced to the daemon and hands
 * back what the daemon said, unchanged. It builds no envelope, validates no
 * field, and re-codes no refusal: the builders own envelope shape, the daemon's
 * decoder owns field validity, and the daemon owns its own error vocabulary.
 * A second opinion on any of the three would be a competing authority that
 * drifts silently.
 */
export const CONTROL_ROOM_TRANSPORT_LAYER = "CONTROL_ROOM_TRANSPORT" as const;

/**
 * Everything this layer can say on its own behalf. Both members describe the
 * ROUND TRIP, never the daemon's answer, so a daemon code can never appear here.
 */
export const TRANSPORT_REFUSAL_CODES = Object.freeze([
  "TRANSPORT_REQUEST_FAILED",
  "TRANSPORT_RESPONSE_UNREADABLE",
] as const);

export type TransportRefusalCode = (typeof TRANSPORT_REFUSAL_CODES)[number];

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  readonly csrfToken: string;
  /** Injected for tests; production uses the ambient `fetch`. */
  readonly fetch?: FetchLike | undefined;
  readonly origin: string;
  /** Sent in a header on every request, never on a URL (design 19.2). */
  readonly sessionCredential: string;
  /**
   * Supplied by the caller, deliberately NOT imported from the generated
   * module. The generated surface is reachable only through a matching compat
   * gate, and `wireProtocolVersion` is one of the values it withholds — a build
   * whose pins do not match should not learn the protocol string it failed to
   * match. Importing it here would hand that string to any ungated caller who
   * constructs a transport with a stub fetch and reads one header.
   */
  readonly wireProtocolVersion: string;
}

/**
 * Structurally the daemon's committed `EventReadRequest`, declared here because
 * this package cannot depend on `apps/daemon` without inverting the
 * architecture's dependency arrow. The daemon remains the only validator.
 */
export interface EventPageRequest {
  readonly limit?: number;
  readonly projection: string;
  readonly subscriberId: string;
}

export interface TransportRefused {
  readonly code: TransportRefusalCode;
  readonly delivered: false;
  readonly layer: typeof CONTROL_ROOM_TRANSPORT_LAYER;
}

export interface DaemonAnswer {
  readonly delivered: true;
  readonly response: unknown;
  readonly status: number;
}

/**
 * `delivered` separates the two failures that are otherwise easy to confuse: a
 * daemon that refused (delivered, and its own answer is the refusal) from a
 * daemon that never answered (not delivered, and the code is ours).
 */
export type SendResult = DaemonAnswer | TransportRefused;

export interface ControlRoomTransport {
  readDocumentDossier(): Promise<SendResult>;
  readEventPage(request: EventPageRequest): Promise<SendResult>;
  sendCommand(envelope: RuntimeCommandEnvelope): Promise<SendResult>;
}

const COMMAND_PATH = "/command";
const DOCUMENT_DOSSIER_PATH = "/documents/dossier/read";
const EVENT_PAGE_PATH = "/events/read";

function refuse(code: TransportRefusalCode): TransportRefused {
  return Object.freeze({ code, delivered: false, layer: CONTROL_ROOM_TRANSPORT_LAYER } as const);
}

function headersFor(options: TransportOptions): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    origin: options.origin,
    "x-moe-csrf": options.csrfToken,
    "x-moe-protocol-version": options.wireProtocolVersion,
    "x-moe-session-credential": options.sessionCredential,
  };
}

async function post(
  options: TransportOptions,
  path: string,
  body: unknown,
): Promise<SendResult> {
  const send: FetchLike = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await send(`${options.origin}${path}`, {
      body: JSON.stringify(body),
      headers: headersFor(options),
      method: "POST",
    });
  } catch {
    // Nothing was delivered, so no daemon field is invented for an answer that
    // does not exist.
    return refuse("TRANSPORT_REQUEST_FAILED");
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return refuse("TRANSPORT_RESPONSE_UNREADABLE");
  }
  // Verbatim. The daemon's code, stage and status are its own.
  return Object.freeze({ delivered: true, response: parsed, status: response.status } as const);
}

export function createControlRoomTransport(options: TransportOptions): ControlRoomTransport {
  return Object.freeze({
    readDocumentDossier: async () =>
      await post(options, DOCUMENT_DOSSIER_PATH, {}),
    readEventPage: async (request: EventPageRequest) =>
      await post(options, EVENT_PAGE_PATH, request),
    sendCommand: async (envelope: RuntimeCommandEnvelope) =>
      await post(options, COMMAND_PATH, envelope),
  });
}
