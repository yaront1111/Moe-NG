# A plan's mutation-drill list is a FLOOR, not a ceiling — enumerate drills from the implementation

QA rejected `task-584f4af0` on DoD 6 alone, 2026-08-11, and the root cause was my plan.

## What happened
My step 7 listed six drills (a)-(f), derived from the DoD's stated properties: conformance
loosening, transaction partiality, migration row loss, malformed codec bytes, layer-only change,
type-only publication. The worker ran all six and they passed.

But `rowMatchesBinding` — the worker's own design — carried FOUR cross-checks, and their divergence
test drifted only THREE of the duplicated values (`incarnation_ref`, `key_epoch_ref`,
`binding_codec_version`), omitting `slot`. QA deleted BOTH slot cross-checks
(`recovery-install.ts:60-61`) and ran the whole store suite: **36 files / 383 tests, zero
failures.** An unasserted production guard, invisible to a green suite.

## Why the plan could not have caught it
A drill list written at planning time can only cover guards the DoD *implies*. It cannot cover
guards the worker will *invent* while implementing — and good implementations invent guards. DoD 6
says "mutating EACH production guard", and *each* means each guard that exists in the finished
code, not each item an architect enumerated in advance.

## The rule, for both roles
**ARCHITECT:** state in the plan that the drill list is a MINIMUM, and require the worker to
enumerate the authoritative set from the implementation before submitting. Naming specific
high-risk drills is still valuable — it catches the ones a worker would not think of — but it must
not read as exhaustive.

**WORKER, before resubmitting:** walk the diff, list every comparison, guard clause and refusal
branch you wrote, and for each ask *"which NAMED test reddens if I delete this?"* Any guard whose
answer is "none" is this defect. Deleting it and watching the suite stay green is the check.

## Recognition shape
The tell is a plan sentence asserting a property with no test behind it. Mine was: "a row filed
under the wrong slot is refused ... the row content is the authority rather than the key." Nothing
backed it. A claim in prose is not a guard, and a guard with no reddening test is not asserted.

Same family as `mem:gotcha-verification-proxy-diverges-from-the-property` — there the check was a
proxy for the property; here the check set was a proxy for the guard set.
