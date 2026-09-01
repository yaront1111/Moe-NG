import type { CommitExpectedVersionDecisionInput } from "@moe/store";

import {
  DOCUMENT_INGEST_OPTIONAL_KEYS,
  DOCUMENT_INGEST_REQUIRED_KEYS,
  DOCUMENT_SOURCE_EVENT_TYPE,
  DOCUMENT_SOURCE_SCHEMA_VERSION,
  MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES,
} from "./document-source-contract.js";
import type {
  DocumentIngestMediaType,
  DocumentSourceRecord,
} from "./document-source-contract.js";
import {
  encodeDocumentSourceRecord,
  isCanonicalText,
  isIngestMediaType,
  sha256Hex,
  utf8ByteLength,
} from "./document-source-codec.js";
import {
  documentSourceAggregateId,
  documentSourceCommandId,
  documentSourceEventId,
  documentSourceRef,
} from "./document-source-identifiers.js";
import { refuse } from "./document-work-result.js";
import { exactDataRecord } from "./document-work-safe-value.js";
import type { DocumentWorkServiceRefused } from "./document-work-service-contract.js";

const MAX_OBJECTIVE_UTF8_BYTES = 32 * 1024;
const MAX_DISPLAY_PATH_CODE_UNITS = 256;
const DEFAULT_INGEST_OBJECTIVE = "Author work candidates from the ingested document.";

type DecisionEvent = CommitExpectedVersionDecisionInput["events"][number];

/** An operator source object after the single ingest validator has admitted it. Every field is
 *  operator-supplied CONTENT; no identity, binding or authority field survives admission. */
export interface AdmittedDocumentSource {
  readonly displayPath: string;
  readonly mediaType: DocumentIngestMediaType;
  readonly objective: string;
  readonly text: string;
}

export type AdmittedDocumentSourceOutcome =
  | { readonly value: AdmittedDocumentSource }
  | { readonly refusal: DocumentWorkServiceRefused };

/**
 * The single ingest validator, shared by the ingest route and the goal bind path so neither can
 * drift into admitting what the other refuses. Exact keys (objective optional), then value
 * admission in an order that keeps each refusal code truthful: a too-large text refuses as
 * TEXT_TOO_LARGE even when it is also non-canonical, and a well-formed but unlisted media type
 * refuses as MEDIA_TYPE rather than as generic shape. Because the key set is exact, a caller that
 * supplies a sourceRef, a contentSha256 or any other binding field is refused rather than obeyed.
 */
export function admitDocumentSource(payload: unknown): AdmittedDocumentSourceOutcome {
  const record = exactDataRecord(payload, [
    ...DOCUMENT_INGEST_REQUIRED_KEYS, ...DOCUMENT_INGEST_OPTIONAL_KEYS,
  ]) ?? exactDataRecord(payload, DOCUMENT_INGEST_REQUIRED_KEYS);
  if (record === null) {
    return { refusal: refuse("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", "DAEMON_INGRESS") };
  }
  const { displayPath, mediaType, text } = record;
  if (!isCanonicalText(displayPath, true) || displayPath.length > MAX_DISPLAY_PATH_CODE_UNITS) {
    return { refusal: refuse("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", "DAEMON_INGRESS") };
  }
  if (typeof mediaType !== "string") {
    return { refusal: refuse("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", "DAEMON_INGRESS") };
  }
  if (!isIngestMediaType(mediaType)) {
    return { refusal: refuse("DOCUMENT_WORK_INGEST_MEDIA_TYPE_UNSUPPORTED", "DAEMON_INGRESS") };
  }
  if (typeof text !== "string") {
    return { refusal: refuse("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", "DAEMON_INGRESS") };
  }
  if (utf8ByteLength(text) > MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES) {
    return { refusal: refuse("DOCUMENT_WORK_INGEST_TEXT_TOO_LARGE", "DAEMON_INGRESS") };
  }
  if (!isCanonicalText(text, false)) {
    return { refusal: refuse("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", "DAEMON_INGRESS") };
  }
  let objective = DEFAULT_INGEST_OBJECTIVE;
  if ("objective" in record) {
    const raw = record["objective"];
    if (!isCanonicalText(raw, false) || utf8ByteLength(raw) > MAX_OBJECTIVE_UTF8_BYTES) {
      return { refusal: refuse("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", "DAEMON_INGRESS") };
    }
    objective = raw;
  }
  return { value: Object.freeze({ displayPath, mediaType, objective, text }) };
}

/** The daemon computes the digest and byte length ITSELF from the admitted text; a caller never
 *  contributes either, so the content address is server-derived by construction. */
export function documentSourceRecordOf(
  admitted: AdmittedDocumentSource,
): DocumentSourceRecord {
  return Object.freeze({
    byteLength: utf8ByteLength(admitted.text),
    contentSha256: sha256Hex(admitted.text),
    displayPath: admitted.displayPath,
    mediaType: admitted.mediaType,
    schemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
    text: admitted.text,
  });
}

/** The v2 source binding for a record: content plus the presentation facts stored with it. The
 *  ingest route may instead present a legacy content-only ref for a pre-migration row, which is
 *  why the leg below takes the ref rather than deriving it. */
export function currentDocumentSourceRef(record: DocumentSourceRecord): string {
  return documentSourceRef(record.contentSha256, record.displayPath, record.mediaType);
}

/** Every durable identifier and byte string of one document-source text leg. */
export interface DocumentSourceLeg {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly event: DecisionEvent;
  readonly eventId: string;
  readonly payload: Uint8Array;
}

/**
 * THE single source-leg derivation. Both the ingest route and the goal bind path compose this;
 * neither re-derives, because two derivations that agree today drift tomorrow and a drifted id
 * silently binds a goal to an aggregate nobody else can find.
 */
export function documentSourceLegOf(
  projectId: string,
  record: DocumentSourceRecord,
  sourceRef: string,
): DocumentSourceLeg {
  const eventId = documentSourceEventId(projectId, record.contentSha256, sourceRef);
  const payload = encodeDocumentSourceRecord(record);
  return Object.freeze({
    aggregateId: documentSourceAggregateId(projectId, record.contentSha256, sourceRef),
    commandId: documentSourceCommandId(projectId, record.contentSha256, sourceRef),
    event: Object.freeze({
      domainSchemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
      eventId,
      eventType: DOCUMENT_SOURCE_EVENT_TYPE,
      outbox: [],
      payload,
    }),
    eventId,
    payload,
  });
}
