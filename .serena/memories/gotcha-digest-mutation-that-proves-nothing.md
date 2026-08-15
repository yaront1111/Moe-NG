# Gotcha: a mutation can stay GREEN because it only touched half the mechanism

Found 2026-08-08 on `task-071173ab` while mutation-checking
`packages/store/src/outbox-relay/outbox-relay-digests.ts`. Two separate traps, both of
which look like "the test is load-bearing" or "the branch is covered" when neither is true.

## Trap 1 — mutating a wrapper instead of the mechanism

Canonical digests length-frame every field so `("ab","cd")` cannot hash the same as
`("a","bcd")`. The code has two framing helpers:

```ts
function frameBytes(hash, value) { /* 8-byte BE length prefix */ hash.update(value); }
function frameText(hash, value)  { frameBytes(hash, textEncoder.encode(value)); }
```

I mutated `frameText` to `hash.update(...)` directly and the suite stayed **fully green**,
which reads as "framing is untested". It was partly untested, but the mutation itself was
also wrong: the colliding pair I had built shifted a character between `topic` (a
`frameText` field) and `payload` (a `frameBytes` field). `payload` was still framed, so
the streams could never collide no matter what `frameText` did.

**Two rules.** Mutate the mechanism at its SINGLE source (`frameBytes`, which `frameText`
delegates to) — mutating a delegating wrapper leaves the real invariant intact. And a
collision fixture only proves framing if BOTH shifted fields go through the framing you
removed. Once mutated at the source, one test went red immediately.

## Trap 2 — an encoder branch no fixture can reach

`encodeNumber` special-cases `-0` because `String(-0) === "0"` would let two
distinguishable states share a digest. Nothing reddened when I deleted that branch: every
test state ran through a reducer computing `count + 1`, and `-0 + 1 === 1`, so the sign
was destroyed before it ever reached the hash. The branch was dead *to the tests* while
looking fully exercised, because the digest assertions around it all passed.

Fix: make the reducer `{...state, count, last}` so an untouched `mark` field flows through
unchanged, then digest two states differing ONLY by `0` vs `-0` and assert the digests
differ. Same trick covers key ordering: two states with identical content in different key
insertion order must produce the SAME digest, which reddens if `.sort()` is dropped.

## The general shape

For a canonicalizing hash, the properties worth mutating are: framing (collision
resistance), key sorting (order independence), type tags (cross-type collisions), and the
`-0`/`NaN`/`Infinity` encodings. A "same input, same digest / different input, different
digest" test touches none of them — it passes against almost any hash, including a broken
one. Assert the specific adversarial pair for each property.

Related: `mem:gotcha-mutation-testing-restore-safety` (always back up out-of-tree and
verify the restore with `git hash-object`),
`mem:gotcha-mutation-finds-the-untested-half-of-a-pair`,
`mem:task-task-071173ab5b93428b9ca0acf5c65a50e1-handoff`.
