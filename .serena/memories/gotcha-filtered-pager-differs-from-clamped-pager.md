# A DISPLAY filter and a CLAMP break a pager in different ways — do not copy the fix

Found 2026-08-09 on `task-d99ca771` while building
`apps/control-room/src/timeline/timeline-page.ts`. Someone then made the exact mistake
INTO the finished file within the hour — see "It has been tried" below.

`mem:gotcha-clamped-page-must-not-trust-unclamped-hasmore` gives the store's fix for a
pager that drops rows after fetching:

```ts
if (!page.hasMore && kept.length === page.items.length) { break; }
```

Transposing that verbatim into a pager whose dropper is a USER-FACING FILTER **hangs the
walk**. The two droppers are not the same thing:

| dropper | what it drops | must the walk still move past them? |
|---|---|---|
| clamp / view bound | rows the walk NEEDED | no — resume must re-serve them |
| display filter | rows the operator does not want to SEE | yes — they were seen and rejected |

With a display filter, a page emptied by the filter has `kept.length === 0 !==
page.items.length`, so the loop can never terminate and never advances.

## The correct transposition

```
EXAMINED — rows of the page the walk looked at. The filter does NOT reduce this.
ADMITTED — rows that reached the view. The bound DOES reduce this.

complete = !page.hasMore && examined === page.rows.length && truncation === null
```

Continuation cursor:
- whole page examined -> last EXAMINED row (`page.rows.at(-1)`);
- bound cut the page short -> last ADMITTED row.

Never read `page.nextCursor`.

## IT HAS BEEN TRIED — the one-expression version of this bug

An external edit changed exactly one expression in the finished file:

```ts
const lastExamined = page.rows.at(-1);   // correct
const lastExamined = shown.at(-1);       // HANGS; `shown` is the FILTERED array
```

A page the filter empties makes `shown.at(-1)` undefined, so the cursor does not move, and
the source re-serves the same page forever.

**How it presented, and why a green number lies:** the suite ran **119.34s reporting
"tests 0ms"**, then `Worker exited unexpectedly`. A hung worker executes ZERO tests, so the
Tests line shows no failures at all — only the SUITE count and the wall-clock reveal it.
Same lesson as `mem:gotcha-mutation-drill-blind-to-broken-syntax`, different cause.

The production file now carries a comment AT that line naming the symptom, because the
header comment three screens up was not read before the substitution was made. Put the
warning where the mistake happens, not where the design is explained.

## Fixtures that actually prove it

- Envelope trust: a source whose `nextCursor` equals the last row served proves nothing —
  correct and buggy walks agree. Make `nextCursor` LIE (`lastServed.sequence + 1`); an
  envelope-trusting walk then skips exactly one real row per page.
- The hang: a fixture where the filter empties a WHOLE MIDDLE page. Without it,
  `shown.at(-1)` passes everything.

## Caller obligation this creates

A continuation cursor is valid only for the FILTER that produced it — examined-and-filtered
rows sit behind it, so resuming under a WIDENED filter skips them. Either re-walk from the
original start when the filter changes (what `TimelineList` does, `useMemo` keyed on the
selection) or persist the filter beside the cursor.

Related: `mem:gotcha-clamped-page-must-not-trust-unclamped-hasmore`.
