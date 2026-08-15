# An untracked directory declared "unowned" may be mid-write

## The trap

The shared worktree accumulates untracked directories with no task claiming them.
The standard governance move is an `@all` broadcast — *"if you built these files,
say so NOW; silence means unowned and it gets adopted."*

**Silence is not evidence of absence. A worker mid-step does not read chat.**
Adoption on silence hands a live working set to a second owner, and both then
write the same files.

## Why the task board cannot answer it

The instinct is to sweep `.moe/tasks/*.json` for the path and report "no task
names it, therefore unowned." That inverts the evidence:

> **The absence of a naming task is evidence FOR an unrecorded producer, not
> against one.** An agent writing to a path that appears in no plan *is* the
> orphan condition itself.

Task metadata tells you who **claims** a path. Only mtime tells you who is
**touching** it. On a board where the whole problem is work no task claims, the
board is the one signal guaranteed to be silent.

## The measurement

```bash
date -u +"NOW=%Y-%m-%dT%H:%M:%SZ"
python -c "
import os,datetime
d='apps/control-room/src/styles'
for f in sorted(os.listdir(d), key=lambda f: os.path.getmtime(os.path.join(d,f)), reverse=True):
    p=os.path.join(d,f)
    print(datetime.datetime.fromtimestamp(os.path.getmtime(p), datetime.UTC).strftime('%H:%M:%SZ'), f, os.path.getsize(p))
"
```

Print `NOW`, or the timestamps prove nothing. **Print sizes too** — a file that
*shrank* between two reads (6275 B → 4654 B) is a refactor in flight, which a
mtime alone reads the same as a finishing append. **Re-list the directory**, do
not just re-stat known files: a *new* file appearing between two reads is the
strongest possible liveness signal.

Real case 2026-08-09: `apps/control-room/src/styles/` was declared unowned at
15:44:46Z; `responsive.css` had been written at **15:44:29Z**, 17 seconds earlier.
A re-measure at 15:48:06Z found four files rewritten 34 s prior and an
**eleventh file that had not existed 2m22s before**.

## Then check the adoption UNIT, not just the timing

A still directory can still be the wrong thing to adopt. Widen to the whole app
before ruling:

```bash
git status --porcelain -- apps/control-room/
git diff --stat -- apps/control-room/
```

That case: `styles/` was one slice of a **17-path** working set — 13 modified
tracked files (422+/225-) plus untracked `live/`, `preview/`, `shell-chrome.tsx`.
Adopting the directory under a narrow colour-token task would have committed
stylesheets mid-refactor, split one working set across two owners, and left the
larger orphan untouched. **Adopt all the untracked paths as one unit under one
owner, or find the producer — never a fragment.**

Sharper than an `@all`: ask about the **pure-new** directories (`src/live/`,
`src/preview/`). Nobody touches those incidentally, so a denial is meaningful.

## Proving a directory is not yours

`filesModified` on your current task is too narrow — check every task bearing your
worker id, and check imports (`grep -rn "styles/" <your owned dirs>`; no import =
no dependency either). `filesModified` unions every step's `affectedFiles` and so
**includes files only READ** — see `mem:moe-filesmodified-includes-read-only-files`.
It over-reports, never under-reports, which is what makes its *absence* a clean
negative.

## Related

- `mem:moe-shared-worktree-blocks-root-gates` — same root cause, other direction
- `mem:moe-finished-task-may-have-no-commit` — a DONE task's bytes may be untracked
