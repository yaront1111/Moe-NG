import { decodeDocumentSourceRecord, documentSourceView } from "./document-source-codec.js";
import type { DocumentSourceView } from "./document-source-contract.js";
import { documentSourceAggregateId } from "./document-source-identifiers.js";
import { refuse } from "./document-work-result.js";
import { copyFixedBytes, exactDataArray, exactDataRecord } from "./document-work-safe-value.js";
import type { DocumentWorkServiceRefused } from "./document-work-service-contract.js";
import type { DocumentWorkStorePort } from "./document-work-store-port.js";

const PAGE_KEYS = Object.freeze(["hasMore", "items", "nextCursor"]);

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

function eventPayloadBytes(event: unknown): Uint8Array | null {
  if (typeof event !== "object" || event === null) return null;
  return copyFixedBytes((event as { payload?: unknown }).payload);
}

/**
 * Reads the source-bound text a proposal names. The aggregate id is derived from the sha plus
 * sourceRef, and the stored record is re-decoded and re-hashed, so the ONLY way a view is returned
 * is if the stored text hashes to exactly the sha the proposal declares - a forged envelope
 * cannot pass without a preimage. Absence is not a refusal: the source view is optional evidence.
 */
export function readDocumentSourceView(
  store: DocumentWorkStorePort,
  projectId: string,
  contentSha256: string,
  sourceRef?: string,
): DocumentSourceReadResult {
  const aggregateId = documentSourceAggregateId(projectId, contentSha256, sourceRef);
  const version = store.getAggregateVersion(aggregateId);
  if (!Number.isSafeInteger(version) || version < 1) return { kind: "ABSENT" };

  const rawPage = store.readAggregateEvents(aggregateId, version - 1, 1);
  const page = exactDataRecord(rawPage, PAGE_KEYS);
  const items = page === null ? null : exactDataArray(page.items);
  if (items === null || items.length !== 1) return sourceInvalid();

  const payload = eventPayloadBytes(items[0]);
  if (payload === null) return sourceInvalid();
  const record = decodeDocumentSourceRecord(payload);
  if (record === null || record.contentSha256 !== contentSha256) return sourceInvalid();
  return { kind: "VIEW", view: documentSourceView(record) };
}
