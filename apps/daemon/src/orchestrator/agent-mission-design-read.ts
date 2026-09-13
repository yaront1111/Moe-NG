/** Planning seats must see the complete design even when their tools cannot read spill files. */
export const DESIGN_READ_MISSION_LINES: readonly string[] = Object.freeze([
  "design_read is a query: supply correlationId and payload, without a command envelope.",
  'Use payload {"goalRef": "...", "offset": 0, "limit": 4096} for bounded design pages.',
  "For format moe-design-json-page/1, read every design page until nextOffset is null.",
  "The text values are ordered JSON text fragments of the full design response. Treat them",
  "as one document, retaining partial strings across boundaries; no file-read tool is needed.",
  "Continue with the exact version and contentSha256 returned by the first page:",
  '{"goalRef": "...", "offset": <nextOffset>, "limit": 4096, "version": <first page version>,',
  '"contentSha256": "<first page contentSha256>"}. The complete document contains record.revision',
  "and versions. Read all screens, entities and other sections before assigning them to nodes.",
  "On DESIGN_READ_REVISION_CHANGED, discard partial text and restart at offset 0 without",
  "version or contentSha256; never combine pages from different design projections.",
  "A goalRef-only query can answer a small design directly; a large design is automatically paged.",
]);
