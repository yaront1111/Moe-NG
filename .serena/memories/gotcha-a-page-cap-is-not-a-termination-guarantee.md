# A page cap on a cursor scan is usually a false ceiling, not a safety net

## The shape (found in activation-ledger-reader.ts, task-d92b1b15)

    const MAX_SCAN_PAGES = 64, SCAN_PAGE_SIZE = 100;   // -> a 6,400-event ceiling
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      read = store.readEventsAfter(cursor, SCAN_PAGE_SIZE);
      if (read.hasMore && read.items.length === 0) return no("SCAN_INCOMPLETE");
      ...
      if (!read.hasMore) return { aggregateId: found, refusal: null };   // ONLY success exit
      const next = read.nextCursor;
      if (next === null || next <= cursor) return no("SCAN_INCOMPLETE");
      cursor = next;
    }
    return no("SCAN_INCOMPLETE");                       // silent time bomb

The scan cannot exit early on a hit — it must walk the whole stream to prove the match UNIQUE. So
once the store exceeds pages × pageSize, `hasMore` is still true when the loop ends, control falls
through, and **every call refuses forever**. It fails closed into a refusal that is
indistinguishable from a legitimate authority answer, and no test store is ever big enough to see it.

## Why the cap looks necessary and is not

The instinct is "an unbounded loop over a remote cursor could spin forever, so cap it." But look at
the two guards already inside the loop:

- an empty page while `hasMore` is true → return
- a `nextCursor` that is null or does not strictly ADVANCE → return

Those cover every way a stalled, broken, or lying store fails to make progress. **Termination is
already guaranteed by cursor monotonicity**, not by the page count. The cap therefore protects
against nothing a correct store does — it only imposes an arbitrary ceiling on how large the data
may get before the feature silently dies.

## Rule

When you find a `for (page = 0; page < MAX_PAGES; ...)` over a cursor, ask two questions:

1. **Does the loop already require the cursor to strictly advance?** If yes, the page cap is not the
   termination guarantee and can go. If no, fix THAT — a monotonicity check is the correct guard, and
   it bounds the loop by the data rather than by a guess.
2. **What happens on fallthrough?** If it returns a refusal rather than throwing, the failure is
   invisible: it looks like a considered answer. Prefer a distinct code that says "I ran out of
   budget" versus "I looked and the answer is no" — collapsing them is what makes it undebuggable.

A cap sized in absolute records (6,400) against a quantity that only grows (total project events) is
a time bomb by construction. If a bound is genuinely wanted for cost reasons, bound the WORK
(per-aggregate query, per-effect index) rather than truncating a correctness-critical scan.

## Test consequence

Proving the fix needs a store driven PAST the old ceiling, and the count must be pinned as a
**literal**. Deriving it from `MAX_PAGES * PAGE_SIZE` makes the test move with the constants it
exists to pin — the coverage silently shrinks when someone lowers the page size.
See `mem:qa-equivalent-mutant-in-a-two-clause-guard`.
