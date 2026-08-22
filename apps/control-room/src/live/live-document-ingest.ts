import { decodeDocumentWorkProposalBytes } from "@moe/contracts";

/**
 * The operator PRD-INGEST client: reads the daemon's bespoke write route
 * POST /documents/ingest and shapes what it says - verbatim - into one of three
 * honest outcomes (INGESTED / REFUSED / ERROR).
 *
 * Discipline copied from live-document-dossier.ts:
 *  - exactDataRecord: an own-enumerable EXACT-key snapshot. A daemon frame is
 *    accepted only when its key set is precisely the one this reader vouches for,
 *    so an extra or renamed field is a shape miss, never a silent pass.
 *  - refusalFrom: the three refusal envelopes the route can emit travel out at
 *    their own layer - the listener's { code, layer }, the service's six-key
 *    frame, and the adapter's { error, stage } - each carried through unchanged
 *    rather than flattened into a generic error.
 *  - the proposal is decoded through the PUBLIC @moe/contracts decoder
 *    (JSON.stringify -> TextEncoder -> decodeDocumentWorkProposalBytes), the same
 *    seam the dossier crosses, so the control room never re-implements the wire
 *    shape it must trust.
 *
 * The request body is the EXACT payload allow-list the route admits
 * ({ displayPath, mediaType, text, objective? }); any extra key is refused by the
 * daemon as DOCUMENT_WORK_INGEST_PAYLOAD_INVALID, so this client sends nothing
 * but the request object it was handed.
 */

const LIVE_DOCUMENT_LAYER = "CONTROL_ROOM_LIVE_DOCUMENTS";
const INVALID_RESPONSE_CODE = "DOCUMENT_INGEST_RESPONSE_INVALID";
const TRANSPORT_FAILED_CODE = "TRANSPORT_REQUEST_FAILED";
const INGEST_PATH = "/documents/ingest";
const REQUEST_TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();

/** The exact payload allow-list the daemon route admits; no other key is sent. */
export interface DocumentIngestRequest {
  readonly displayPath: string;
  readonly mediaType: string;
  readonly text: string;
  readonly objective?: string;
}

export type DocumentIngestOutcome =
  | {
    readonly status: "INGESTED";
    readonly contentSha256: string;
    readonly byteLength: number;
    readonly candidateTitle: string | null;
  }
  | { readonly status: "REFUSED"; readonly code: string; readonly layer: string }
  | { readonly status: "ERROR"; readonly code: string; readonly layer: string };

const INGESTED_KEYS = [
  "advisoryOnly", "authority", "byteLength", "contentSha256", "disposition", "ok",
  "outcome", "proposal", "proposalAggregateId", "proposalEventId", "sourceAggregateId",
  "sourceDisposition", "sourceEventId",
] as const;

function ingested(
  contentSha256: string, byteLength: number, candidateTitle: string | null,
): DocumentIngestOutcome {
  return Object.freeze({ byteLength, candidateTitle, contentSha256, status: "INGESTED" as const });
}

function refused(code: string, layer: string): DocumentIngestOutcome {
  return Object.freeze({ code, layer, status: "REFUSED" as const });
}

function errored(code: string, layer: string): DocumentIngestOutcome {
  return Object.freeze({ code, layer, status: "ERROR" as const });
}

function invalidResponse(): DocumentIngestOutcome {
  return errored(INVALID_RESPONSE_CODE, LIVE_DOCUMENT_LAYER);
}

/**
 * An own-enumerable EXACT-key snapshot: the value must be a plain object whose
 * key set is precisely `expectedKeys`, every one an own, enumerable data
 * property. Anything else - a prototype, an array, a missing or extra key, an
 * accessor - returns null so the caller never reads a field this reader has not
 * vouched for.
 */
function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/**
 * Recognises the four refusal envelopes the ingest route can emit and carries
 * each out at its OWN layer: the listener's two-key { code, layer }, the route's
 * own three-key { code, layer, outcome } (DOCUMENT_INGEST_CAPABILITY_DENIED and
 * DOCUMENT_INGEST_PROJECT_MISMATCH reply 200 with exactly this shape), the
 * service's six-key advisory frame, and the adapter's { error, stage } frame.
 * Any other answer is not a refusal this reader can vouch for and returns null.
 */
function refusalFrom(response: unknown): DocumentIngestOutcome | null {
  const listener = exactDataRecord(response, ["code", "layer"]);
  if (listener !== null && typeof listener.code === "string" && typeof listener.layer === "string") {
    return refused(listener.code, listener.layer);
  }
  // The route's own refusal frame: { code, layer, outcome:"REFUSED" }. It is a
  // 200, so without this branch it would fall through the INGESTED guard and be
  // mislabelled a generic INVALID, hiding the real capability/project code.
  const route = exactDataRecord(response, ["code", "layer", "outcome"]);
  if (route !== null && route.outcome === "REFUSED"
    && typeof route.code === "string" && typeof route.layer === "string") {
    return refused(route.code, route.layer);
  }
  const service = exactDataRecord(response, [
    "advisoryOnly", "authority", "code", "layer", "ok", "outcome",
  ]);
  if (service !== null
    && service.advisoryOnly === true && service.authority === "NONE"
    && service.ok === false && service.outcome === "REFUSED"
    && typeof service.code === "string" && typeof service.layer === "string") {
    return refused(service.code, service.layer);
  }
  const http = exactDataRecord(response, [
    "error", "httpStatus", "ok", "outcome", "stage",
  ]);
  if (http === null || http.ok !== false || http.outcome !== "REFUSED"
    || typeof http.stage !== "string") return null;
  const runtimeError = typeof http.error === "object" && http.error !== null
    ? Object.getOwnPropertyDescriptor(http.error, "code") : undefined;
  return runtimeError !== undefined && "value" in runtimeError
    && typeof runtimeError.value === "string"
    ? refused(runtimeError.value, http.stage) : null;
}

function encodedProposal(value: unknown): Uint8Array | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? encoder.encode(json) : null;
  } catch {
    return null;
  }
}

/**
 * Maps only an exact daemon ingest frame; every other answer becomes a visible
 * REFUSED (a daemon refusal, carried at its own layer) or ERROR (a shape this
 * client cannot vouch for). PURE - it performs no I/O.
 */
export function mapIngestAnswer(status: number, response: unknown): DocumentIngestOutcome {
  // A refusal can arrive at HTTP 200 (service/adapter) or a listener status, so it
  // is recognised BEFORE the status gate - otherwise a 400 listener refusal would
  // be flattened into a generic INVALID rather than carrying its own code.
  const refusal = refusalFrom(response);
  if (refusal !== null) return refusal;
  if (status !== 200) return invalidResponse();
  const record = exactDataRecord(response, INGESTED_KEYS);
  if (record === null
    || record.ok !== true || record.outcome !== "INGESTED"
    || record.advisoryOnly !== true || record.authority !== "NONE"
    || typeof record.contentSha256 !== "string" || record.contentSha256.length === 0
    || !Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0
    || typeof record.proposal !== "object" || record.proposal === null
    || Array.isArray(record.proposal)) {
    return invalidResponse();
  }
  const proposalBytes = encodedProposal(record.proposal);
  if (proposalBytes === null) return invalidResponse();
  const decoded = decodeDocumentWorkProposalBytes(proposalBytes);
  if (!decoded.ok) return errored(decoded.code, decoded.layer);
  // The route carries ONE provisional heading-split candidate; read its title,
  // or null when the proposal somehow lists none.
  const first = decoded.proposal.candidates[0];
  return ingested(
    record.contentSha256, record.byteLength as number,
    first === undefined ? null : first.title,
  );
}

/**
 * POSTs the operator PRD to the daemon's ingest route and maps the answer. The
 * body is JSON of the request object EXACTLY - only the allow-list keys - because
 * the route refuses any extra field. `post` is injectable for tests; the default
 * carries the authenticated header set and its own deadline, mirroring the board
 * feed, so a daemon that accepts and never answers becomes a mapped ERROR rather
 * than a hung form.
 */
export async function ingestDocument(
  headers: Readonly<Record<string, string>>,
  request: DocumentIngestRequest,
  post?: (body: string) => Promise<Response>,
): Promise<DocumentIngestOutcome> {
  const send = post ?? ((body: string): Promise<Response> => fetch(INGEST_PATH, {
    body, headers, method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  let response: Response;
  try {
    response = await send(JSON.stringify(request));
  } catch {
    return errored(TRANSPORT_FAILED_CODE, LIVE_DOCUMENT_LAYER);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidResponse();
  }
  return mapIngestAnswer(response.status, body);
}
