# A surviving drill is a coverage gap, not a reason to rewrite the test

Two drills on the Foundation bridge survived a 26-test suite. Neither meant the
guard was dead; both meant the TEST was proving a different guard than its name
claimed. Diagnose before touching anything.

## Case 1 — redundant with a downstream CAS, so only the COST differs

Disabling the registration ordering precheck (`transitions[index]?.tag !==
required`) changed nothing observable: the request fell through to the durable
compare-and-set at `expectedVersion 3` over an aggregate at version 2, which
refused with the IDENTICAL code, layer and leg. The precheck is defence in
depth, so an outcome assertion can never kill it.

What DOES differ: without the precheck a command decision is SPENT at the store.
Killed the mutant with

    const decisions = decisionCount(store);
    ... refuse ...
    expect(decisionCount(store)).toBe(decisions);

That is the "refuses before opening the provider" clause made assertable.
Generalisation: **when a drill is outcome-equivalent, look for the SIDE EFFECT
the early guard avoids** — a decision row, a lock acquisition, a network open.

## Case 2 — a sibling guard caught the same fixture

Deleting the `aggregateSequence !== index + 1` contiguity check left the
"missing middle event" test green, because that fixture ([activation,
PREFLIGHT] with GRANT missing) is ALSO caught by the tag-order walk. The test
was named for contiguity and was actually proving tag order.

Killed it by building a fixture whose TAG ORDER IS EXACTLY RIGHT and where only
the numbering lies:

    const drifted = [initial, { ...consumedEvent, aggregateSequence: 3 }];

Generalisation: **to drill guard X, the fixture must be LEGAL at every sibling
guard** — otherwise the earliest one answers and X is never consulted. Same
failure shape as `mem:refusal-test-answered-by-earlier-guard` and
`mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`, seen from the
drilling side.

## Procedure that made both diagnosable

A drill script that aborts unless the anchor occurs EXACTLY once, and prints
file, line, and replaced-line counts on both apply and restore. A drill that
silently applied nothing is indistinguishable from a surviving mutant otherwise.
Restore verified with `sha256sum -c` against hashes captured before the first
drill — never `git checkout`, which reverts to HEAD and destroys uncommitted work
(`mem:git-checkout-restore-destroys-uncommitted-work`).

See also `mem:qa-surviving-mutant-behind-stronger-downstream-guard`,
`mem:qa-honest-equivalent-mutant-is-not-a-reject`.
