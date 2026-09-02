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

## 2026-08-24 confirmation: it fires AFTER REVIEW, and it defeats "leave it dirty for its owner"

Second, independently measured instance on `task-f04b6a22dfcc4581b4470dbf79b2a3b3` (qa-fc9c6bbd found it, worker-4b8f0e0a re-measured it):

```
eeab253 fix(task-f04b6a22dfcc4581b4470dbf79b2a3b3): ... (retry after qa_reject #1)
        body: "Completed via Moe worker session"
        authored 11:59:56Z — row reached REVIEW at 11:59:09Z (47s EARLIER)
  apps/daemon/src/activation/admission-gate-resolver.test.ts  +87   owner: task-064b9758 (BLOCKED, WIP-preserve)
  apps/daemon/src/activation/admission-witness-fixtures.ts    +12/-15 owner: task-cc3898ce
```

New facts beyond the 08-07 instance:

1. **Timing.** The sweep is a session-end action, not a completion action. It lands AFTER the row is already in REVIEW, so "I submitted for review with a clean owned-path commit" does not close the window. The worker's own correct commit here was `2046529` — one explicit pathspec, one owned path, +25.
2. **Shape.** `<type>(task-<id>): <title> (retry after qa_reject #N)` + "Completed via Moe worker session". 2 of the last 40 commits had it; it appears to fire on **reopened/retry rows** specifically.
3. **The "leave it dirty for its real owner" strategy is wrong by default.** Deliberately not committing a foreign path does not preserve it as uncommitted — the sweep commits it anyway, under YOUR task id. Predicting the harm in writing beforehand does not prevent it.

### Two derivations this inverts
- `git log -S <symbol> -- <foreign path>` flips **0 -> 1 commits**. Anyone re-deriving "this has never been committed" from that command after a sweep gets the opposite answer, and the reason is in no task record.
- `git status` / `git diff HEAD` on a swept path now read **CLEAN**. Clean no longer means "nothing of mine is pending here" — it can mean "it already landed under someone else's row." Content preserved, provenance and location changed.

### Governance position taken (human, 12:08Z)
Keep the epic rail unchanged; fix the session-end retry auto-commit to commit only explicit task-owned paths, or refuse when ownership is unknown. **No revert, no reset** — both either destroy other rows' in-flight work or are banned by rail 3. QA should approve on merits and file the mechanism defect rather than reject: a reject routes the row back to WORKING where the same sweep fires again on that session's end.

See `mem:task-064b9758-policy-family-census` for the census that had to be redone because of this.
