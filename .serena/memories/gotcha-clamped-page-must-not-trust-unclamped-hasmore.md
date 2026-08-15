# Gotcha: a pager that filters a page must not trust that page's `hasMore`

Found 2026-08-08 on `task-791d73407af64b179f6099810d940758`, in
`packages/store/src/projections/projection-rebuild.ts`. Caught by a mutation drill survivor,
not by any test written up to that point.

## The shape

The rebuild walks the ledger through `source.readEventsAfter(after, limit)` and **clamps**
each page so it can never step over the durable checkpoint (landing exactly on it is what lets
the recomputed digest be compared against the stored one). The loop then did the obvious
thing:

```ts
const events = clampPage(page.items, verifyAt, carried.position);
carried = foldPage(plan, carried, events);
if (!page.hasMore) { break; }          // BUG
```

`hasMore` describes the page the SOURCE returned, not the subset that survived the clamp.
With `pageLimit 100` over a five-event ledger whose durable checkpoint is 2, the source
returns all five with `hasMore = false`, the clamp keeps two, and the walk **stops at position
2 and returns `REBUILT`** — a silent under-rebuild reporting completion. Fix:

```ts
if (!page.hasMore && events.length === page.items.length) { break; }
```

## Why no existing test caught it

Every case up to then either used `pageLimit 1` (no page can span the checkpoint) or had the
durable checkpoint at the ledger end (nothing to clamp). The clamp only bites when a page
contains events on BOTH sides of the durable checkpoint — which needs `pageLimit > 1` AND an
unrelayed ledger tail. That combination existed nowhere.

## Generalisation

**Any time you filter, clamp, truncate or dedupe a page after fetching it, the fetched page's
`hasMore` / `nextCursor` no longer describes your walk.** Recompute the continuation from what
you kept. The failure mode is not a crash — it is an early, *successful-looking* termination,
which is strictly worse.

## Drill lesson

The surviving mutant was "remove `clampPage` entirely → 0 tests, 0 suites red". Writing the
test to kill it is what exposed the `hasMore` bug: the new case failed against the ORIGINAL
code, not the mutant. A mutation survivor is worth chasing even when you are confident the
guard is right — the test you write to cover it is where the real defect turns up.
See `mem:gotcha-mutation-drill-blind-to-broken-syntax` for counting suites as well as tests.
