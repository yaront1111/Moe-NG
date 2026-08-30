/**
 * The provenance join between a Product Contract revision draft and the goal it
 * claims to compile: the draft's `sourceDocumentDigests` must NAME the sha the
 * goal's own binding carries, and every digest it lists must resolve to stored,
 * integrity-proven source text. The goal side is admitted through
 * `decodeGoalCatalogEntry` (decision-trace-bound, aggregate id re-derived); the
 * source side through `readDocumentSourceView`, whose codec re-hashes the stored
 * text. Upstream refusals are FORWARDED unstamped where they carry their own
 * code; this module's codes name only its own three failure classes. The ok arm
 * returns the join facts it VERIFIED — never an echo of caller input.
 */
import type { SqliteEventStore } from "@moe/store";

import { readDocumentSourceView } from "../documents/document-source-read.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { exactDataArray, exactDataRecord } from "../documents/document-work-safe-value.js";

const LAYER = "PRODUCT_CONTRACT_PROVENANCE";
const PAGE_KEYS = Object.freeze(["hasMore", "items", "nextCursor"]);
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

export const PRODUCT_CONTRACT_PROVENANCE_CODES = Object.freeze([
  "PRODUCT_CONTRACT_PROVENANCE_MALFORMED",
  "PRODUCT_CONTRACT_PROVENANCE_GOAL_UNBOUND",
  "PRODUCT_CONTRACT_PROVENANCE_DIGEST_MISSING",
  "PRODUCT_CONTRACT_PROVENANCE_SOURCE_UNRESOLVED",
] as const);
export type ProductContractProvenanceCode =
  (typeof PRODUCT_CONTRACT_PROVENANCE_CODES)[number];

export interface ProvenanceJoin {
  readonly contentSha256: string;
  readonly goalId: string;
  readonly ok: true;
  readonly planningRunRef: string;
}
export interface ProvenanceRefused {
  readonly code: ProductContractProvenanceCode;
  readonly layer: string;
  readonly ok: false;
}
export type ProvenanceResult = ProvenanceJoin | ProvenanceRefused;

function refused(code: ProductContractProvenanceCode): ProvenanceRefused {
  return Object.freeze({ code, layer: LAYER, ok: false });
}

function firstAggregateEvent(store: SqliteEventStore, aggregateId: string): unknown {
  const page = exactDataRecord(store.readAggregateEvents(aggregateId, 0, 1), PAGE_KEYS);
  const items = page === null ? null : exactDataArray(page["items"]);
  if (items === null || items.length !== 1) return null;
  return items[0];
}

/**
 * Verifies that `sourceDocumentDigests` honestly names the PRD the goal binds.
 * Every listed digest must resolve to stored source text (an agent may cite
 * supplementary ingested documents beside the PRD), and the binding's own sha
 * must be among them — a contract compiled "from" a goal whose PRD it never
 * cites is the quiet-invention failure this fence exists to refuse.
 */
export function validateRevisionProvenance(
  store: SqliteEventStore,
  projectId: string,
  goalRef: unknown,
  sourceDocumentDigests: unknown,
): ProvenanceResult {
  if (typeof goalRef !== "string" || goalRef.length === 0 || goalRef.length > 512) {
    return refused("PRODUCT_CONTRACT_PROVENANCE_MALFORMED");
  }
  const digests = exactDataArray(sourceDocumentDigests);
  if (digests === null || digests.length === 0
    || !digests.every((digest) => typeof digest === "string" && LOWER_HEX_64.test(digest))) {
    return refused("PRODUCT_CONTRACT_PROVENANCE_MALFORMED");
  }
  const event = firstAggregateEvent(store, goalRef);
  if (event === null) return refused("PRODUCT_CONTRACT_PROVENANCE_GOAL_UNBOUND");
  const decoded = decodeGoalCatalogEntry(
    event as Parameters<typeof decodeGoalCatalogEntry>[0], projectId,
  );
  if (!decoded.ok || decoded.entry.goalId !== goalRef || decoded.entry.binding === null) {
    return refused("PRODUCT_CONTRACT_PROVENANCE_GOAL_UNBOUND");
  }
  const binding = decoded.entry.binding;
  if (!digests.includes(binding.contentSha256)) {
    return refused("PRODUCT_CONTRACT_PROVENANCE_DIGEST_MISSING");
  }
  for (const digest of digests as readonly string[]) {
    // The binding's own digest is read WITH its sourceRef (the aggregate id needs
    // both); supplementary digests resolve by sha alone, the ingest route's shape.
    const view = digest === binding.contentSha256
      ? readDocumentSourceView(store, projectId, digest, binding.sourceRef)
      : readDocumentSourceView(store, projectId, digest);
    if (view.kind !== "VIEW") return refused("PRODUCT_CONTRACT_PROVENANCE_SOURCE_UNRESOLVED");
  }
  return Object.freeze({
    contentSha256: binding.contentSha256,
    goalId: decoded.entry.goalId,
    ok: true as const,
    planningRunRef: decoded.entry.planningRunRef,
  });
}
