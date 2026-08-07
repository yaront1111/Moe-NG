import { DurableStoreError } from "./store-contracts.js";
import type { CommandDecisionRecord } from "./store-contracts.js";
import {
  assertReadPageCursors,
  requireStoredDecodedByteCount,
  selectReadPagePrefix,
} from "./read-page-budget.js";
import type { StoredCommandDecision } from "./store-internals.js";
import {
  requireStoredPositiveBigIntText,
  toCommandDecisionRecord,
} from "./store-rows.js";

export interface DecisionCursorPageInput {
  readonly candidates: readonly Record<string, unknown>[];
  readonly loadByPosition: (
    decisionPosition: bigint,
  ) => StoredCommandDecision | null;
  readonly safeDecodedByteLimit: number;
  readonly safeLimit: number;
}

export interface DecisionCursorPageMaterialization {
  readonly hasMore: boolean;
  readonly items: readonly CommandDecisionRecord[];
  readonly nextCursor: bigint | null;
}

/**
 * Turns candidate decision cursors into a materialized page. The caller must run
 * this inside its read-snapshot closure so the candidate query, the per-position
 * loads, and the cursor assertion all observe one `BEGIN DEFERRED` snapshot.
 */
export function materializeDecisionCursorPage({
  candidates,
  loadByPosition,
  safeDecodedByteLimit,
  safeLimit,
}: DecisionCursorPageInput): DecisionCursorPageMaterialization {
  const selection = selectReadPagePrefix(
    candidates.map((row) => ({
      cursor: requireStoredPositiveBigIntText(row, "decision_position"),
      decodedBytes: requireStoredDecodedByteCount(row),
    })),
    safeLimit,
    safeDecodedByteLimit,
  );
  const items = selection.selected.map(({ cursor: position }) => {
    const decision = loadByPosition(position);
    if (decision === null) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command decision ${position} disappeared during its cursor read`,
      );
    }
    return toCommandDecisionRecord(decision);
  });
  assertReadPageCursors(
    items.map((decision) => decision.decisionPosition),
    selection.selected,
  );
  return {
    hasMore: selection.hasMore,
    items,
    nextCursor: items.length === 0 ? null : items.at(-1)!.decisionPosition,
  };
}
