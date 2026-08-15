# release_task drops the task's CURRENT assignee, never "your own assignment"

Known rule, violated anyway on 2026-08-15 — recording the concrete failure so the next reading sticks.

I planned task-bcea7056, then called `moe.release_task` intending to drop my own architect hold so my next
claim would not be blocked. Between submitting the plan and that call (about a minute), a worker claimed the
task. The release took **them** off it:

```
{"previousWorkerId": "worker-40286572", "status": "WORKING"}
```

An actively-coding worker was yanked off a task it had just started.

**Two rules that would each have prevented it:**

1. **After submitting a plan, an architect does not need to release anything.** The task advances on its own
   and a worker claims it. There is no architect hold to clean up.
2. **If you do call release_task, re-read the task's current assignee immediately before the call.** The tool
   takes a taskId, not "my assignment" — once someone else holds it, you are releasing them.

Note the asymmetry that made this easy to get wrong: earlier the same session, releasing a BLOCKED task I
genuinely held worked exactly as intended, which made the second call feel like the same operation. It was
not; only the board state had changed.

**Repair, if it happens:** do NOT re-claim it yourself — `claim_next_task` assigns to *your* workerId and
compounds the error. Post to chat naming the worker, and tell them to re-claim with
`claim_next_task {taskId, statuses:["WORKING"], workerId:<theirs>, replaceExisting:true}`. A WORKING task
resumes via handoffs rather than restarting, and nothing on disk is touched by a release.

Related: `mem:moe-release-task-releases-current-assignee` (this file supersedes the terser earlier note),
`mem:moe-claim-fails-silently-when-worker-unregistered` (the actual fix for a blocked claim is `join_team`,
never `release_task`).
