# A drill's restore can abort because the MUTATION made the anchor ambiguous

Cost me a cycle on task-2561a780 QA, 2026-08-11.

## The shape

The standard mutation harness aborts when `src.count(anchor) != 1` — correct, and it is what stops
a silent no-op. But the RESTORE call searches for the MUTATED text, and the mutated text may
collide with something that was already in the file.

```ts
// two sibling functions in expansion-admission.ts
fromLayered: code: issue.code, layer: issue.layer, origin,   // <- I mutated this
fromFlat:    code: issue.code, layer: origin, origin, ...    // <- this already existed
```

Mutating `layer: issue.layer` -> `layer: origin` made the replacement string occur **twice**. The
restore reported `ANCHOR_COUNT=2 ABORT` and left the mutation ON DISK.

## Why it is worse than a normal failed restore

The next drill in the loop then runs on a DIRTY base. Its output showed the previous drill's two
failures plus its own, which reads as **stronger coverage than the drill actually proved**. I only
caught it because a `RESTORED_MATCH: NO` line was printed. Without that check I would have credited
the second drill with reddening tests it never touched.

## Do this instead

1. Restore with `git checkout -- <file>` for tracked files, never by reverse-replacing. It cannot
   go ambiguous. (Untracked new files still need `git hash-object` — see
   `mem:gotcha-git-diff-is-blind-to-untracked-paths`.)
2. Print a hash comparison after EVERY drill, not once at the end of the loop.
3. Choose the mutation so its output cannot already exist in the file — mutate to an obvious
   sentinel (`"ZZZ"`) rather than to another real value from the same module.

Related: `mem:gotcha-layer-only-and-code-only-drills-must-be-run-separately`,
`mem:mutation-drills-in-shared-worktree`, `mem:mutation-drill-red-on-wrong-assertion`.
