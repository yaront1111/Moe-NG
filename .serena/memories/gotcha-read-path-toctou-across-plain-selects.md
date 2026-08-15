# Gotcha: a read path made of several plain SELECTs can observe a write half-applied and call it corruption

Found 2026-08-08 by the adversarial pass on `task-7617c00d`
(`packages/store/src/subscriptions/subscription-read-page.ts`). No test caught it; no test
would have, because every suite is single-threaded.

## The shape

`readSubscriptionPage` issued five independent statements on the caller's connection:
`MAX(generation)`, the subscriber row, the snapshot sentinel row,
`projections.last_applied_position`, `MIN(domain_events.global_position)`. Each ran in its own
implicit transaction, so each saw a DIFFERENT snapshot.

`advanceGeneration` writes the new generation row AND every baseline sentinel in ONE
`BEGIN IMMEDIATE`. That is correct and atomic — but a reader straddling it can read
`generation = 2` from after the commit and the sentinel from before it. The code then compares
`sentinel.generation !== generation` and concludes the durable state is corrupt:

> `SUBSCRIPTION_STATE_CORRUPT: the goal-count baseline snapshot is from generation 1`

A perfectly legal, atomic rebuild gets reported to the consumer as durable corruption. The
writes were never at risk — they already ran inside `BEGIN IMMEDIATE`. Only the read was.

## Fix

Wrap the whole read in `BEGIN DEFERRED` / `COMMIT` so every statement comes from one snapshot.
In WAL a deferred reader does not block writers, so this costs nothing.

```ts
export function inReadSnapshot<Result>(database: DatabaseSync, run: () => Result): Result {
  if (database.isTransaction) { return run(); }   // reuse the caller's; never nest
  database.exec("BEGIN DEFERRED");
  try { const result = run(); database.exec("COMMIT"); return result; }
  catch (error) { rollback(database, error); throw error; }
}
```

Two details that matter:
- **Reuse a transaction the caller already holds.** `BEGIN` inside a transaction throws
  "cannot start a transaction within a transaction"; a library that owns the caller's
  connection must not assume it owns the transaction state.
- **Call the expensive seam OUTSIDE the snapshot.** Take the durable reads and the decision
  inside, return a plan, then do the paging read after COMMIT. Do not hold a read transaction
  across a call into another connection.

## Testable properties (a race is not directly testable; these are)

- after a successful read AND after a refused read, `database.isTransaction === false`, and a
  write on the same connection still succeeds (proves both exit paths close the transaction);
- with a caller-held `BEGIN DEFERRED` open, the read still works and leaves it open.

Both go red if you drop the reuse branch or the COMMIT.

## The general rule

If two statements feed ONE decision, they belong in one snapshot. "Each SELECT is atomic" is
not the same as "the decision is consistent" — and the failure mode is the worst kind: a
fail-closed error code that accuses the durable state of being corrupt when it is fine.
