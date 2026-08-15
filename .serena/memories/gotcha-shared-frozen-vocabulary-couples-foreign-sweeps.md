# Gotcha: appending to a shared frozen vocabulary reddens somebody else's exhaustiveness sweep

Hit on `task-4a3b5ec0` (supervisor child 2, 2026-08-08) when adding 13 codes to
`packages/runner/src/supervisor/effect-kernel.ts`'s `SUPERVISOR_ERROR_CODES`.

## The coupling

Child 1 published the vocabulary as frozen data AND wrote a sweep proving every member
reachable:

```ts
// effect-properties.test.ts
const observed = REFUSALS.map(([, outcome]) => failureOf(outcome).code);
expect(observed.length).toBe(SUPERVISOR_ERROR_CODES.length);
expect([...new Set(observed)].sort()).toEqual([...SUPERVISOR_ERROR_CODES].sort());
```

That is a GOOD test — the kernel comment says "a code no refusal can produce is a code no
test can pin". But it means **appending one code to the array immediately reddens a foreign,
already-committed suite**, and it stays red until the new code is driven from a real
production surface. There is no append that avoids this.

## The tempting wrong fix

Add a sibling array (`SUPERVISOR_RUNTIME_ERROR_CODES`) so the foreign file needs no edit.
The suite goes green instantly and the union type still works.

**It is wrong**, and wrong in the exact way epic rail 6 names: the test is titled
"reaches every code in the closed vocabulary exactly once" and would now silently cover
30 of 43. The assertion detaches from its subject while staying green. A second closed
vocabulary beside "the closed refusal vocabulary" defeats the vocabulary.

## The right fix

Keep ONE array; extend the foreign REFUSALS table with one entry per new code, each driven
from a real production surface. Free consequences worth knowing: the new outcomes then also
flow through that file's existing redaction sweep and deep-freeze sweep, which catches
leaks and unfrozen envelopes you did not write a test for.

Cost: the foreign suite is red for the whole middle of your task. Say so in the step note
when you make the append, so a mid-flight observer does not mis-attribute it.

## The general rule

Before appending to any exported frozen array, `grep` for it across the repo. If anything
asserts `.length` or set-equality against it, that assertion is now YOUR responsibility to
satisfy — and satisfying it honestly, not routing around it, is the whole point of the
assertion existing. The same shape applies to `ADMITTED_EFFECT_TRANSITIONS` and its
hand-written `DESIGN_ARCS` twin in `effect-lifecycle.test.ts`.

Related: `mem:gotcha-self-derived-universe-cannot-check-itself`,
`mem:task-task-4a3b5ec031f14079bce4141abf922905-handoff`.
