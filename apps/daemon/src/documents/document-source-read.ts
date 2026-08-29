import { decodeDocumentSourceRecord, documentSourceView } from "./document-source-codec.js";
import {
  DOCUMENT_SOURCE_EVENT_TYPE, DOCUMENT_SOURCE_SCHEMA_VERSION,
} from "./document-source-contract.js";
import type { DocumentSourceView } from "./document-source-contract.js";
import { documentSourceAggregateId } from "./document-source-identifiers.js";
import { refuse } from "./document-work-result.js";
import { copyFixedBytes, exactDataArray, exactDataRecord } from "./document-work-safe-value.js";
import type { DocumentWorkServiceRefused } from "./document-work-service-contract.js";
import type { DocumentWorkStorePort } from "./document-work-store-port.js";

const PAGE_KEYS = Object.freeze(["hasMore", "items", "nextCursor"]);
const EVENT_KEYS = Object.freeze([
  "aggregateId", "aggregateSequence", "commandId", "committedAt", "domainSchemaVersion",
  "eventId", "eventType", "globalPosition", "metadata", "payloadCodecVersion", "payload",
  "recordVersion", "requestSha256",
]);
const EVENT_WITH_TRACE_KEYS = Object.freeze([...EVENT_KEYS, "decisionTrace"]);

/** ABSENT: the proposal names a source with no stored text (an agent-authored proposal, or a
 *  proposal that predates operator ingest) - the dossier is returned without a source view.
 *  REFUSED: text IS stored but does not content-address to the sha the proposal names - the
 *  read fails closed. VIEW: the verified bounded projection. */
export type DocumentSourceReadResult =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "REFUSED"; readonly refusal: DocumentWorkServiceRefused }
  | { readonly kind: "VIEW"; readonly view: DocumentSourceView };

function sourceInvalid(): DocumentSourceReadResult {
  return {
    kind: "REFUSED",
    refusal: refuse("DOCUMENT_WORK_DOSSIER_SOURCE_INVALID", "DAEMON_READ_MODEL"),
  };
}

function eventPayloadBytes(event: unknown, aggregateId: string): Uint8Array | null {
  const candidate = exactDataRecord(event, EVENT_KEYS)
    ?? exactDataRecord(event, EVENT_WITH_TRACE_KEYS);
  if (candidate === null) return null;
  if (candidate["aggregateId"] !== aggregateId
    || candidate["aggregateSequence"] !== 1
    || candidate["domainSchemaVersion"] !== DOCUMENT_SOURCE_SCHEMA_VERSION
    || candidate["eventType"] !== DOCUMENT_SOURCE_EVENT_TYPE) return null;
  return copyFixedBytes(candidate["payload"]);
}

/**
 * Reads the content-addressed text a proposal source names. The aggregate id is derived from the
 * sha, and the stored record is re-decoded and re-hashed, so the ONLY way a view is returned is
 * if the stored text hashes to exactly the sha the proposal declares - a forged envelope cannot
 * pass without a preimage. Absence is not a refusal: the source view is optional evidence.
 */
export function readDocumentSourceView(
  store: DocumentWorkStorePort,
  projectId: string,
  contentSha256: string,
): DocumentSourceReadResult {
  return readDocumentSourceViewAtAggregate(
    store, contentSha256, documentSourceAggregateId(projectId, contentSha256),
  );
}

/** Reads a caller-verified goal-bound source aggregate through the same codec. */
export function readDocumentSourceViewAtAggregate(
  store: DocumentWorkStorePort,
  contentSha256: string,
  aggregateId: string,
): DocumentSourceReadResult {
  const version = store.getAggregateVersion(aggregateId);
  if (version === 0) return { kind: "ABSENT" };
  // A source aggregate is immutable and is written in one decision leg. Any
  // other cardinality is corruption, not an absent optional source.
  if (!Number.isSafeInteger(version) || version !== 1) return sourceInvalid();

  const rawPage = store.readAggregateEvents(aggregateId, 0, 1);
  const page = exactDataRecord(rawPage, PAGE_KEYS);
  if (page === null || page.hasMore !== false || page.nextCursor !== 1) return sourceInvalid();
  const items = exactDataArray(page.items);
  if (items === null || items.length !== 1) return sourceInvalid();

  const payload = eventPayloadBytes(items[0], aggregateId);
  if (payload === null) return sourceInvalid();
  const record = decodeDocumentSourceRecord(payload);
  if (record === null || record.contentSha256 !== contentSha256) return sourceInvalid();
  return { kind: "VIEW", view: documentSourceView(record) };
}
