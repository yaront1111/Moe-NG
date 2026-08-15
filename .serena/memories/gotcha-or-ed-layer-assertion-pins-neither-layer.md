# Gotcha: an OR-ed layer assertion pins neither layer

Found on `task-4a3b5ec0`, `launch-lock.test.ts:221`, after four other mutants had been killed
and the suite was green at 645/645.

```ts
// DETACHED — passes whichever of the two layers answered
expect(failure.layer === "LAUNCH_LOCK" || failure.layer === "KERNEL").toBe(true);
```

The module under test refuses at BOTH of those layers. So the disjunction is satisfied by
either answer, and re-stamping the refusal at the wrong layer leaves the whole suite green.
Epic rail 6 names this case explicitly: *"where more than one layer can refuse, which layer
refused"*. An OR over exactly the layers that can refuse is the vacuous form of that assertion —
it looks like a layer check and asserts nothing.

**It survives review by eye** because the CODE beside it is pinned exactly, so the line reads
as rigorous. The tell is structural, not semantic: in a suite where every other refusal table
uses `toEqual({ code, layer })`, a table that spells the layer check out longhand is spelling
it out because it could not use the exact form — i.e. because its rows disagree on the layer.
**Fix by giving the table an expected-layer column**, not by loosening the assertion.

The same shape in the negative direction: `expect(x).not.toBe(BAD)` where the production
surface returns exactly one known GOOD value and no other case covers it. It catches the
dangerous direction only; a refusal or a third answer also satisfies it. Assert the exact value.

**How to find these:** grep the suite for assertions containing `||`, `&&`, `.toBeTruthy()`,
or `.not.toBe(` — then mutate the production surface at the spot the assertion claims to
cover and run the FULL suite. A layer/label swap is the cheapest high-yield mutant and is
not covered by the usual predicate-to-constant drill, which only ever tests the branch, never
the value the branch stamps.

Related: `mem:gotcha-self-derived-universe-cannot-check-itself`.
