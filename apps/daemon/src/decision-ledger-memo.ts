/**
 * The decoded decision ledger, read once per handle and topped up from the last seen
 * position.
 *
 * Every read model that folds the ledger (durable ledger, sessions, claims, review ledgers,
 * coverage, health, provider pause, activity) used to walk it from position 0 on every call,
 * and the store re-proves every digest on every page it serves. One control-room surface read
 * walks the ledger 23 times, so the same 612 decisions were decoded 14,000 times per poll
 * (measured 2026-09-05); with the UI, the wrapper and the seats all polling, the daemon's
 * event loop never freed up.
 *
 * The ledger is append-only: a decision read at a position is that position's decision for
 * ever. An ENROLLED handle therefore keeps what it has decoded and asks the store only for
 * "anything after the last position I hold?" — one page, index-served, per call. Handles that
 * are not enrolled walk exactly as before, page size and all, so a test that pins how many
 * pages a reader asks for keeps measuring what it measured. Enrolment is a composition-root
 * decision, never a reader's.
 */
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";
import { DurableStoreError } from "@moe/store";

interface DecisionLedgerMemo {
  readonly items: CommandDecisionRecord[];
  last: bigint;
  version: number | null;
}

const memos = new WeakMap<SqliteEventStore, DecisionLedgerMemo>();

/** Opts a long-lived handle in. Idempotent; a handle enrolled twice keeps its memo. */
export function enrollDecisionLedgerMemo(store: SqliteEventStore): void {
  if (!memos.has(store)) memos.set(store, { items: [], last: 0n, version: null });
}

/** Whether a handle keeps its decoded ledger between calls. */
export function isDecisionLedgerMemoized(store: SqliteEventStore): boolean {
  return memos.has(store);
}

/**
 * Walks pages from `from` into `into`, telling `advanced` the last position held after
 * EACH page. A store can throw between pages (SQLITE_BUSY under a concurrent seat, an
 * integrity re-proof, a nested transaction); a memo that learned its position only after
 * the whole walk kept the pages it had decoded and then decoded them again on the retry,
 * holding every decision twice for the life of the handle. Advancing per page keeps
 * "what is held" and "where to resume" in step no matter where the walk stops.
 */
function walk(
  store: SqliteEventStore, from: bigint, pageSize: number, into: CommandDecisionRecord[],
  advanced: (last: bigint) => void,
): CommandDecisionRecord[] {
  let cursor = from;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, pageSize);
    for (const decision of page.items) into.push(decision);
    const newest = page.items.at(-1);
    if (newest !== undefined) advanced(newest.decisionPosition);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return into;
}

/**
 * Every decision in the store, in position order, refusals included: each reader keeps its
 * own project and disposition filters. The array an enrolled handle answers is the memo's own
 * and grows in place; callers iterate it and never hold it across a commit they made.
 */
export function decisionsOf(
  store: SqliteEventStore, pageSize: number,
): readonly CommandDecisionRecord[] {
  const memo = memos.get(store);
  if (memo === undefined) return walk(store, 0n, pageSize, [], () => undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = store.readCommandDecisionCacheVersion();
    if (version !== memo.version) {
      memo.items.length = 0;
      memo.last = 0n;
      memo.version = version;
    }
    walk(store, memo.last, pageSize, memo.items, (last) => { memo.last = last; });
    // An external writer may commit between the token read and any page. Do not combine
    // old memoized rows with that new snapshot; retry from zero under its new token.
    if (store.readCommandDecisionCacheVersion() === version) return memo.items;
  }
  memo.items.length = 0;
  memo.last = 0n;
  memo.version = null;
  throw new DurableStoreError("STORE_BUSY", "decision history changed during its read");
}
