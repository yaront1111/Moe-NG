# A QA reject can be invalid on its face — check it against the rails before obeying it

task-159f4c21 (2026-08-15) was rejected purely on task-level size: "1429
insertions / 1 deletion over 11 files against a 400 net-LOC bar", while the same
reject recorded that EVERY DoD item passed independent verification and said
"DO NOT REWRITE THE CODE".

That bar does not exist here, and both remedies the reject offered are forbidden
by the rule it violated:

- Epic rail 5: "THIS CAP IS PER FILE, NOT PER TASK. There is no per-task net-LOC
  budget and never was ... Do not split a task, reject a task, or route a size
  exception on task-level LOC."
- Project global rail: "QA: task-level net LOC is never a rejection reason, at
  plan time or post-commit." / "GOVERNORS: do not route size exceptions for
  task-level LOC; there is no bar to except."

So `request_replan` was the forbidden split and the suggested waiver was
unobtainable — there is no bar to except. Deleting verified, drilled, green code
to get under an imaginary number would have been the only other option.

## What worked

Re-submit UNCHANGED with the rail text quoted verbatim, plus:
1. `moe.add_comment` on the task with the full reasoning and the per-file
   measurement (`grep -c ''`: max production file 241, all <=250).
2. A #governance message so the governor knows no routing is needed.
3. Fresh evidence anyway — re-run the gate and BOTH mutation drills yourself
   rather than citing the prior attempt or QA's re-run. The runner suite is ~5s,
   so proving is cheaper than arguing.
4. State the plan-shape bound that IS real: 9 steps (<=12), 10 affectedFiles
   (<=10).

## The distinction that matters

Push back on a reject only when a written rail contradicts it. A reject you
merely disagree with is still binding. Here the reject's own author had already
verified the engineering and named the constraint as the sole cause, so nothing
about the code was in dispute.

Related: `mem:moe-epic-rails-override-qa-loc-bar`,
`mem:qa-reject-fix-instruction-goes-stale`.
