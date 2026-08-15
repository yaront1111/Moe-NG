# An exported frozen reason-code list can omit a code production emits

Found reviewing task-9449ce65 (release supply-chain gate), 2026-08-09.

`scripts/release/release-subject.mjs` exports
`RELEASE_REFUSAL_REASONS = Object.freeze([...19 codes...])` as the declared
refusal vocabulary. `scripts/release/supply-chain.mjs` emits
`releaseRefusal("SOURCE_ARCHIVE_FAILED")` in three places. That code is NOT in
the list.

Nothing caught it because:

- `releaseRefusal(reason)` takes an arbitrary string; it never validates the
  argument against the list.
- The list is exported but never imported anywhere — not by production, not by
  the test suite. `grep RELEASE_REFUSAL_REASONS` returns exactly one hit: the
  declaration.
- Every refusal test asserts its own literal reason string, so the suite is
  fully green and rail-6 compliant while the enumeration is wrong.

This is the guard-detaches-from-premise family (`mem:` MEMORY.md entry
"A guard can pass after its premise goes false") in constant form: a frozen
table that nothing consumes cannot be wrong loudly.

## How to catch it as QA

`grep -o 'releaseRefusal("[A-Z_]*"' <production files> | sort -u` and diff that
set against the declared array. Takes ten seconds and is not implied by any
test result.

## How to fix it in production

Either validate inside the refusal constructor (`reason` must be in the frozen
set, else throw at construction), or assert set-equality in the suite between
the declared array and the codes grepped out of the sources. A list that is
only read by humans will drift.
