# Gotcha: an automated whole-tree commit lands under YOUR task id and looks like a rail-3 violation

Observed repeatedly on `moe/work-2026-08-08`, confirmed during QA of `task-386fcb4c`
2026-08-09.

## The shape

Each task ends up with **two** commits:

```
3e7081d  fix(task-386fcb4c...): add package-wide .js runtime bridges to @moe/core   <- worker, pathspec-clean
a6e46f6  feat(task-386fcb4c6d0241289f177cec9a3010e8): Add package-wide .js runtime bridges to @moe/core
```

The second is machine-generated: **full** task id, the task **Title verbatim**
(capitalised, so "Add" where the worker wrote "add"), body often just
`Completed via Moe worker session.` It is a **whole-tree** commit — `a6e46f6` carried
65 files across control-room, daemon, context, review, `tests/runtime` and `.moe`
board state, none of them owned by that task. Same pair exists for other tasks:
`c699422`/`5d77dde` for `task-e17da1c9`.

## Why it matters to QA

Read naively, `git log --oneline` says the worker committed 65 foreign files and
violated epic rail 3. It usually did not. **Judge rail 3 against the worker's own
pathspec commit**, and check separately whether the wrapper commit touched the
task's owned paths at all (`git show --stat <sha> -- <owned path>`). For
`task-386fcb4c` that was empty, so the deliverable was unaffected.

## Two consequences worth knowing

- **Your file can appear as `M` instead of `A`** in your own commit, because an
  earlier foreign whole-tree commit already swept your in-progress work. That also
  means HEAD can be RED between the two commits, carrying a test whose subject does
  not exist yet.
- **`git status` cannot confirm a mutation-drill restore** — the same hook may commit
  your drill edit and leave status clean. Verify restores by bytes (`od`) and by a
  re-green test run (`mem:mutation-drills-in-shared-worktree`).

## The commit TITLE is metadata. Two instruments answer two different questions.

Established 2026-08-09 across task-684e6972 / task-318379ea, after I attributed a
line to the wrong agent by reading a commit's title instead of measuring.

```sh
git log -S '<the line or token>' --oneline -- <path>   # where a LINE entered
git log --diff-filter=A --oneline -- <path>            # where a FILE entered
git show --stat <sha> -- <path>                        # did that commit touch it at all
```

Both are needed; they answer different questions and either alone misleads.

Measured demonstration: `apps/daemon/src/daemon-entry.ts` first appears in
**`749eb46`, titled "Linux platform observation boundary"** — a task that never
touched `apps/daemon`. One worker's transport-seam files ended up spread across
**three foreign-titled sweeps**. Meanwhile `f4e12bf`, titled for one task, carried
another's `http-listener.ts` and `package.json`, so the title pointed at an agent
whose commit never touched the file in question.

**Corollary for a shared worktree:** a line can be on disk and in NO commit. When
that happens `git show HEAD:<path> | wc -l` and `wc -l <path>` disagree, and `-S`
cannot find the state you measured because no commit ever recorded it. If you
disclose a collision, say which of the two you measured — otherwise a reviewer
re-running `-S` will conclude you invented it.

## Don't reject on it

It is harness behaviour, not worker behaviour, and rejecting sends a worker to fix
something it cannot control. Note it in the verdict and move on.

Related: `mem:mutation-drills-in-shared-worktree`,
`mem:task-task-386fcb4c6d0241289f177cec9a3010e8-qa-verdict`.
