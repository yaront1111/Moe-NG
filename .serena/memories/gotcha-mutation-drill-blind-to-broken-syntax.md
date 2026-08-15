# Gotcha: a mutation harness that counts only "×" scores a SYNTAX ERROR as "mutation survived"

Found 2026-08-08 on `task-7617c00d` while mutation-checking
`packages/store/src/subscriptions/subscription-doc-codec.ts`. Third distinct mutation-harness
trap in this repo, after `mem:gotcha-digest-mutation-that-proves-nothing` (mutating a
delegating wrapper) and `mem:gotcha-mutation-harness-windows-decode` (harness dies mid-run).

## What happened

The guard being tested was a multi-line condition:

```ts
if (
  kind !== "object" || depth > MAX_DOC_DEPTH || seen.has(value as object) ||
  types.isProxy(value)
) {
```

I mutated it by DELETING the last operand line with `sed`. That leaves
`... || seen.has(...) ||` followed by `) {` — not valid TypeScript. vitest then fails the
whole SUITE at import time and prints **no `×` test lines at all**. My harness counted
`grep -cE "^\s+×"` and reported `failed=0`, which reads exactly like "the guard is not
load-bearing, no test covers it". The opposite was true.

## Rules

1. **Count failed SUITES as well as failed tests** (`grep -cE "^ FAIL "`). A mutation that
   reddens 0 tests AND 0 suites is a real survivor; 0 tests but 1 suite is a broken mutant and
   proves nothing either way.
2. **Neutralise, don't delete.** Replace the operand with `false` (or the condition with a
   constant) so the file still parses and the mutation is semantic, not syntactic. Deleting
   whole lines is only safe for a statement that stands alone (`hash.update(length);`).
3. A `failed=0` result should always be treated as suspicious enough to eyeball the mutated
   region before concluding a test gap exists — print the mutated lines in the harness output.

## The same run produced a genuinely weak test, which is what the drill is FOR

I added an `Array.isArray(input.baselines)` guard and a test feeding it the string
`"every-projection"`. Mutating the guard away left the test GREEN — because **a string is
iterable**, so `for (const item of "every-projection")` iterates characters, `item.projection`
is `undefined`, and `requireIdentifier` refuses with the *same* code the guard would have
produced. The test passed for the wrong reason and pinned nothing.

Fixed by feeding a NON-iterable (`{0: ..., length: 1}`), which without the guard escapes as
`TypeError: input.baselines is not iterable`. Then the mutation reddens.

**General shape:** when testing a type/shape guard, pick a value that fails DIFFERENTLY
without the guard than with it. A value that both paths refuse identically tests nothing.
