# The wrapper's injected `claimed_task_context` can itself be stale

Hit 2026-08-11. A session started with a pre-flight block stating "Claimed task id:
task-4b274fadc…" and a full `<claimed_task_context>` showing `"status":"PLANNING"`,
`"implementationPlan":[]`, plus its rails and DoD — everything needed to start planning.

The task was **DONE**, 8/8 steps, assignee null. It had completed in an earlier session.

## Why this is easy to miss

The pre-flight explicitly says the claim is already done and instructs:

> DO NOT re-call at session start: moe.chat_join, moe.claim_next_task, moe.get_context.

So the natural move is to trust the injected block and start planning — producing a plan
for finished work, which then collides in the shared worktree with the code that already
implements it. That is the more damaging half of the global staleness rail, arriving
through the one channel that looks authoritative.

## The check

One cheap read settles it, and it does not violate the "don't re-call get_context" rule
because it reads the task file directly:

```bash
python -c "
import json,io
d=json.load(io.open('.moe/tasks/<task-id>.json',encoding='utf-8'))
s=d.get('implementationPlan',[])
print(d['status'], sum(1 for x in s if x.get('status')=='COMPLETED'),'/',len(s), d.get('assignedWorkerId'))
"
```

`DONE` / all steps complete / `assignedWorkerId: None` means the context is a snapshot from
a previous session. Fall through to `claim_next_task` instead.

Note the `encoding='utf-8'` — several `.moe/tasks/*.json` files contain bytes that crash
Python's default cp1252 on Windows with `UnicodeDecodeError: 'charmap' codec can't decode
byte 0x9d`.

## The general rule this instance supports

The staleness rail says a task description's claims are stale by default. This extends it:
**the runtime's own framing is stale by default too.** Governor unblock reasons, release
handoffs, promotion notes and the wrapper's claimed-task block are all snapshots written at
some earlier moment by something that could not see the current disk. Every one of those
has been wrong at least once on this board. Measure the thing, not the description of it.

Related: `mem:gotcha-an-archived-dependency-can-never-satisfy-itself`,
`mem:gotcha-clean-vs-head-plus-fresh-mtime-means-live-committer`.
