# Gotcha: a list can pass the check by index and be bound by iterator

Found by adversarial self-review on `task-1e512b957a9e` (evidence receipt pipeline,
2026-08-08) AFTER the suite was green and after a 6-mutation drill had already passed.
No test caught it, because no test had been written for it.

## The exploit

```ts
// verifier-execution.ts — divergence check reads INDICES
for (let i = 0; i < declared.length; i += 1) {
  if (observed[i] !== declared[i]) return divergence(...)
}
// evidence-receipt.ts — the receipt bound the ITERATOR
argv: [...execution.argv]
```

`Array.isArray` is true for a subclass, and a subclass can override `Symbol.iterator`.
So a caller hands in an argv whose **indices** match the recipe (divergence check passes)
and whose **iterator** yields something else (the receipt attests the other command).
The guard is green and the thing it guards is false.

Fixture that reaches it:

```ts
const smuggled = [...RECIPE.argv];
Object.defineProperty(smuggled, Symbol.iterator, {
  value: function* () { yield "node"; yield "attacker.mjs" },
});
// smuggled[1] === RECIPE.argv[1]   BUT   [...smuggled] === ["node","attacker.mjs"]
```

## The rule

**A validated value and the bound value must come from the SAME read.** Two reads of one
caller-supplied list are two different lists. Three shapes of this bug, all found in one
diff:

1. check by index, bind by spread (above)
2. `for (const x of list) validate(x)` then `return [...list]` — validates one iterator
   pass, copies a second
3. `for (const x of list) validate(x)` then `list.map(...)` — validates by iterator,
   binds by index

Fixes: read by index up to the checked `.length`, **push into a fresh array during the
validation pass**, and bind that array. Where a prior check has already proven equality
with a trusted value, bind the trusted value instead — the receipt now binds
`[...recipe.argv]` (our own frozen array), not `execution.argv`, so there is no second
read between check and bind at all.

Same treatment for a port that returns a listing: `normalizeScan` reads by index and
returns a fresh list, so emptiness / foreign / undeclared / missing all inspect the list
that was validated rather than asking a hostile port again.

## Why the mutation drill missed it

Mutation testing asks "is this line load-bearing", not "is there a second path around
it". All 6 guards were load-bearing AND bypassable. The drill and adversarial review
catch disjoint bug classes — run both.

Verified after fixing: reverting the bind to `[...execution.argv]` reddens exactly the
new regression test.

Related: `mem:convention-hostile-shape-reads-in-pure-kernels` (the `Array.isArray` +
`for...of` hole in a parser), `mem:gotcha-digest-mutation-that-proves-nothing`.
