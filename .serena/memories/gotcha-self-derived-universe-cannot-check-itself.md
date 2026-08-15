# Gotcha: a validator that derives its universe from the data it validates has one blind axis

Seen on task-1de468316 (CORE schedule coverage checker, approved at `444e034`).

## Shape of the hole
`checkScheduleCoverage` derives the reachable-edge and race-pair universe FROM the injected
transition tables, then checks both directions (every schedule ref is in the universe; every
universe item is claimed by a schedule). That is strong against omission and against phantoms —
but it is structurally blind to any field the derivation copies straight through.

Here that field is `toState`. The landed core tables are `(commandKind -> legal from-states)` and
carry no to-state, so the 32 planning-run/graph-revision to-states were hand-transcribed out of the
reducer bodies. The gate's lockstep assertion compares only `(fromState|commandKind)` against the
real tables; the to-state is checked only for membership in `RUNTIME_LIFECYCLES[aggregate]`.
A to-state that is WRONG but still a valid lifecycle name is self-consistent with the derived
universe, so both coverage directions pass and no test dies.

Proof it's the blind axis, not a general weakness: flipping a FROM-state
(`runRevise` PLAN_REVIEW -> APPROVED) kills 6 gate tests and drives `SCHEDULE_TRANSITION_UNREACHABLE`
to a FAIL verdict, because that field IS cross-checked against an independent source.

## Rules
- **Author:** for every field of your derived universe, name the INDEPENDENT source that pins it.
  Any field whose only source is your own hand-authored data is unasserted, however green the
  suite looks. Say so in the completion note instead of letting it read as fully covered.
- **Author:** when the independent source is a pure function (a reducer), execute it in the gate.
  `reducePlanningRun(stateWithLifecycle(from), command).state.lifecycle === to` closes this class
  outright and costs a few lines; membership-in-lifecycle assertions do not.
- **QA:** ask "what does this validator copy through rather than derive?" and hand-verify that axis
  once, against the real source. Then record it so the next reviewer does not have to re-derive
  which axis was cheap and which was load-bearing.
- **QA:** mutation-test PER FIELD, not per file. One killed mutant on a cross-checked field says
  nothing about a sibling field the checker never compares.

See `mem:gotcha-transition-table-vs-reducer-tostate` (why the to-state is only in the reducer),
`mem:task-task-1de468316a7f4b499aa39408ec240b88-qa-verdict`.
