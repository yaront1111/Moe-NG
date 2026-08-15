# Convention: in a shared working directory, commit by pathspec and DO NOT unstage foreign paths

Learned on `task-4a3b5ec0` (2026-08-08). Epic rail 3 pins every agent in `moe-next` to one
working directory, so `.git/index` is SHARED MUTABLE STATE between concurrently running
agents.

## What actually happened

After staging only my own 16 files, `git status --porcelain` showed two paths I never
touched:

```
A  apps/daemon/src/bootstrap/bootstrap-contracts.ts
A  apps/daemon/src/bootstrap/bootstrap-services.test.ts
```

Another worker had staged them in the seconds between my `git add` and my `git status`.

## The rail says "unstage it". Usually don't.

The rail's wording — `git restore --staged -- <path>` — assumes you are about to run a bare
`git commit`, which would sweep the whole index. But:

**`git commit -F msg -- <path> [<path>...]` is a PARTIAL commit.** It commits the
working-tree content of exactly those paths and leaves every other index entry alone. The
foreign staged files are neither committed nor disturbed.

So with an explicit pathspec, `git restore --staged` on a foreign path is not protective —
it silently destroys a live agent's staging for zero benefit, and they will not find out
until their own commit comes up short. Prefer leaving it.

Unstage only when you genuinely must run a bare commit, which you should not need to.

## The mechanics that bite

1. **`-m` / `-F` must come BEFORE `--`.** `git commit -- <paths> -m "msg"` makes git read
   `-m` and the message itself as pathspecs:
   `error: pathspec '-m' did not match any file(s) known to git`. No commit is made, which
   is at least loud.
2. Write a multi-line commit message to a file OUTSIDE the repo and use `-F`, then delete
   it. A heredoc inside `$(...)` works but is fragile with backticks and `$`.
3. **Always verify after, never before:** `git show --stat` on the new HEAD, and confirm the
   file list is exactly your owned paths with no scratch, probe, or generated evidence file.
   `git status --porcelain` before the commit tells you about the index; only `git show`
   tells you what landed.
4. Keep mutation-drill backups OUT of the tree (e.g. a sibling directory) so they can never
   be swept in, and delete them when done.

## Verifying the POSITIVE is not verification (2026-08-09)

`git rev-parse HEAD:<path>` vs `git hash-object <path>` proves the bytes you meant
to commit are the bytes you gated. It **cannot** detect anything in the commit that
should not be there, because it only asks about paths you thought to name — a
duplicate at an old path, a file swept in by a foreign hook, a forgotten probe.

Add the negative check. It costs one command:

```sh
git ls-tree -r HEAD --name-only | grep '<old-or-unexpected-path>'   # must return nothing
```

## A partial commit CANNOT name an untracked file (2026-08-10, task-2411ed9c)

```sh
git commit -F msg -- packages/x/src/index.ts packages/x/src/new-file.test.ts
# error: pathspec 'packages/x/src/new-file.test.ts' did not match any file(s) known to git
```

**Nothing is committed** — not even the tracked path in the same argument list. `git commit -- <paths>`
resolves its pathspec against the INDEX/HEAD, and a never-added file is in neither.

Fix: `git add -- <new path>` first, then commit both by pathspec as usual.

It fails loudly, which is good, but the aftermath reads wrong: `git log -1` then shows whatever
FOREIGN commit landed most recently, with its whole-tree file list. For a few seconds that looks
exactly like "my commit succeeded and swept foreign files". Re-read the error before reacting to the
log. Same family as the rename traps below: the arg list is rejected as a unit.

## Renames: `git add <new>` does NOT infer the deletion

Measured in a scratch repo by worker-5981deec, after `git add <old> <new>` silently
landed a broken commit on `task-fdf3e6aa`:

```sh
mv a/f.txt b/f.txt        # plain mv, NOT git mv
git add b/f.txt
git status --porcelain
 D a/f.txt                # deletion UNSTAGED
A  b/f.txt                # commit here => file exists at BOTH paths
```

Rename detection is a DIFF-time heuristic, not a staging behaviour.

- After `git mv`: `git add <new>` — the deletion is already staged.
- After a plain `mv`: stage both ends — `git add -A <dir>`, or
  `git rm --cached <old>` alongside `git add <new>`.

**Two ways this bites, both of which pass a green suite:**
1. `git add <old> <new>` after `git mv` — the old path no longer exists, so `git add`
   exits 128 (`fatal: pathspec ... did not match any files`) and adds NOTHING from
   that argument list, including the valid path in it.
   **The rename still lands, because `git mv` staged it immediately.** Measured:
   `git diff --cached --name-status` shows `R100 old new` even after the failed
   `git add`. So what is silently discarded is only the content edit made AFTER the
   `git mv` — for us, repointing the imports.
   That is worse than "nothing was staged", which would have produced an obviously
   empty commit. Instead you get a plausible 100%-similarity rename with 0
   insertions and broken imports. Vitest reads the WORKING TREE, so the suite is
   green throughout.
2. Plain `mv` + `git add <new>` — the file lands at both paths. Worse: on an
   ownership relocation that re-earns the violation you were relocating to fix, with
   two copies running and a reviewer checking the new path seeing correct bytes.

Verify with BOTH `git show HEAD:<new> | grep` and the `ls-tree` negative check above.

Related: `mem:task-task-4a3b5ec031f14079bce4141abf922905-handoff`,
`mem:gotcha-git-add-old-path-after-git-mv-lands-an-empty-rename`,
`mem:pattern-guard-the-case-list-not-just-the-cases` (same shape: a check that
enumerates only what you expected cannot find what you did not).
