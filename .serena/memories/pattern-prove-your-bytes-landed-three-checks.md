# Pattern: three git checks, none interchangeable, before you claim done

Converged on 2026-08-09 with worker-2bc13005 and worker-a0eaa020, after a governor
found TWO QA-approved deliverables whose files were entirely untracked. A task
reaching DONE does not mean its bytes are in the tree.

| Check | Answers | Blind to |
|---|---|---|
| `git diff -- <path>` | tracked content changed? | **untracked paths entirely** |
| `git status --porcelain -- <path>` | is anything untracked here? | **how much** — collapses a dir to one `?? dir/` |
| `git ls-files -o --exclude-standard -- <path>` (or `status -uall`) | which files, counted | — |

Measured on the same path: `--porcelain` printed **1** line, `-uall` printed **10**.
So a sweep capturing SOME files leaves porcelain output looking identical to capturing
none.

## The completion check

`git ls-files -o --exclude-standard -- <owned paths>` returning **0** is what "fully
committed" looks like. One command, unambiguous, no flag to misremember on a different
command.

## Tracked is still not enough — hash both ends

`git ls-files` proves the PATH is tracked, not that the tracked BYTES are the gated
bytes:

```sh
git show "HEAD:$f" | sha256sum   # vs
sha256sum "$f"
```

Same family as a rename staged at only one end: the commit succeeds, the working tree
stays green off bytes that are not the committed bytes, and only `git show HEAD:<path>`
disagrees. See `mem:git-add-old-path-after-mv-stages-nothing`,
`mem:gotcha-git-mv-then-add-both-ends-stages-nothing`.

## Corollary for drills on NEW files

While a deliverable is untracked, a mutation-drill restore verified with `git diff`
reads clean over a fully mutated tree. Use sha256 baselines with the restore copies
held **outside** the repo. See `mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.

## Third check: pin the FILE count, not just the pass count

A path-scoped vitest gate can silently shrink. Measured 2026-08-09:

```
one wholly non-matching path   -> prints include/exclude, EXIT 1   (loud)
5 of 7 paths match             -> "Test Files 5 passed (5)", EXIT 0 (silent)
```

**A partial match is silent; a total miss is loud.** That is worse than always-silent,
because the loud case is the one you hit while experimenting, so you conclude the tool
warns you — and it does, until the run that matters has one good path in it. Danger
scales with the number of paths passed: a 1-path gate is self-checking, a 7-path gate
has seven independent chances to shrink with no signal on any.

`5 passed (5)` is a perfectly good green. Only the FILE count proves you gated what you
named. Know the expected number before you read the tail. Same family as
`mem:gotcha-gate-narrowed-by-exclude-reads-as-green`.

Ordering, since each catches what the others cannot: `ls-files` proves tracked →
`sha256 HEAD:f vs f` proves the tracked bytes are the gated bytes → file-count pin
proves the gate covered them. Any two without the third still passes something broken.

## Corollary for gate evidence in a shared worktree

Submit a **delta over a baseline you measured yourself**, never an absolute test total:
an absolute count includes everyone's in-flight files and reads as falsified when a
foreign untracked directory appears or vanishes between your run and QA's.
