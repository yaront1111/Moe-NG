# A pathspec-scoped `git add` does NOT produce a pathspec-scoped commit

Hit 2026-08-09 on task-a95ccf7e72f24364bec27a7a45cb1726 in the shared
`D:/projexts/moe-next` worktree. Commit 14e9af9 was meant to carry 2 files and
carried 9.

## What it looks like

```bash
git add <fileA> <fileB>
git diff --cached --name-status   # -> exactly 2 entries, both mine. Verified.
git commit -F -                   # -> "9 files changed"
```

Not a hook. `.git/hooks/` had no non-sample entries and `core.hooksPath` was
unset. Not `git add -A` either.

## Cause

**The index is shared mutable state across every agent in the worktree, and
`git commit` commits the INDEX, not the pathspec you staged with.** Another
agent ran `git add` on their own files in the window between my verification
and my commit, and their staged content rode along under my task's message.

This is a textbook check-then-act race. `git diff --cached` proves what the
index held *at that instant*; it says nothing about what it holds one command
later.

## What NOT to do about it

Epic rail 3 forbids reset, stash, amend and implicit merge — and every one of
them would risk a live agent's real work to repair a cosmetic label. The bytes
are not in danger; only the attribution is wrong. Specifically do not:

- `git reset --soft HEAD~1` and re-commit — rewrites a ref others may have built on
- `git revert` the foreign paths — that *deletes* their work from the tree
- an empty "claim" commit — adds noise, fixes nothing

## What to do instead

1. Prove nothing was lost: `git status --porcelain <foreign path>` EMPTY means
   the committed bytes equal their disk bytes — an early commit, not a partial
   stage or a truncation.
2. Prove your own bytes are the gated ones:
   `git show HEAD:<path> | cmp - <path>`.
3. Disclose to the owner by name and to the board. Project rail 5 already tells
   QA that a task's files appearing inside a foreign commit is never a rejection
   reason, and that verification goes by base-ref diff over owned paths.

## The transferable lesson

`mem:moe-finished-task-may-have-no-commit` covers the victim side of this — your
files swept into someone else's commit. This is the **perpetrator** side, and it
is the same single-worktree root cause. Both directions are expected here, so
never treat commit membership as evidence of authorship in this repo, in either
direction.

Reduce the window if you must commit: run `git add` and `git commit` in ONE
shell invocation with nothing in between. It narrows the race; it does not close
it. Only a per-worktree lock or `git commit <pathspec>` (which bypasses the
index for the named paths) would actually close it.
