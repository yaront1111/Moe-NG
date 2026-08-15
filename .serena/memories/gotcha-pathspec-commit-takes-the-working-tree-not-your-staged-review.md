# `git commit -- <pathspec>` commits the WORKING TREE at commit time, not the index you reviewed

Hit 2026-08-09 committing `task-b5e9bd64` (6 owned paths) in the shared worktree.

```
git add -- package.json tests/fault/... tests/security/...
git diff --cached --stat        ->  package.json | 2 +      <-- what I reviewed
git commit -F - -- <same 6 paths>
git show --stat <sha>           ->  package.json | 3 +      <-- what landed
```

The extra line was `"@cyclonedx/cdxgen": "12.8.2"`, written into root
`devDependencies` by a concurrent agent in the ~30s between the two commands.

## Why the usual safety check misses it

A pathspec commit is the repo's prescribed safe form, and `git add` +
`git diff --cached --stat` is the review everyone runs to justify it. But the
pathspec commit does NOT commit the index — it rebuilds the tree from the
working tree for the named paths. So the stat you approved is a snapshot of a
moment that is already gone by the time the commit runs.

Pathspec still protects you from every path you did NOT name (95 dirty paths in
this tree at the time; none of them landed). It gives you **zero** protection
against a concurrent write to a path you legitimately own — and shared root
files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`) are exactly
the paths multiple agents own at once.

## How to apply

- Verify with `git show --stat <sha>` AFTER the commit. `--cached --stat` before
  it is advisory only. Read the insertion COUNT, not just the file list — the
  file list is identical in both cases.
- On a shared root file, expect to hit this. Diff the committed hunk
  (`git show <sha> -- package.json`) and confirm every line is yours.
- Over-capture cascades: a devDependency committed without its `pnpm-lock.yaml`
  entries leaves HEAD failing `pnpm install --frozen-lockfile` while every local
  run stays green, because the working-tree lockfile is correct. Check
  `git show HEAD:pnpm-lock.yaml | grep -c <pkg>` against
  `git show HEAD:package.json | grep -c <pkg>`.

## Do not repair by amending into a live edit

The instinct is to amend the commit to drop the foreign line. Check first whether
the owner is still writing that file — here they added four more script lines
between two of my reads. Overwriting an agent's in-flight file is worse than the
inconsistency. Correct move: restore their bytes exactly (`diff` against a
pre-edit snapshot), unstage, leave HEAD alone, and tell the owner to commit the
lockfile with their task, which closes it.

Also: `git reset -- <one path>` is safe with foreign staged content in the shared
index — it unstages only that path. 9 foreign `recovery-inventory` paths staged by
another agent were untouched.

Related: `mem:gotcha-commit-own-lines-from-a-file-carrying-foreign-wip`,
`mem:gotcha-shared-git-index-amend-captures-foreign-work`,
`mem:gotcha-shared-pnpm-lock-ownership`,
`mem:pattern-prove-your-bytes-landed-three-checks`.
