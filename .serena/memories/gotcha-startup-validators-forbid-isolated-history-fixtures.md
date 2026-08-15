# A mutilated SQLite fixture cannot be opened at all

`SqliteEventStore.#open` calls `core.validateStartup()` on EVERY open
(`packages/store/src/decision-ledger.ts:34`), which runs `validateAllReceipts`
(`event-read-materialization.ts:235` — it re-materializes each receipt) and
`validateAllCommandDecisions` (`decision-read-model.ts:142`).

So the obvious way to test "does the guard check table X" — commit real history, then delete every
table except X with a raw `DatabaseSync` handle — **fails at open**, not at the assertion. A store
keeping only `command_receipts` (events deleted) or only `domain_events` throws
`DurableStoreError STORE_CORRUPT` before your method is ever called.

Openable in isolation: `aggregate_heads` only (no FK, both validators scan zero rows).
Not openable in isolation: `command_receipts`, `domain_events`, `command_decisions` — they are
mutually dependent by FK *and* by the startup validators.

**Consequence for per-leg drills:** you cannot write one isolating fixture per EXISTS leg. Legs over
the mutually-dependent tables can only be pinned jointly by one real committed decision. Do not
promise a per-leg drill matrix in a plan; state the joint coverage honestly instead, and assert each
fixture's pre-state row counts so a fixture that generated nothing cannot pass silently.

Related: `mem:gotcha-test-fixture-can-encode-the-missing-invariant`, `mem:vitest-worker-dies-on-held-sqlite-handle`.
