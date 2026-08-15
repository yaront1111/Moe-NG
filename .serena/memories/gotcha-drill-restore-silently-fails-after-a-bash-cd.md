# A mutation-drill restore silently fails after an earlier Bash `cd`

## What happened

Ran a focused vitest with `cd packages/runner && pnpm exec vitest ...`. The Bash
tool's cwd PERSISTS into later calls. The next call was the drill restore:

```
cp /tmp/c.bak packages/runner/src/providers/telemetry/provider-telemetry-contracts.ts
```

which resolved to `packages/runner/packages/runner/...` and failed:

```
cp: cannot create regular file '...': No such file or directory
```

**The mutated production file stayed on disk.** The same call had `&&`-chained a
`sha256sum` and the drill-B `perl -0pi` after it, so those never ran either — and
the visible output was dominated by the (correct, green) drill-A failure messages
above them. It reads like a successful drill cycle.

## Why it is dangerous specifically for QA

A drill leaves PRODUCTION code mutated. If the restore silently no-ops and the
session ends, you have committed nobody's intended bytes into a shared worktree
where a whole-tree completion hook can sweep them into some other task's commit.
And every subsequent drill in the session runs against dirty bytes, so its
"redness" is attributable to the wrong mutation.

## How to apply

1. Restore with an ABSOLUTE path, always: `cp /tmp/x.bak /d/projexts/moe-next/<path>`.
2. Never trust the exit code of a compound restore-and-verify chain. Verify with
   TWO independent signals in a separate call:
   - `sha256sum <abs path>` equals the pre-drill hash, AND
   - `git status --porcelain <owned dir>` is EMPTY.
   A hash alone can pass if you hashed the backup instead of the target.
3. Prefer never `cd` at all — `pnpm --filter <pkg> exec vitest run --root ../.. <paths>`
   runs a focused suite from the repo root with no cwd change.

Related: `mem:mutation-drill-restore-anchor-goes-ambiguous`,
`mem:git-checkout-restore-destroys-uncommitted-work`,
`mem:mutation-drills-in-shared-worktree`.
