# A task description can name the WRONG symbol for a capability that really exists

The near-miss is more dangerous than a plain absence, because the grep comes back empty and the
honest-looking response is a confident BLOCKED on work that was ready to do.

## The instance (task-5fcfdae5, consumer edge for the approval policy contract)

The description said: "compose decideApprovalAuthority in front of the existing **plan.approve**
path in apps/daemon."

    grep -rn "plan.approve" apps/daemon/src/   ->  ONE hit, and it is a test fixture

Read literally: no daemon approval path exists, so the consumer edge cannot be built — block.
**Wrong.** `plan.approve` is the CORE reducer's command kind (planning-run-reducer.ts:174). The
DAEMON's approval command is **`approval.decide`**, handled by `decideApproval` at
`apps/daemon/src/planning/planning-services.ts:146` and wired at :181 in `PLANNING_HANDLERS`.

The capability was fully present. Only the name in the description was wrong.

## What actually found it

Reading the daemon's **command registry** (`daemon-command-registry.ts:44-50`) — an enumerated map
of every command kind the daemon routes. The registry is the territory; the description was a
sketch of it. `"approval.decide": CAPABILITIES.PLANNING` sat three lines from `"plan.propose"`,
which the description had gotten right, so the mistake was one plausible name in a correct list.

## Rule

When a description names a command, handler, or route and the grep is empty, do NOT conclude the
path is absent. Find the ENUMERATION and read it:

- daemon commands → `apps/daemon/src/daemon-command-registry.ts` (BOOTSTRAP/REVIEW/SESSION/WORK families)
- handler wiring → the `*_HANDLERS` tables (e.g. `PLANNING_HANDLERS`)
- package surface → `src/index.ts` and its `index-surface.test.ts` catalogue

A missing route is provable only from the enumeration that would have to contain it. One empty grep
on a name someone else typed proves nothing — and this is the *second* shape of that error on this
board, alongside `mem:gotcha-guessed-symbol-grep-is-a-false-negative` where the searcher invents the
name. Same failure, different author.

## Corollary for the plan you then write

Record the correction prominently in `planningNotes`, because the next reader will hit the same
wrong name in the same description. In this case the plan's step 1 opens with "the description says
plan.approve; there is none; the daemon's command is approval.decide — do NOT report blocked on the
description's name."

Related: `mem:moe-hard-dependencies-are-prose-not-fields`,
`mem:gotcha-guessed-symbol-grep-is-a-false-negative`, `mem:deps-done-is-not-deps-reachable`.
