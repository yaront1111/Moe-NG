# Gotcha: `git diff` cannot verify a mutation-drill restore on an UNTRACKED file

Found on `task-fa96b81c` (2026-08-09), greenfield directory
`packages/scheduler/src/readiness/`.

## The trap

The standard drill instruction is "verify each restore with `git diff` on the specific
file rather than `git status`". That is correct advice for TRACKED files. On a
greenfield task every production file is still **untracked**, and

```sh
git diff -- packages/scheduler/src/readiness/readiness-facts.ts
```

prints **nothing whether or not the file was restored** — git has no committed blob to
diff against. The check silently proves nothing, which is worse than not running it:
it reads like evidence.

## What to do instead

Hash every file BEFORE the drill and compare after each restore:

```python
base = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in R.glob("*.ts")}
# ... mutate, run, write orig bytes back ...
restored = hashlib.sha256(p.read_bytes()).hexdigest() == base[name]
```

This is strictly stronger than `git diff` even for tracked files, and it also catches
`mem:mutation-drills-in-shared-worktree` — another agent's whole-tree hook committing
your drill edit, which makes `git diff` AND `git status` both look clean.

## Two related bites from the same task

- **A crashed driver leaves a mutation on disk.** The first drill run died on a
  cp1252 `UnicodeDecodeError` reading vitest's output (`subprocess.run(..., text=True)`
  on Windows) with mutation (a) still applied. Decode explicitly:
  `subprocess.run(..., capture_output=True)` then
  `(r.stdout + r.stderr).decode("utf-8", "replace")`. Always print a final
  "ALL FILES RESTORED" line computed from the hashes, so a partial run is loud.
- **A foreign whole-tree commit can track your files mid-task.** Four of the files
  were already tracked by commit time, so the pathspec commit showed 9 creates + 4
  modifications instead of 17 creates. Not a defect; say so in the handoff or QA will
  read the commit as incomplete
  (`mem:gotcha-foreign-whole-tree-commit-preempts-your-pathspec-commit`).

Related: `mem:mutation-drills-in-shared-worktree`,
`mem:task-task-fa96b81c013a49e1b5adadf5662a086c-handoff`.
