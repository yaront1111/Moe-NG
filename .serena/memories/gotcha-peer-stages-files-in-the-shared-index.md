# A peer can leave THEIR files staged in the shared index — a bare `git commit` swaps yours for theirs

Hit on task-1eeb2dcc (worker), shared worktree D:/projexts/moe-next.

## The shape

I staged my three owned files, then checked before committing:

```
$ git diff --cached --name-only
apps/control-room/src/live/live-dispatch.ts
apps/control-room/src/live/live-effort-edge.ts
apps/control-room/src/live/live-effort-path.test.tsx
apps/daemon/src/activation/activation-embargo.js        <-- not mine
apps/daemon/src/activation/activation-ingress.ts        <-- not mine
apps/daemon/src/daemon-command-registry.ts              <-- not mine
... 10 foreign entries total
```

A peer had run `git add` on their own in-flight work and had not committed yet. The INDEX is shared
state in this repo, exactly like the working tree. `git commit -m ...` with no pathspec would have
swept ten of their files into my commit — a whole-tree commit under a different name, and precisely
what epic rail 3 forbids.

## The fix that actually works

`git add <my paths>` then **`git commit -m msg -- <my paths>`**. With a pathspec, commit builds the
commit from the WORKING TREE for those paths only and leaves every other index entry alone; the
peer's staged files stay staged and uncommitted for them. Verified with `git log -1 --stat`:
exactly 3 files.

Note the interaction with `mem:git-commit-pathspec-cannot-name-an-untracked-file`: the pathspec form
commits NOTHING if a named path is untracked at HEAD. Both constraints are satisfied by
`git add` FIRST (making the new files known to the index), THEN `git commit -- <paths>`.

## Rule

`git diff --cached --name-only` before every commit in a shared worktree, not just
`git status --porcelain`. Staged foreign work is invisible in the mental model "I only touched my
files" — you did only touch yours, and someone else queued theirs into the same index.

Related: `mem:mutation-drills-in-shared-worktree`, `mem:git-stash-u-deletes-a-peers-untracked-work`,
`mem:moe-epic-rails-override-qa-loc-bar`, `mem:foreign-commit-can-revert-your-landed-deliverable`.
