# A closed enum can make one of your own refusal codes UNREACHABLE

Found live in `refuseConfiguredClasses`
(`apps/daemon/src/recovery/recovery-inventory-record.ts`).

Four codes were specified for validating a configured class set:
`CLASS_UNKNOWN`, `CLASS_DUPLICATE`, `CLASS_EXTRA`, `CLASS_OMITTED`.
First implementation:

```ts
for (const entry of configured) {
  if (!VALID.includes(entry)) return CLASS_UNKNOWN;
  if (seen.has(entry)) return CLASS_DUPLICATE;   // <- answers first
  seen.add(entry);
}
if (configured.length > VALID.length) return CLASS_EXTRA;   // dead
if (seen.size < VALID.length) return CLASS_OMITTED;
```

**Only six class names exist.** By pigeonhole, any list longer than six must
repeat one — so `CLASS_DUPLICATE` always answers before `CLASS_EXTRA` can. The
EXTRA branch is dead code. Fix: ask LENGTH first.

## Why this is easy to ship

- The suite is green if the EXTRA test asserts only "refused" or "threw".
  Mine asserted the exact code and went red, which is the whole point of the
  rail "assert the reason code, not just the outcome".
- Every branch is individually plausible when read in isolation. The
  unreachability is a property of the *domain cardinality*, not of the code —
  you cannot see it by reading the function alone.

## The check to run

For each refusal code over a **closed** vocabulary of size N, ask: is there an
input that reaches this branch and no earlier one? Cases where the answer is
usually "no":

- "too many" vs "duplicate" when the vocabulary is closed (this bug)
- "unknown value" vs "wrong type" when the type check is inside the loop
- "missing" vs "empty" when an empty collection is also missing

Sibling failure modes already recorded:
`mem:refusal-test-answered-by-earlier-guard` (test reaches a different guard
with the same code), `mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`
(fixture dies before reaching its subject). This one is the third variant: the
branch is unreachable **for every possible input**, so no fixture can rescue it.
Ordering, not the fixture, is the fix.
