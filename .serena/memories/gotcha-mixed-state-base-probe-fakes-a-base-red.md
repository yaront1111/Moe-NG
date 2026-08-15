# A base-bytes probe that reverts only the TEST file invents a base red

Found while attributing a red under the path-attributed-baseline rail
(task-cec84736d5, QA). Costs one wrong verdict if you stop at the first result.

## What happened

To decide whether a failing integration test was pre-existing, I reverted just the
test file to merge-base bytes and re-ran:

    git show de936fe:tests/integration/control-room/control-room-transport.test.ts > <same path>

Result: **2 failed / 2 passed** — MORE failures than at HEAD (1 failed / 4 passed).
Read naively that says "the diff improved things", or worse, that the base was
broken in some other way. Both readings are wrong.

The extra failure was an artifact: the base TEST expected the daemon to admit its
requests, because at base the PRODUCTION file still set the `Origin` header. HEAD
production no longer sets it, so base-test-against-HEAD-production got
`LISTENER_ORIGIN_INVALID` — a state that never existed in the repo's history.

Reverting BOTH the test and the production file gave the true base: **1 failed /
3 passed**, the same wall-clock-skew failure as HEAD. Delta empty, red pre-existing.

## Rule

A merge-base probe must revert **every file of the diff that participates in the
behaviour under test**, not just the one whose test is red. Anything less builds a
chimera: new-production + old-test (or the reverse) is a configuration no commit
ever had, and its failures are attributable to nothing.

Symptom that you are in a chimera rather than at the base: the failure COUNT or the
failure NAMES differ from HEAD in a direction the diff does not explain. A genuine
pre-existing red reproduces with the *same test name and same assertion*.

## Consolation prize

The chimera run is still useful evidence for something else: it proved the
production removal was load-bearing. The old test could not pass against the new
production surface. Keep it as a drill result, never as a baseline.

## Restore discipline

`git checkout HEAD -- <paths>` only because those paths were clean at HEAD first —
verify with `git status --porcelain -- <paths>` BEFORE the probe, and sha256 after.
See `mem:git-checkout-restore-destroys-uncommitted-work`.
Related: `mem:own-diff-red-in-foreign-file-is-not-excused`,
`mem:peer-write-during-test-run-fakes-a-red`.
