# Gotcha: a digest-comparison "did it change?" gate reads junk as change

Found 2026-08-09 on `task-cda6bddf` by adversarial review, after the suite was green.

`@moe/context`'s `evaluateRetryUnlock(previous, candidate)` decides movement by
`canonicalSha256(previous.retryPredicate) === canonicalSha256(candidate)`. Compose it
without validating `candidate` first and you get:

```ts
decideBreaker(holds, { entry, candidatePredicate: {} as FactPredicate })
// -> digests differ -> "the predicate moved" -> HOLD RELEASED
```

**An unparseable input does not compare equal, so it reads as movement.** A caller who
cannot change the underlying fact still clears the gate by submitting garbage. The
failure is invisible to a green suite: every honest test passes, because every honest
test supplies a well-formed predicate.

## The rule

Any gate whose "changed?" answer comes from comparing digests needs a **shape gate
first**. Validate the candidate against its declared union (kind, required fields, the
operator set permitted for that kind) and refuse with your own stable code before
delegating. Equality-of-digest is a fine authority for *did this move*; it is no
authority at all for *is this a thing*.

## Two siblings from the same review

- **Never store a caller's object in state a decision later reads.** The hold captured
  `entry.retryPredicate` by reference, so the caller could mutate what the hold was
  waiting on and then unlock against the old value. `Object.freeze({...predicate})`.
- **A validator vouches only for what it reads.** `computeFailureFingerprint` validated
  the 5 hashed fields; `id` and `retryPredicate` were then read into hold state on the
  strength of the TypeScript type alone, which a runtime caller is not obliged to
  honour.

All three were mutation-drilled after fixing — removing each guard reddens a named test.

Related: `mem:pattern-assert-which-layer-refused`,
`mem:gotcha-admission-entry-point-fail-open`.
