# A guard can keep passing after its premise becomes false

Found 2026-08-09 in my own new guard, by mutation drill — the suite was green the whole time.

## The shape

`motion-inventory.test.ts` asserted "every motion-bearing stylesheet is gated", where
gated meant *has its own reduced-motion block, or is `@import`ed into
`styles/control-room.css`* — because `control-room.css` loads the global
`prefers-reduced-motion` reset.

```ts
function reachesGlobalReset(relativePath: string): boolean {
  return read(IMPORT_ROOT).includes(`@import "./${basename}"`);   // HALF the premise
}
```

Deleting `@import "./responsive.css"` from `control-room.css` removes the reset from the
bundle entirely. `chrome.css`, `shell.css` and `surfaces.css` are then **ungated** — and
the arm stayed **GREEN**, because they are still imported into `control-room.css`. The
implication "imported therefore reset-covered" had silently become false while the
assertion that depended on it kept passing.

Fix: check both halves — the root must still import the reset *and* the sheet must be
imported into the root. Re-running the same mutation then produced three named
violations (`MOTION_WITHOUT_REDUCED_MOTION_GATE` for chrome/shell/surfaces).

## Why nothing else catches it

A separate arm ("the reset is loaded, not dead code") did go red, so the FILE failed and
I would have noticed *something*. That is luck, not coverage: delete or rename that
neighbouring arm and the gating claim silently becomes unfalsifiable. An arm must be
falsifiable on its own.

## The generalisation

When a predicate is `A implies B` and you assert only `A`, you are trusting `B` to stay
true forever. Ask of every guard: **what would have to change for this assertion to keep
passing while the property it names is false?** Then mutate exactly that and watch.

Two related instances found the same day, same family:
- An `it` block iterating a discovered set without asserting the set is non-empty inside
  its own block — a neighbour asserted it, so it read as covered.
- `expect(result.checked).toBeGreaterThan(swept.length - 1)` where `checked === swept.length`:
  tautologically true, looks like a real non-vacuity precondition.

Related: `mem:gotcha-hop-count-scan-roots-narrow-silently`,
`mem:gotcha-grep-c-cr-check-collapses-to-empty-pattern`.
