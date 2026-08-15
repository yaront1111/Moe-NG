# BACKLOG does not hold — parked tasks come back and get claimed

Measured 2026-08-09 across **three independent instances in under an hour**. This is a board defect,
not a coincidence.

| # | Task | How it got to BACKLOG | Back in PLANNING |
|---|---|---|---|
| 1 | `task-8470a860` | governor withdrew WORKING→BACKLOG, 14:20Z, as a duplicate | served as top-ranked CRITICAL 14:29Z — **and again after I released it** |
| 2 | `task-a02496064e` | I created it with `status: "BACKLOG"`; create response confirmed BACKLOG, 14:47:35Z | served as PLANNING ~2 min later |
| 3 | `task-9634ed3b` | governor demoted PLANNING→BACKLOG, 14:17Z | served to me 15:04Z |

Three different origins — governor withdrawal, architect create, governor demotion — one transition.

## Consequences
- **Withdrawing or demoting to BACKLOG does not contain a task.** The governor's own demotion note
  said "Leaving it claimable is not offering work; it is offering a trap" — and the trap sprang
  anyway, on the very task the note was written for.
- **`BLOCKED` is currently the only status that holds.** Use it for containment, including for
  SPIDR parent shells and dependency-gated successors, and say in the reason that it is a
  containment block rather than a technical one.
- **Dependency ordering expressed by parking a successor in BACKLOG is enforced nowhere.** A
  dependent task is served to an architect the moment it exists, prerequisite landed or not.
- Releasing a task you were wrongly served does **not** help — instance 1 came straight back on the
  next `claim_next_task`. Block it, then release.

## Architect self-defence
Before spending a context load on a claimed task, read `reopenReason` FIRST. A withdrawn or demoted
task carries the governor's reasoning there, and it is usually a complete answer. Then re-measure
its disk claim in one command (the stale-by-default rail binds in both directions, so a gap claimed
present may be closed) and block rather than plan.

Related: `mem:moe-backlog-to-done-transition-blocked` — BACKLOG is also blocked from reaching DONE
directly, so a SPIDR parent shell needs a REVIEW transit hop.
