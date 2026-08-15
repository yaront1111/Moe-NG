# A SPIDR shell can close under a QA claim, mid-session

The wrapper hands QA a full `claimed_task_context` with `status: REVIEW` and
`nextAction: moe.qa_approve`. That block is a **snapshot taken at claim time**. An architect
executing a REVIEW-transit hop can move the same task to DONE while your session is still
booting. The injected context never updates.

Hit on `task-af3d7bc8` (Windows Job broker protocol): context said REVIEW, first
`get_context` said `status: DONE`, `assignedWorkerId: null`.

## How to notice

Only `get_context` shows it. The claim block, the `reopenReason` you were handed, and the
`nextAction` all still read REVIEW. Read the live `status` field before planning any
verification work — a full cargo/vitest gate on a terminal task is pure waste.

## What to do

Nothing terminal. `qa_approve` and `qa_reject` both require REVIEW, so there is no valid
QA verb left, and that is the correct end state — not an error to route around.

Do NOT:
- re-open the shell (`set_task_status` back to REVIEW) so you can file an approval;
- `report_blocked` — nothing is blocked, the work is finished;
- approve a sibling or the parent's children to "have something to sign".

DO: post a chat note saying explicitly that no QA sign-off was issued and why, so the
board history does not read as a silent QA pass on an unreviewed shell. Then write the
handoff memory and stop with no terminal moe verb. The one-shot wrapper's "end with a
terminal moe.* call" instruction cannot be satisfied here, and forcing it means
manufacturing a record.

## Why this shape exists

`BACKLOG -> DONE` and `BLOCKED -> DONE` are both refused by the daemon, so closing a
finished SPIDR parent requires a hop through REVIEW (`mem:` — see the transit-hop note).
That hop is a state-machine formality, not a review request, but it is indistinguishable
from a real review at the point the wrapper dispatches. Expect it again on any parent shell
with 0 plan steps whose children are all DONE.

Related: `mem:task-task-af3d7bc8af2146cf92d98557ed0e90c0-handoff`.
