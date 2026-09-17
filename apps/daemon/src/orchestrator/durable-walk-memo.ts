import type { SqliteEventStore } from "@moe/store";

import { decisionsOf, isDecisionLedgerMemoized } from "../decision-ledger-memo.js";

/**
 * A memo for a walk over durable state that is PROVABLY current, not merely probably.
 *
 * WHY. The wrapper's delivery pass asks every node for its mission, and each mission walks the
 * decision ledger and parses sealed graph bodies from JSON — once per node, per pass. Measured
 * on UnAI 2026-09-17: a pass of 25 minutes across ~70 node trees with nothing to staff. The
 * answer is the same for every node in the pass; only the freshness proof was missing.
 *
 * WHY THE KEY IS NOT THE DECISION LEDGER ALONE. Goal and run STATES come from decisions, but
 * run chains, activation witnesses and graph bodies are read from EVENTS on their own
 * aggregates, and a graph body is content-addressed and written without a decision row. So a
 * walk records every aggregate it reads with the version it saw BEFORE reading it, and a hit
 * requires the ledger marker and every recorded version unchanged. Reading the version first
 * means a commit racing the walk can only make the next check fail, never pass on stale bytes.
 *
 * ENROLLED HANDLES ONLY. `decisionsOf` walks from zero on a handle nobody enrolled, so the
 * marker alone would cost a full walk there; the wrapper and the stack host enroll at start,
 * and a one-shot CLI or a test handle keeps exactly the read pattern it had.
 */
const LEDGER_PAGE_SIZE = 200;

export interface DurableWalkMemo<T> {
  readonly value: T;
  readonly marker: string;
  readonly versions: ReadonlyMap<string, number>;
}

export type DurableWalkMemos<T> = WeakMap<SqliteEventStore, Map<string, DurableWalkMemo<T>>>;

/** A version that tells absent from present and never throws: an absent aggregate is a fact too. */
export function aggregateVersionOf(store: SqliteEventStore, aggregateId: string): number {
  try { return store.getAggregateVersion(aggregateId); } catch { return -1; }
}

export function ledgerMarkerOf(store: SqliteEventStore): string {
  const decisions = decisionsOf(store, LEDGER_PAGE_SIZE);
  return `${String(decisions.length)}:${String(decisions.at(-1)?.decisionPosition ?? 0n)}`;
}

/** Whether a walk may be memoised on this handle at all. */
export function durableWalkMemoisable(store: SqliteEventStore): boolean {
  return isDecisionLedgerMemoized(store);
}

/**
 * Serves `memos[store][key]` while every dependency it recorded is unchanged; otherwise runs
 * `walk`, telling it `touch` for every aggregate it is about to read, and records the result.
 * A walk that throws records nothing.
 */
export function memoisedDurableWalk<T>(
  store: SqliteEventStore, memos: DurableWalkMemos<T>, key: string,
  walk: (touch: (aggregateId: string) => void) => T,
): T {
  const marker = ledgerMarkerOf(store);
  const byKey = memos.get(store) ?? new Map<string, DurableWalkMemo<T>>();
  const held = byKey.get(key);
  if (held !== undefined && held.marker === marker
    && [...held.versions].every(([aggregateId, version]) => aggregateVersionOf(store, aggregateId) === version)) {
    return held.value;
  }
  const versions = new Map<string, number>();
  const touch = (aggregateId: string): void => {
    if (!versions.has(aggregateId)) versions.set(aggregateId, aggregateVersionOf(store, aggregateId));
  };
  const value = walk(touch);
  byKey.set(key, { marker, value, versions });
  memos.set(store, byKey);
  return value;
}
