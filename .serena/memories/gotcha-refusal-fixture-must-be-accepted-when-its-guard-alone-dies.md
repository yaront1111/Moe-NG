# A refusal fixture is detached unless neutering its own guard ACCEPTS it

Epic rail 6 says "verify a failure-path test by mutating the production surface
and confirming the test goes red." The failure mode it catches is not a missing
assertion — the assertion can pin the exact code AND the exact layer and still
test nothing, because a DIFFERENT guard in the same function answers with the
same code and the same layer.

## The rule
Write the fixture so that the guard it names is the ONLY thing able to reject it.
Operational test: **neuter that one guard and the input must be ACCEPTED.** If it
is still refused, the case is a duplicate of whichever guard answered, and it
stays green when its own guard is deleted.

## Concrete shapes that fooled a green suite (packages/runner, task-f6c9011b)
- Parser validates `text.endsWith("\n")` then `slice(0, -1)`. A fixture ending at
  the record's own NUL is caught by the FIELD-COUNT guard once the LF guard dies.
  The fixture that works is a COMPLETE record with a stray byte where the LF
  belongs: `...\0commit\0X`. The chop eats the `X` and the record survives.
- `TextDecoder(..., {fatal:true})`. Four loose bytes decode leniently to something
  the field-count guard rejects anyway. The fixture that works puts the bad byte
  INSIDE an otherwise valid field: `refs/heads/ma<0xff>in\0<COMMIT>\0commit\0\n`
  becomes `refs/heads/ma� in` and passes every later check.
- A field-count guard drilled with a fixture that also drops the TYPE field is
  answered by the objecttype guard. Drop only the trailing NUL instead.
- A name-grammar guard followed by a content check (`sha256Hex(bytes) !== name`)
  can NEVER be isolated by a readable file, because the digest check subsumes it.
  Isolate it by making the read FAIL: the grammar answers before any read, so a
  widened grammar routes to the read and changes both code and layer.

## Cheap harness
Keep it OUTSIDE the repo (`%TEMP%`) so a foreign whole-tree commit hook cannot
sweep it in. Per drill: assert anchor count == 1, write the mutation, run only the
relevant test file (`node node_modules/vitest/vitest.mjs run <file>
--reporter=verbose`), restore in a `finally`, re-hash. Compare the red set to a
hand-written expected set — "some test failed" is the same vacuity one level up.
`false && (<original condition>)` is a compile-valid neuter for any `if`.

Related: `mem:gotcha-drill-red-direction-distinguishes-right-reason`,
`mem:gotcha-identity-match-guard-shadowed-by-schema-layer`.
