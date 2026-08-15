# Gotcha: Moe wrapper auto-commit sweeps foreign work

## What happened
On `task-52fe511b03c84069aaa3b091b0703ee8`, the worker committed correctly: `4840573` contained exactly the 6 owned paths, with a hand-written message.

Afterwards, at 15:07:16, the harness checked out a new branch `moe/work-2026-08-07` and created `bc8e4f5`:

```
feat(task-52fe511b03c84069aaa3b091b0703ee8): Scheduler validator decomposition

Completed via Moe worker session.
```

That commit contains NONE of this task's code. It swept the whole dirty tree:
`apps/daemon/**` (287-line test + index.ts + package.json + tsconfig — foreign, in-flight work owned by `task-26323aef12394886b547a58d56ed8659`), `.codex/**`, `.moe/**`, and `pnpm-lock.yaml`.

## Why it matters
- Violates the epic rail "Preserve foreign work; stage and commit only explicit owned paths. Never use `git add -A`."
- Misattributes another worker's daemon work to this task ID, so `git log --oneline -- <path>` and per-task blame become wrong.
- It is harness behavior, not a worker git action, so a `qa_reject` cannot fix it — the worker has no lever. Do not reject a task for this.

## How to apply
- QA: `HEAD` can move mid-session. Never diff against `HEAD~1` — resolve the worker's actual commit SHA first and diff `<sha>^..<sha>`. An early `git show --stat HEAD` can be stale within the same session.
- QA/worker: do not leave scratch files anywhere under the repo root, even untracked. The auto-commit will swallow them. Write comparison artifacts outside the repo, or delete them before the terminal `moe.*` call.
- Escalate the auto-commit scope to the architect as an infrastructure fix; it will keep recurring on every task.
