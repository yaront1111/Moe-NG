# J1's command path in @moe/daemon — completed 2026-08-09 by worker-0b27a5cc

Closes the M1 exit blocker recorded in `mem:project-m1-exit-gate-gap-2026-08-09`.
That memory's "still open" section stays accurate: **J3 and J4 remain missing.**

## The binding (record it; `mem:spec-foundation-journeys-hand-transcribed` J1-C asks for it)

Design 1095's three human actions map to daemon command kinds as:

| action | design concept | kind | core path | result |
|---|---|---|---|---|
| 1 | `goal.create` | `goal.create` | `reduceGoal`/create | goal DRAFT v1 |
| 2 | exact plan/initial-graph approval | `approval.decide` (EXTENDED) | `applyApprovalCommand` + `reduceGoal`/`goal.activate_initial_graph`, ONE commit | approval DECIDED + goal EXECUTION_ENABLED v2 |
| 3 | final acceptance | `goal.close` (NEW) | `reduceGoal`/close with BOTH witnesses | GoalClosing+GoalCompleted, goal COMPLETED v4 |

Exactly ONE kind was appended to `BOOTSTRAP_COMMAND_KINDS` (9 -> 10): `goal.close`.
`goal.activate_initial_graph` is deliberately NOT a kind — it is not in
`RUNTIME_COMMAND_KINDS` and composing it inside `approval.decide` is what keeps J1 at
three actions (design 299).

## The constraint that shaped everything

**The store commits ONE `targetAggregateId` per decision** (`store-contracts.ts:74-84`).
So "atomic" == one `commitExpectedVersionDecision` call. Consequences:

- The approval+activation pair targets the **goal** aggregate, because that is the
  lifecycle action 3 must read back.
- The committed **result must be a bare `GoalState`** — `validGoalState` does
  `exact(value, STATE_KEYS)` over exactly 12 keys, so a `{approval, state}` wrapper would
  make the goal unreadable to the next goal command. The decided approval record therefore
  rides in the same decision's **event payload** (`store.readEvents(goalId)`).
- `decideApproval` performs **no commit at all**; the single commit is inside
  `activateInitialGraph`. Every gate returns early, so a partial approval is not merely
  rejected, it is unrepresentable.

## Files, and the ones outside the declared owned paths

Owned: `goals/**`, `planning/**`, `bootstrap-contracts.ts`. Forced beyond that, all inside
`apps/daemon` and all consequences of appending one kind:

- `bootstrap/bootstrap-sequence.ts` — `COMMAND_PREREQUISITES` is
  `satisfies Readonly<Record<BootstrapCommandKind, ...>>`, i.e. **exhaustive**. A new kind
  without an entry is a compile error. This will bite anyone adding a kind.
- `bootstrap/bootstrap-services.test.ts` + `bootstrap/bootstrap-durability.test.ts` — both
  pin the kind list by hand-written set equality AND length. DoD 6 requires that pin, so
  both literals move 9 -> 10.
- `bootstrap/bootstrap-test-fixtures.ts` — shared fixture module; now 345 lines (test tier,
  under the 400 split). New builders: `approvalPayload`, `acceptancePayload`,
  `planningActivation`, `closureWitness`, `zeroAuthorityWitness`, `GRAPH_REVISION_REF`.

New module: `planning/approval-activation.ts` (83 lines) + its `.js` bridge.

## Anti-forgery bindings worth preserving

- `graphApprovalRef` on the assembled `InitialGraphActivationWitness` is the **core's own
  decided `approvalRef`**, never a payload field — an activation cannot cite an approval
  other than the one just decided.
- `goalRef` is read from the **durable planning run state**, not the request, so an
  activation cannot be redirected at a goal the plan was never proposed for.
- `expectedVersion` for the activation is `PlanningActivationWitness.expectedGoalVersion`,
  judged by the core's `validExpectedVersion` + version check.
- `truthClass` comes from the caller's witness on purpose, so the core's `strongTruth` stays
  load-bearing and reachable (drill-verified).

## Deliberate gaps, do not read as oversights

1. **The planning RUN lifecycle does not advance on approval.** The core ALREADY implements
   design 299 in full as `reducePlanningRun`'s `graph.approve`
   (`planning-run-submission.ts:138`, comment "J1: plan decision, graph decision, and
   activation commit as one atomic result"), consuming `PlanApprovalWitness` +
   `PlanningActivationWitness`. Not folded in because (a) it needs the run in `PLAN_REVIEW`,
   which needs `planning.finalize_submission`, which `plan.propose`'s handler forbids as a
   chain tail, and (b) it would put a THIRD aggregate in one decision. Real follow-up.
2. **A typed acceptance DECLINE is not expressible.** `approval.decide` refuses a non-APPROVE
   decision (`DAEMON_PREREQUISITE`/`BOOTSTRAP_PAYLOAD_INVALID`) because letting one through
   would activate a graph the human refused. Declines are J4's journey.
3. **`CLOSING` is unreachable through this surface.** The core's close() `CLOSING` branch
   requires `closureWitness` to be ABSENT; this handler always sends it. Intended — sending
   both witnesses is what makes acceptance ONE action instead of two.

## Verification

`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test && pnpm typecheck`
exit 0 — daemon 20 files / 453 tests, root recursive typecheck Done for 16 projects.
Reaching green needed polling; see `mem:gotcha-shared-worktree-blocks-root-gates`.

Commits: `febf6a7`, `0adef4b`, `511f656`. **The planning half is in FOREIGN commit `878538b`**
(swept by task-fa96b81c's completion hook). Review with `git diff 878538b~1 -- apps/daemon/src`.

Related: `mem:gotcha-exhaustive-prerequisite-record-blocks-a-kind-append`,
`mem:gotcha-completion-hook-commits-whole-tree`,
`mem:pattern-prove-a-published-package-root-with-plain-node`.
