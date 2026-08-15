# Gotcha: a page cap is not a termination guarantee — it is a silent correctness ceiling

Found in `apps/daemon/src/activation/activation-ledger-reader.ts` `scanForEffect`, fixed in
task-d92b1b15 (commit 2e688c9). The shape generalises to every paged scan in this repo.

## The anti-pattern

```ts
const MAX_SCAN_PAGES = 64, SCAN_PAGE_SIZE = 100;
for (let page = 0; page < MAX_SCAN_PAGES; page += 1) { ... }
return no("SCAN_INCOMPLETE");   // <- reached once the store outgrows 6,400 events
```

The cap reads like a safety device against a runaway loop. It is not. It is a hard ceiling on
**total events in the store**, and past it the scan fails closed *forever*, for *every* caller, into
a refusal indistinguishable from a real authority answer. Nothing signals it; the global event count
only ever grows; and no test store is big enough to see it, so a green suite proves nothing.

## Why removing it is safe here

Termination was already owned by two guards that fire on the FIRST bad page rather than after N
good ones:

```ts
if (read.hasMore && read.items.length === 0) return no("SCAN_INCOMPLETE");  // stalled store
const next = read.nextCursor;
if (next === null || next <= cursor) return no("SCAN_INCOMPLETE");          // cursor must ADVANCE
```

Strictly-advancing cursor + finite table ⇒ termination. The cap added no protection a correct store
needed. Residual, worth stating rather than glossing: a store that lies `hasMore: true` forever
*while advancing* would now spin — but such a store could equally forge payload bytes, so a page cap
was never the defence against it.

## The check to run before deleting one

1. Does the loop have a **progress** guard (cursor strictly advances) and a **liveness** guard
   (non-empty page when `hasMore`)? If both, the cap is decorative.
2. Can the scan **exit early on a hit**? Here it cannot — it owes "exactly one matched", not "one
   matched", so it must exhaust the stream to prove uniqueness. That means removing the cap makes it
   *correct*, not *fast*: it stays O(total events) per lookup. Raise that separately
   (task-16d5bc3a10864351adf5be10dfa7df00) rather than landing an index unannounced.
3. Delete the constant, don't orphan it — an unread bound reads to the next maintainer as an
   enforced limit.

## Testing it without the test becoming the bug

- **Pin the boundary as a LITERAL** (`6_400` / `6_500`), never `MAX_SCAN_PAGES * SCAN_PAGE_SIZE`.
  A count derived from the bound it exists to pin moves with the bound, so halving the page size
  silently halves the proof while the test stays green. Here the constants are module-private
  (`const`, not `export const`), so the test *cannot* derive them — worth preserving.
- **Assert the case was actually generated**: walk the same public pager and assert the stream length
  exceeds the literal ceiling BEFORE asserting the outcome. A store that quietly wrote fewer events
  satisfies the outcome assertion vacuously.
- **Batch the inserts.** `MAX_EVENTS_PER_COMMIT = 256` and `readEvents` caps one aggregate at
  `MAX_PAGE_SIZE = 1_000`, so 6,500 events = 26 commits of 250 spread over 26 aggregates. That runs
  in well under a second; 6,500 individual commits under `PRAGMA synchronous = FULL` read as a hang,
  and a drill that hangs reads as a passing guard.
- **Drill the early return.** Making the scan return on first match must redden a *named* test, or
  scale was bought with the uniqueness proof.
