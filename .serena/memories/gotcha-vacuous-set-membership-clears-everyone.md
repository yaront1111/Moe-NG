# An empty "resolved" set makes a membership guard clear EVERYONE

Found 2026-08-09 in the adversarial self-review of `task-58029c26` (@moe/review
reviewer independence). The guard read:

```ts
if (input.authorshipResolved && input.authors.includes(input.reviewer)) {
  codes.push("REVIEWER_IS_AUTHOR");
}
```

With `authors: []` and `authorshipResolved: true`, `includes` is vacuously false, so
**the author himself passed as INDEPENDENT**. Every test was green: the fixtures all
had a populated author set, and the "author is refused" test passed because that
fixture named one.

Same shape one level down: a blank `reviewer` (`""`) or blank `subjectRef` cleared the
author comparison and the lease scope by vacuous inequality.

## The rule

A boolean "resolved / loaded / fetched" flag does **not** mean the collection is
usable. Two separate facts:

- *did the lookup run?* — the flag
- *did it return anything that can discriminate?* — non-emptiness

Fail closed on BOTH. Reviewed work always has an author, so an empty authorship set
means the lookup returned nothing, not that nobody wrote it.

```ts
function authorshipKnown(input) {
  return input.authorshipResolved && identified(input) && input.authors.length > 0;
}
```

## Where to look for it

Any `resolved && collection.includes(x)`, `loaded && list.some(...)`,
`fetched && set.has(...)` — and any identity comparison where the identifier could be
the empty string. Ask: *what does this guard answer when the collection is empty?* If
the answer is "it clears the subject", it is fail-open.

## Testing it

The positive fixture hides it. Write the empty-collection case explicitly, and
mutation-drill the non-emptiness operand on its own (`&& input.authors.length > 0` ->
`&& true`) — it must redden a named test.

Related: `mem:gotcha-store-decision-fail-open`.
