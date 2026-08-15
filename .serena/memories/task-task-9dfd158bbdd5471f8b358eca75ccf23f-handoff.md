# QA verdict: APPROVED - Event read-model decomposition (commit b5a78b6)

QA worker qa-200db8e3, 2026-08-07. Superseded the worker's own handoff note; QA
re-verified everything independently rather than trusting it.

## Gates re-run by QA (fresh, foreground)
- `pnpm --filter @moe/store typecheck` -> exit 0
- `pnpm --filter @moe/store test` -> exit 0, 18 files / 112 tests
- `npx vitest run --root .` -> 58 files / 545 tests, all pass (repo-wide regression;
  545 not 543 because commit 88e92a4 landed after the worker's run)

## DoD evidence
1. Public APIs / stable errors byte-for-byte compatible: no existing test file touched
   (`git show --stat b5a78b6` = 8 files, only new test added). Normalized logical-line
   set-diff old-vs-new returned **0 REMOVED lines** - no error string, predicate,
   ORDER BY, or validation call was dropped.
2. Fail-closed limits preserved: page-query bodies byte-identical modulo signature;
   contract test pins limit 0/1001, bytes 0 / 64MiB+1, negative and unsafe cursors.
3. Module sizes: 93 / 238 / 249 / 229 / 250(test) / 1 / 1 / 1 - all <= 250, DoD asked <350.
4. Focused gate exits 0 (above).
- Net changed LOC 398 (985 ins / 587 del) - just under the >400 oversized bar.

## Trap that cost time - read this first if you diff this commit
`HEAD~1` is NOT the parent of b5a78b6. Commit 88e92a4 (runtime contract registry)
landed on top. Use the explicit parent: `git show 82ebebc:packages/store/src/event-read-model.ts`.
Diffing against HEAD~1 silently compares the new file to itself and reports a clean
"0 removed" that means nothing. See `mem:gotcha-shared-tree-repo-gate`.

## The four deltas QA had to prove non-observable
1. **Draft key insertion order changed** (`effectEvent`: `outbox` moved after `payload`;
   outbox push: `messageId` moved after `eventOutboxIndex`). PROVEN SAFE by reading
   `store-digests.ts:190-221` - `identifyCommandEffects` hashes explicitly named fields
   in a fixed sequence; it never serializes the object. Drafts are internal, never returned.
2. **Three non-exported SQL literals reformatted** to denser column lists. PROVEN
   whitespace-normalized-equal for RECEIPT_ROW_QUERY, RECEIPT_SCOPE_QUERY,
   RECEIPT_EVENT_QUERY. `RECEIPT_OUTBOX_QUERY` is **byte-identical** (450 chars inside
   the backticks) - still EXPLAIN-QUERY-PLAN asserted elsewhere, do not reformat it.
3. **`effectEventById.get(eventId)` moved after the outbox index decode.** Safe:
   `Map.get` cannot throw, and both old and new gate on the same combined `if`.
4. **`mapStoredEvent`/`mapOutboxMessage` widened private -> protected.** Contained:
   `grep` shows the only consumer of the whole chain is `event-ledger.ts:39`
   (`EventLedgerStore extends EventReadModelStore`), and `packages/store/src/index.ts`
   never references event-read-*, so the package export surface (`exports: {".":
   "./src/index.ts"}`) is unchanged.

## Error-precedence check (the one that could have silently broken)
In `loadReceipt`, the old code did project-scope + PROJECT_SCOPE_REQUIRED + live-binding
checks BEFORE any version check. The new `decodeReceiptRow(row)` call sits at
`event-read-materialization.ts:109`, i.e. still after all three. Precedence preserved.

## Contract test quality
`event-read-model-contract.test.ts` is mutation-resistant: `toStrictEqual` on fully
normalized objects (so `3` vs `3n` cursor types are distinguished), exact
`${code}: ${detail}` message pairs, frozen-envelope vs mutable-detached-record boundary,
caller-mutation isolation across reads, empty tail pages, and both single-page-overflow
messages. Not a happy-path smoke test.

## Not applicable
Governor's cross-cutting `Array.isArray` revoked-Proxy warning does not touch this task -
it adds no validation code; limits still route through unchanged `store-input.js` helpers.

## Tree state at approval
`packages/store` owned paths all clean. `decision-read-model.ts` +
`decision-read-sql.{ts,js}` are dirty but belong to another in-flight task; correctly
never staged here.
