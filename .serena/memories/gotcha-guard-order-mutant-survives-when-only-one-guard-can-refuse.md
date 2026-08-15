# A guard-ORDER property is untested unless two guards can refuse the same input

Found by QA on task-ba3a45f96cda4db691233c4e45df2432 (daemon work services),
2026-08-09. Production code was correct; the TEST could not fail.

## The shape

`work-claim.ts` composes legs in a fixed order and the plan required the
design-427 slot ceiling to run BEFORE `reserveProviderSlot`, "so a
scheduler-level accept cannot bypass it". A test existed, titled
`checks the ceiling BEFORE the slot leg, so a scheduler accept cannot bypass it`,
asserting `failure.leg === "slotCeiling"` and `not.toBe("providerSlot")`.

Its fixture used **ACTIVE** slot rows, so `reserveProviderSlot` would have
ACCEPTED. Only one guard could refuse, so both orderings return the same
result. Swapping the two blocks left the whole 256-test suite green.

The mutant is NOT equivalent — a purpose-built input proved the code changes:

    liveClaims = 4 held + slot row state "PENDING_ACQUIRE"
    committed order : WORK_SLOT_EXHAUSTED        / leg slotCeiling
    reordered       : WORK_SLOT_RESOURCE_INACTIVE / leg providerSlot

Two different stable reason codes for the same request. Nothing observed it.

## The rule

To pin "A runs before B", the fixture must make **A and B both refuse**, then
assert A's code wins. A fixture where only A can refuse asserts nothing about
order — it re-asserts that A refuses, which another test already covers.

Generalizes past ordering: any test naming a relationship between two guards
(precedence, short-circuit, fail-closed-first) needs an input that puts both
guards in a position to answer. This is the epic-rail-6 "assertion quietly
detached from its subject" defect, in its ordering form.

## For QA

A worker's mutation drill can report "N operands, N killed, 0 surviving" and
still miss this: drills naturally target comparison operators and constants
(`>=` to `>`, code strings), not statement ORDER. Add a reorder mutant whenever
the plan states an ordering requirement. Reorder mutants are cheap — move the
two blocks, run the suite, restore with `git checkout --`.

Related: `mem:gotcha-redundant-operand-mutants-survive-inside-one-guard`,
`mem:mutation-drills-in-shared-worktree`.
