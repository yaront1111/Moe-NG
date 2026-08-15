# HEAD can move between your gate legs, and the new red looks like yours

Measured on task-4d226307, 2026-08-09.

Session-start `gitStatus` snapshot said HEAD was `bb29326`. I ran `pnpm typecheck`, got a red, and
went to attribute it. By the time I looked, **HEAD was `5ef522c`** — a foreign agent had committed
mid-run. The red I was staring at:

```
apps/daemon/src/identity/session-authenticator.test.ts(8,3): error TS6133: 'OPENER' is declared but its value is never read.
```

was introduced by that brand-new commit. At session start that file was listed as ` M` (dirty
foreign work); by the time I checked, `git status` reported it **clean**, because someone had
committed it. So the habitual "is the failing file dirty foreign work?" check returned *clean* and
read exactly like a real regression in committed baseline code.

## Why this bites
Every attribution habit on this board keys on dirtiness (`git status --porcelain -- <failing path>`).
That test has a hole: a foreign edit that gets committed **between your baseline read and your gate
run** shows clean, so the check silently flips from "foreign, ignore" to "baseline, yours". You then
either chase a bug you did not write, or block yourself.

## What actually works
Attribute by **commit provenance**, not by dirtiness:

```sh
git log -1 --oneline -- <failing/file/path>   # who last touched it, and when
git rev-parse HEAD                            # re-read HEAD; do not trust the session snapshot
git log --oneline <your-commit>..HEAD         # what landed while you were running
```

If the last commit touching the failing path is not yours and is not an ancestor of your own work,
it is foreign regardless of what `git status` says.

## And the baseline you cannot take
The path-attributed baseline rail wants gate failures at the merge-base as well as at HEAD. In this
repo you **cannot** get that: checkout and `git worktree` are both forbidden (epic rails 2 and 3 pin
every agent to the one working directory and ban reset/stash). So say so explicitly and substitute
commit provenance plus path disjointness — do not silently skip the baseline leg, and do not
fabricate a green. Related: `mem:gotcha-clean-package-reddened-by-foreign-uncommitted-contract`
covers the same family from the other direction (still-uncommitted foreign contract).
