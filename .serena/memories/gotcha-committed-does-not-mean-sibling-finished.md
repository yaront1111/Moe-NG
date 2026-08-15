# A dependency's files can be in HEAD while its worker is still mutating them

Checking `git ls-tree HEAD` for a prerequisite task's files is NOT a check that
the prerequisite is finished. In a shared worktree with foreign whole-tree
completion hooks, another task's commit sweeps your dependency's in-flight bytes
into HEAD long before that dependency's worker stops editing them.

Seen 2026-08-09: task-af99cf14's gate asked "is sibling 2a committed?".
`git ls-tree -r HEAD` listed all six of 2a's files, so the naive read was
"committed, proceed". It was wrong — the bytes were in commit 6daa942, the
*motion-guard* task's whole-tree sweep. 2a itself was `step-10 IN_PROGRESS` and
its worker was ALIVE and CODING.

## The check that actually answers the question

Three signals, and the first two are the weak ones:

1. `git ls-tree -r HEAD -- <paths>` — files exist. Says nothing about who put
   them there or whether editing stopped.
2. `git status --porcelain -- <crate>` — a clean tree is a SNAPSHOT. A worker
   mid mutation-drill is clean between mutations; I measured `cargo check`
   exit 0 while the sibling was actively drilling.
3. **`moe.list_workers` + the sibling task's step statuses.** `status: CODING`
   with `currentTaskId` = the dependency, and a plan step still `IN_PROGRESS`,
   is the only signal that settles it. Read the step's *text*: a final
   "verify, attack, commit" step means a mutation drill is running.

## Why the distinction is not pedantic

A mutation drill restores production files by rewriting their contents. Bytes
you add to a file the sibling is about to restore vanish, and `git status` is
clean afterwards — the loss is invisible. Compare
`mem:mutation-drills-in-shared-worktree`, which is the same failure seen from
the drilling side.

Second edge: the sibling's step-10 `git commit -- <its owned paths>` captures
whatever you wrote into files you both own.

## Also: do not take a baseline mid-drill

A pre-diff verification run taken while a sibling is drilling records a foreign
red — or a foreign green over mutated bytes — as YOUR baseline. That is worse
than having no baseline, because the path-attributed-baseline rail then
subtracts the wrong set. Take it after the sibling settles.
