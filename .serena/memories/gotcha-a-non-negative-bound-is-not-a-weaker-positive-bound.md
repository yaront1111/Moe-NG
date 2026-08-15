# A `>= 0` admission bound is not a sloppy `>= 1` — check which guard owns the boundary case

## The trap

Reviewing an admission guard added in FRONT of an existing ordering guard:

```ts
if (!lineageAttested(lineage)) return refuse("FINDING_LINEAGE_DIGEST_MISMATCH");
if (!admissibleRound(round.round)) return refuse("FINDING_ROUND_INVALID");   // isSafeInteger && >= 0
if (round.round <= lastRound(lineage)) return refuse("FINDING_LINEAGE_APPEND_ONLY");
```

`>= 0` looks lax. Rounds start at 1, so `>= 1` reads tighter and "more correct", and it is easy
to flag the bound as a hole.

It is not a hole. It is the only choice that preserves the existing contract.

## Why

`lastRound()` seeds its reduce at 0, so `0 <= 0` is true and round 0 has ALWAYS refused with
`FINDING_LINEAGE_APPEND_ONLY`. Tightening admission to `>= 1` would make the NEW guard answer for
round 0 and return `FINDING_ROUND_INVALID` instead — silently changing which stable reason code an
operator sees for an input whose behaviour the DoD said must be unchanged ("adds a guard rather
than replacing one").

The wider bound deliberately LEAVES the boundary case with its original owner.

## The check to run before flagging a bound

For every value the new guard could claim, ask which guard answered BEFORE the change and which
answers after. A bound is correct when it admits exactly the values some downstream guard already
handles, and refuses only what nothing handled. Do not grade the bound against the domain
("rounds are positive"); grade it against the code-attribution boundary.

The task under review pinned this on purpose with a named test:
`"refuses round 0 against an empty lineage as append-only, not as inadmissible"`. A test whose
name asserts WHICH guard answers is the signal that the author already thought about it — read it
before writing the reject.

## Related

- `mem:refusal-test-answered-by-earlier-guard` — the same attribution question from the other side
- `mem:qa-honest-equivalent-mutant-is-not-a-reject`
- `mem:qa-grade-against-the-written-requirement-not-your-own-suggestion` — the general form: my
  tighter alternative is not the bar
- `mem:a-crash-is-not-a-refusal` — the companion trap on this same task: a drill reddening on
  `not.toThrow` IS an outcome assertion when the pre-fix behaviour was an unstructured TypeError
  naming no reason code
