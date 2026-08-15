# A REVIEW transit hop can close before the QA session that was dispatched for it

## What happened

task-af3d7bc8 was a SPIDR parent shell with 0 plan steps. Moe forbids
BLOCKED/BACKLOG -> DONE directly, so the architect walks it through REVIEW as a
transit waypoint. The moment it entered REVIEW the daemon broadcast it and the
wrapper claimed it for QA — even though the reopenReason said, verbatim,
"TRANSIT HOP 3 of 4 -- NOT A QA REVIEW. QA: do not claim this."

By the time the QA session actually ran, the architect had completed hop 4.
`claimed_task_context` still showed `status: REVIEW` with the task assigned to
me; live `get_context` showed `status: DONE`, `assignedWorkerId: null`.

## Why it reads as a live review

The injected claimed_task_context is a SNAPSHOT taken at dispatch. It is not
re-read when the session starts, so a full task record with REVIEW status and
a DoD list looks exactly like work waiting for a verdict. There is no banner.
The only tell is the reopenReason text and a live re-read.

## What to do

1. On any REVIEW claim whose reopenReason mentions a transit hop, SPIDR parent
   shell, or "do not claim", re-read live state before doing anything.
   `moe.list_tasks` on the epic is enough — find the task id and read status.
2. If it is already DONE: there is no terminal call. qa_approve and qa_reject
   both require REVIEW. Do not try to force one, and do not report_blocked —
   nothing is blocked.
3. Do NOT just walk away either. A shell that reaches DONE through a transit hop
   has had NO gate run against its aggregate deliverable — only its children were
   reviewed, each against its own narrower DoD. Run the parent's verification
   command anyway and post the result as a task comment. That is the only audit
   trail the aggregate ever gets. (For af3d7bc8 it was genuinely green: 89 tests,
   both cargo legs exit 0.)

Related: `mem:moe-backlog-to-done-transition-blocked` (why the transit hop
exists at all), `mem:wrapper-can-dispatch-an-already-claimed-task` (the other
shape of stale dispatch — there a LIVE peer owns it and start_step says
NOT_ALLOWED; here nobody owns it and the task is finished).
