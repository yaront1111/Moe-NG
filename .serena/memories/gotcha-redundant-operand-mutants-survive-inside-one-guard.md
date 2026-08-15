# Surviving mutants inside ONE guard are usually redundancy, not a detached assertion

Found while QA-drilling `task-2f6ac0d1`'s ingress. Worth knowing before anyone rejects on it.

## What happened
`hasExactKeys` in `apps/daemon/src/bootstrap/bootstrap-contracts.ts` is two operands:

```ts
if (keys.length !== BOOTSTRAP_REQUEST_KEYS.length) return false;   // count
return keys.every((key) => KEY_SET.has(key));                      // membership
```

Mutating either one alone to a constant left the suite fully green (74/74), even though the suite
has a dedicated test for each case:

- **extra-key test** (10 keys): count-mutant survives because membership still rejects `unexpected`.
- **missing-key test** (8 valid keys): membership-mutant survives because count still rejects 8;
  and the count-mutant survives because the per-field `isRef(request["principalId"])` check in
  `isExactEnvelope` rejects the now-`undefined` field.

Mutating the whole function to `return true` DOES go red on both tests.

## Why this is not the epic rail 6 failure mode
Rail 6's target is an assertion that **detached from its subject**: a *different layer* starts
answering, so the test keeps passing while no longer testing what it names. Here every path
answers from the same function, returns the same stable code `BOOTSTRAP_REQUEST_INVALID`, and the
same layer `DAEMON_INGRESS` — which is exactly what the tests assert. Nothing detached; the guards
are deliberately belt-and-braces, and a redundant operand is by definition unkillable alone.

Rejecting on this would be rejecting a codebase for defence in depth.

## The QA rule to carry forward
Pick the mutation granularity that matches the **claim**. "The exact-shape key check is covered" is
a claim about the guard, so mutate the guard. Only escalate an operand-level survivor when
removing it opens a **reachable single-fault fail-open** — check that by asking what input the
surviving mutant now admits, and whether any other live check still rejects it.

Still worth reporting to the worker: a step note claiming "N guards, N killed" is only true at the
granularity that was actually drilled, and saying which granularity keeps the evidence honest.

## The worker-side counterpart (added from `task-52ec1406`)

The same shape turned up in `apps/daemon/src/recovery/doctor-commands.ts`, and the worker-side
resolution is different from the QA-side one above. There the count check was not belt-and-braces
but **provably unreachable**: for any input the bounded decoder can produce, an extra key is caught
by the unknown-key check and a missing key by that field's own validator, so NO input can redden
the count line. Defence in depth requires a fault the extra guard could actually catch.

Test before you decide which case you are in: name the concrete input the surviving mutant now
admits. If you cannot name one, the line is dead weight and a reviewer will read it as covered
when nothing covers it.

The fix that removed the redundancy instead of documenting it: widen the field validators from
`JsonValue` to `unknown`, so an ABSENT key is refused by the SAME guard that refuses a wrong-typed
one. That also retires the separate `=== undefined` pre-checks (`noUncheckedIndexedAccess` was the
only reason they existed). Afterwards every remaining operand was drilled INDIVIDUALLY and each
reddened its own named test — which needs one fixture per operand, since a fixture breaking two
operands of one guard leaves either free to be neutralised unnoticed.

## Third instance, and the cheapest one to settle: the query already binds the key

`rowMatchesBinding` in `packages/store/src/recovery-install.ts:59-65` (task-584f4af0) opens with two
slot operands:

```ts
binding.slot === querySlot &&                        // A
requireRowString(row, "slot") === binding.slot &&    // B
```

Measured drills, whole store suite each: deleting BOTH reddens the named test
`"refuses a row whose stored bytes name a slot other than the one it is filed under"`
(1 failed | 383 passed). Deleting **either one alone leaves 384/384 green.**

Those single-operand survivors are EQUIVALENT MUTANTS, and it takes one grep to prove that rather
than argue it: `rowMatchesBinding` has exactly ONE call site (:108), fed by `SELECT ... WHERE
slot = ?` bound to the same `slot` argument, against a STRICT table where slot is
`TEXT PRIMARY KEY NOT NULL CHECK (slot IN ('ACTIVE','PENDING'))`. So
`requireRowString(row,"slot") === querySlot` holds for EVERY reachable row, which makes A true
exactly when B is. No test can kill either alone.

**The reusable shape:** whenever a guard cross-checks a KEY the query already bound, the key
operands collapse into one logical guard. Drill the pair, not the operands, and say which
granularity you drilled. Before reaching for the removal fix above, check whether QA or the plan
forbade production edits — on a test-only reopen, disclose the redundancy and let the reviewer
decide; do not slip a production simplification in under a test fix.

Related: `mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion`,
`mem:gotcha-scheduler-boundary-test-matches-prose`,
`mem:gotcha-an-indexed-column-can-drift-from-the-bytes-it-indexes`.
