# Gotcha: core transition tables carry from-states only, and empty rows are ambiguous

`PROJECT_TRANSITIONS`, `GOAL_TRANSITIONS`, `PLANNING_RUN_TRANSITIONS`,
`GRAPH_REVISION_TRANSITIONS` are all `Readonly<Record<CommandKind, readonly Lifecycle[]>>` —
a command mapped to the states it is LEGAL FROM. Two consequences bite anything that models
edges as `(from, command, to)`:

## 1. The to-state is only in the reducer body
Read the reducer, not the table. One `(fromState, commandKind)` can yield SEVERAL to-states:
- `plan.propose` from PLANNING -> `PLANNING` (no live planner effect / idempotent replay) or
  `SUBMISSION_DRAINING` (draining).
- `planning.finalize_submission` -> `PLAN_REVIEW` (seal branch) or `REJECTED` (refusal via
  `rejectRun`, `planning-results.ts`).
- `graph.approve` on GRAPH_REVISION from PENDING_APPROVAL -> `APPROVED` (activation undefined)
  or `ACTIVE` (compound approve+activate); from APPROVED -> `ACTIVE`.
- `graph.approve` on PLANNING_RUN -> `ACTIVATED` from both PLAN_REVIEW (compound J1) and APPROVED.
- Idempotent replays are self-edges: `plan.approve` APPROVED -> APPROVED.
Verified-by-source method: read the branch, note the `clonedState(..., { lifecycle: ... })`.

## 2. An empty from-state list has TWO meanings
- Creation command, legal only with no prior state: `goal.create`, `project.register`,
  `planning.create_draft`, `graph_revision.create`.
- Never legal at all: `planning.cancel` (planning-run-reducer.ts) and `graph.supersede`
  (graph-revision-reducer.ts) both sit in their tables with `[]` and are routed to `illegal()`.
  GRAPH_REVISION reaches `SUPERSEDED` through authority loss (`supersededAuthority`), never
  through the table.
A rule of "empty means GENESIS" fabricates phantom edges and phantom race pairs. Declare the
two classes separately and assert they exactly partition the empty rows — see
`packages/testkit/src/schedule/schedule-universe-tables.ts` (`GENESIS_COMMANDS` /
`NEVER_LEGAL_COMMANDS`) and the gate test in `tests/property/schedule/schedule-coverage.test.ts`.

## Cheap tooth against transcription typos
Assert every authored state is `GENESIS` or a member of
`RUNTIME_LIFECYCLES[aggregate]` (`packages/contracts/src/runtime/runtime-vocabulary.ts`), and
that no edge points INTO the genesis pseudo-state. A from-state/command lockstep check alone
leaves hand-written to-states completely unasserted.
