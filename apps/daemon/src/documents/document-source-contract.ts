import type { DocumentWorkProposal } from "@moe/contracts";

import type { DocumentWorkServiceRefused } from "./document-work-service-contract.js";

/**
 * The operator document-ingest vocabulary: the durable TEXT record that sits beside the
 * advisory DocumentWorkProposal.
 *
 * A proposal carries digests and display paths, never the document text. Candidate authoring
 * (a later milestone) needs the text durably, so ingest records it on a SIBLING aggregate
 * keyed by the content sha rather than on the document-work aggregate. Content addressing is
 * what makes both the dossier read and a future candidate author reach it: the proposal names
 * `sources[0].contentSha256`, and that value is the sibling aggregate's key. The record is
 * inert display evidence - it grants no authority and never names a task, graph or execution.
 */

export const DOCUMENT_SOURCE_SCHEMA_VERSION = "moe-document-source/1" as const;
export const DOCUMENT_SOURCE_EVENT_TYPE = "DocumentSourceTextRecorded" as const;

/** Internal durable record only; deliberately not a runtime command affordance, exactly as
 *  DOCUMENT_WORK_RECORD_COMMAND_KIND is not one. The store's decision key for the text leg. */
export const DOCUMENT_SOURCE_RECORD_COMMAND_KIND = "document-source.record" as const;

/** The operator command kind an ingest arrives under. Reserved here so the daemon vocabulary
 *  and registry can bind it once the runtime command vocabulary admits the kind; see the
 *  service module's ingest handler for the wire-ready form. */
export const DOCUMENT_WORK_INGEST_COMMAND_KIND = "document-work.ingest" as const;

/** The two source media the ingest admits. A closed roster: an unlisted media type refuses. */
export const DOCUMENT_INGEST_MEDIA_TYPES = Object.freeze([
  "text/markdown", "text/plain",
] as const);

export type DocumentIngestMediaType = (typeof DOCUMENT_INGEST_MEDIA_TYPES)[number];

/**
 * The explicit text-size cap, below the bounded-JSON 256 KiB single-string limit so the domain
 * refusal (DOCUMENT_WORK_INGEST_TEXT_TOO_LARGE) fires before the transport's string-limit
 * refusal, and far below the 1 MiB body cap so headers and JSON framing never approach it.
 */
export const MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES = 128 * 1024;

/** The bounded excerpt the dossier read returns for the page; the full length travels beside
 *  it so the page can show "showing N of M" without the daemon shipping the whole document. */
export const DOCUMENT_SOURCE_EXCERPT_MAX_CODE_UNITS = 4 * 1024;

/** The exact keys the operator ingest payload admits. `objective` is optional. */
export const DOCUMENT_INGEST_REQUIRED_KEYS = Object.freeze([
  "displayPath", "mediaType", "text",
] as const);
export const DOCUMENT_INGEST_OPTIONAL_KEYS = Object.freeze(["objective"] as const);

/** The whole payload key set the daemon command vocabulary must allow-list for the kind. */
export const DOCUMENT_INGEST_PAYLOAD_KEYS = Object.freeze([
  ...DOCUMENT_INGEST_REQUIRED_KEYS, ...DOCUMENT_INGEST_OPTIONAL_KEYS,
] as const);

/** The durable text record's shape. `displayPath` is display evidence only; it must never be
 *  passed to a filesystem operation. */
export interface DocumentSourceRecord {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly mediaType: DocumentIngestMediaType;
  readonly schemaVersion: typeof DOCUMENT_SOURCE_SCHEMA_VERSION;
  readonly text: string;
}

/** The bounded projection a read returns for the page. The excerpt is text truncated at the
 *  excerpt cap; `byteLength` is the FULL document length so the caller is not misled. */
export interface DocumentSourceView {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly displayPath: string;
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
  readonly mediaType: DocumentIngestMediaType;
}

/** One operator ingest request: identity and decision time assembled by the caller's edge,
 *  the raw operator payload left undecoded for the single ingest validator to admit. */
export interface DocumentIngestRequest {
  readonly correlationId: string;
  readonly decidedAt: string;
  /** Hostile: the ingest validator is the only parser of this operator object. */
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

export interface DocumentIngestRecorded {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly outcome: "INGESTED";
  readonly proposal: DocumentWorkProposal;
  readonly proposalAggregateId: string;
  readonly proposalEventId: string;
  readonly sourceAggregateId: string;
  readonly sourceDisposition: "DECIDED" | "REPLAYED";
  readonly sourceEventId: string;
}

export type DocumentIngestResult = DocumentIngestRecorded | DocumentWorkServiceRefused;
