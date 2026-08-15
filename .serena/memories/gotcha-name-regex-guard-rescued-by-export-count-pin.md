# A name-based guard can still be sound — if a count pin sits behind it

**Seen:** task-e8e27f76 (scheduler fairness contracts), QA 2026-08-10.

A "no authority" DoD was enforced by classifying each module's runtime exports by
NAME: `/^validate[A-Z]/`, `/^is[A-Z]/`, a closed constructor allowlist, and a
forbidden-word regex `/next|order|sort|rotat|select|charge|.../i`. The worker
disclosed the obvious hole — `validateTurn` slips past both.

That disclosure reads like a rejection waiting to happen. **Test it before you
reject on it.** I appended a genuine sorter named `validateWhoseTurnItIs`:
matches the validator prefix, contains no forbidden word. It went RED anyway:

```
AssertionError: expected 3 to be 2 // Object.is equality
```

Because the same describe block also pinned a **hand-written per-module export
count** (`["fairness-ring", ringModule, 2]`). Any new export — however innocently
named — breaks the count. The regex is decoration; the count is the guard.

## Rule

A weak-looking check is only weak if nothing else covers its escape. Before
rejecting on a disclosed regex/heuristic hole, write the exact export/input that
exploits it and run the suite. Two outcomes, both cheap:

- **Stays green** -> real defect, and you now have the reproducer to hand the
  worker instead of a hypothesis.
- **Goes red** -> a second pin covers it; note WHICH pin in your approval so the
  next reviewer does not re-litigate it.

## Corollary for authors

Pinning `Object.keys(module).length` to a hand-written literal per module is the
cheapest possible "this module gained a capability" tripwire. It costs one line,
survives any naming scheme, and forces every new export through review. Prefer it
over a cleverer name regex.

Related: `mem:qa-generated-table-cannot-police-its-own-generator` (the inverse —
a check derived from its own subject that cannot fail),
`mem:qa-grade-against-the-written-requirement-not-your-own-suggestion`.
