# `git checkout -- <path>` is a SAFE drill restore only if your work is committed

Hit on `task-c956fd56` (2026-08-13), step 7, mutating the RESERVED-state guard in
`packages/scheduler/src/authority/lease-resource.ts`.

`mem:gotcha-a-restore-anchor-can-go-ambiguous-after-the-mutation` says to restore a
mutation drill with `git checkout` rather than a reverse `sed`, because the reverse anchor
can go ambiguous and silently leave the mutant on disk. That advice is correct about
anchors and **wrong by default about state**: `git checkout -- <path>` restores the file to
**HEAD**, not to its pre-drill working-tree bytes. When the task's own implementation is
still uncommitted, that one command silently deletes the whole feature.

Observed exactly: pre-drill sha256 `c2aac872…`, post-restore sha256 `7df993e2…`, anchor
count 0, file back to 193 lines, and `git status` reporting the path CLEAN — which reads
like a perfect restore. Nothing errors. The only tell is the hash.

## Decision rule

- Work already committed -> `git checkout -- <path>` is right (restores exactly HEAD+work).
- Work uncommitted (the normal case mid-task) -> copy the file OUT of the repo first and
  restore by copy:

```bash
BAK="$TEMP/<file>.pre-drill"          # OS temp dir, never inside the repo
cp <path> "$BAK"; sha256sum "$BAK"
sed -i 's/<anchor>/<mutant>/' <path>  # verify anchor count == 1 BEFORE mutating
# ...run the focused test, read WHICH test reddened...
cp "$BAK" <path>; sha256sum <path>    # MUST equal the pre-drill hash
rm -f "$BAK"
```

Hash-check every drill in both directions. The pre-drill hash is the only thing that can
distinguish "restored" from "reverted to something else that also compiles".

## Recovery when it already happened

The `git diff` printed at the start of an adversarial-review step is a complete record of
the file's changes — reapply its hunks and confirm the sha256 matches the pre-drill value.
Do not re-derive the implementation from memory; the hash is the proof.

Related: `mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`,
`mem:gotcha-untracked-crate-defeats-git-diff-drill-restore`, `mem:mutation-drills-in-shared-worktree`.
