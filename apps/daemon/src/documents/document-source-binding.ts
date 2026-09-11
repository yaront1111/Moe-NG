import type { DocumentSourceRecord } from "./document-source-contract.js";
import { documentSourceRef, legacyDocumentSourceRef } from "./document-source-identifiers.js";

/**
 * Current refs bind presentation metadata as well as content. Re-derive that identity from the
 * decoded record before serving it. Historical refs (including an omitted ref) bind content
 * only; preserve that lookup contract without imposing metadata the legacy ref never carried.
 */
export function documentSourceMatchesRef(
  record: DocumentSourceRecord,
  sourceRef = legacyDocumentSourceRef(record.contentSha256),
): boolean {
  return sourceRef === legacyDocumentSourceRef(record.contentSha256)
    || sourceRef === documentSourceRef(record.contentSha256, record.displayPath, record.mediaType);
}
