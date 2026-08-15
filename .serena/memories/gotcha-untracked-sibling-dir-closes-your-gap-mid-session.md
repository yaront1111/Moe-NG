# A live writer can close your task's measured gap DURING your session

Found on task-a95ccf7e (colour token layer), 2026-08-09.

## The trap
The architect measured "zero colour literals exist repo-wide" at HEAD 7d9efc9 and planned a build
around that gap. By execution time an **untracked** `apps/control-room/src/styles/` already carried
the tokens, the `[data-tone]` rules and a contrast test. `git log` shows nothing (untracked),
`git diff` shows nothing (untracked), and `grep -l` over `.moe/tasks/*.json` found **no owning
task** — so every board-level check said the gap was still open.

## Detector, cheap and decisive
```
ls -l --time-style=+%H:%M <suspect-dir>     # then again a minute later
```
A file that appears **between two listings** proves a concurrent writer, not stale residue. On the
task above, `surfaces.css` was absent at 18:19 and present at 18:20.

Corollary: when your first act is `ls` on your target directory, **also `ls` its siblings**. The
duplicate rarely lands on the exact path your plan names — here the plan said `src/theme/`, the
writer used `src/styles/`.

## Why "just build it anyway" is wrong
Two stylesheets setting the same selector with different values resolve by **import order**. A
contrast/property certification over your palette then certifies values the browser never renders —
the certification is worse than absent, because it retires the requirement while proving nothing.

## Do not close as duplicate without reading the duplicate's assertions
The pre-empting work asserted contrast with a **test-local `luminance()` helper and hex restated in
the test body** — exactly the anti-pattern this task's DoD forbade. The artifact was duplicated;
the *requirement* was not met. Blocking with "retarget, don't rebuild" is the honest outcome:
certify the landed tokens from production code instead of shipping a second palette.

Related: `mem:gotcha-git-diff-is-blind-to-untracked-paths`,
`mem:mutation-drills-in-shared-worktree`.
