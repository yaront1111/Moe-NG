/** Shared by the planning and design seats, whose MCP-only sessions cannot open spill files. */
export const CONTRACT_READ_MISSION_LINES: readonly string[] = Object.freeze([
  'Call product_contract_read with payload {"goalRef": "...", "offset": 0, "limit": 4096}.',
  "It answers the APPROVED revision at Gate 1 as moe-product-contract-json-page/1:",
  "gateRef, contentSha256, text, offset, totalLength, and nextOffset. The text values are",
  "ordered JSON text fragments of the full approved response, including every criterionId",
  "and requirementId and their statements. Read every page until nextOffset is null;",
  "a page is not the complete criterion list. Continue with payload",
  '{"goalRef": "...", "offset": <nextOffset>, "limit": 4096, "gateRef": <first page gateRef>,',
  '"contentSha256": "<first page contentSha256>"}. Copy both pins exactly on every continuation.',
  "Treat the text fragments in order as one JSON document; retain any partial identifier or",
  "statement across the page boundary. No file-read tool is needed. The completed document",
  "contains gateRef and revision.requirements/criteria. Never infer ids from PRD numbering.",
  "If a read answers PRODUCT_CONTRACT_READ_REVISION_CHANGED, discard the partial document",
  "and restart at offset 0 for the newly approved revision; never combine different approvals.",
  "A request with only goalRef may answer the full small revision directly; a large one is",
  "automatically paged and must be completed with the same continuation protocol.",
]);
