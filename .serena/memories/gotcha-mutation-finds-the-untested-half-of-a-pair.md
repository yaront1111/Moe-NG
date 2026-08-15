# Gotcha: mutation testing finds the HALF of a guarantee you forgot to assert

Found 2026-08-08 on `task-5ee5b801` (`budget-measurement.ts`). The suite was 18/18 green and 18 of
19 mutations were killed. The one survivor was the whole point of running them.

## The survivor

The module returns a normalized record with two rebuilt sub-objects: the validated `measurement`
and a `pricebookBinding`. Mutating the binding to pass through the CALLER's raw object:

```ts
binding: record.source === "DERIVED_LIST_PRICE" ? binding : null
//                                    mutant ->  (rawBinding as PricebookBinding)
```

**SURVIVED all 18 tests.** The detachment test existed — it just only covered `measurement`. The
frozen test existed too, and `Object.isFrozen(record.pricebookBinding)` stayed TRUE under the
mutant, because `deepFreeze` on the result reaches into the caller's object and freezes it. So the
mutation not only broke detachment, it introduced an input side effect, and the freeze assertion
actively *hid* it.

## The pattern

When a record has N sub-objects that all share one guarantee (detached / frozen / sorted /
bounded), the test almost always asserts it for whichever one the author wrote first. The others
inherit the claim without inheriting the assertion. There is no way to see this by reading the
test — it reads as if it covers the record. Only a per-sub-object mutation shows the gap.

Corollary: `Object.isFrozen(x)` is a WEAK detachment probe. It passes when `x` is the caller's own
object that you accidentally froze. The strong triple:

```ts
expect(Object.isFrozen(record.thing)).toBe(true);
expect(Object.isFrozen(callerObject)).toBe(false);   // no side effect on the input
callerObject.field = 9;
expect(record.thing?.field).toBe(originalValue);      // no aliasing
```

Same shape as the buffer-aliasing trap in `mem:gotcha-frozen-envelope-detached-bytes` — value
equality and frozenness both pass on an aliased object.

## The second variant: a guard the FIRST guard shadows, so it is unreachable

Found 2026-08-08 on `task-82989467` (`projection-fold.ts`). Two guards were added in the same
review pass against the same class of hostile input — a `__proto__`/`constructor` key:

1. `normalizeEvent` rejects any own key not in the field table (`Object.hasOwn`, not `[key] !==
   undefined` — see `mem:gotcha-prototype-chain-key-lookup`).
2. `plainClone` refuses a `__proto__` key while deep-copying state.

Mutating guard 1 away went red instantly. **Mutating guard 2 away left all 19 tests GREEN.** The
fixture was an EVENT carrying `__proto__`, and guard 1 catches events, so the input never reached
the cloner at all. The guard was correct, live, and load-bearing in production — and completely
unasserted.

The fix is not a better mutation, it is a fixture on the OTHER path: an input **state** carrying a
`__proto__` key (the cloner runs on state and on reducer results, never on the event). With that
added, mutating guard 2 goes red.

### Rule

When two guards defend the same class of input at different layers, ask **which layer does this
fixture actually reach?** A surviving mutation on the inner guard usually means the fixture is
being eaten by the outer one — not that the inner guard is dead code. Delete it and you ship a
hole that only fires on the input shape your tests never send.

Generalises past guard pairs: any time a mutation survives, the first hypothesis should be
"my fixture does not reach this line", and the check is to add a fixture that enters through a
different door — not to weaken the assertion.

## Rule

Mutate EACH rebuilt sub-object separately, not just the outermost one. Budget one mutation per
field that carries the guarantee, not one per guarantee. Cf.
`mem:pattern-qa-mutation-testing-the-claim`, `mem:gotcha-assertions-detached-from-their-subject`,
and `mem:gotcha-mutation-testing-restore-safety` for the restore discipline.
