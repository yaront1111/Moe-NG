# Gotcha: mutation-testing an untracked file can destroy it

The epic rail requires proving a failure-path test is load-bearing by mutating the production
surface and confirming the suite goes red. The mutation is easy; the RESTORE is where it bites.

## What went wrong (2026-08-08, task-a5def097, budget-account.ts)

Harness mutated with `text.replace(original, mutant)` and restored with
`text.replace(mutant, original)`. Two independent failures compounded:

1. **`String.replace` with a string needle replaces only the FIRST occurrence.** The mutant was
   the bare token `false`, which already appeared earlier in the file (`readonly ok: false` in the
   result union). The restore rewrote that first `false` into the mutation expression and left the
   real guard as `if (false)` — silently disabling a production check while the file still looked
   plausible.
2. **The file was UNTRACKED** (new module, not yet committed), so `git checkout -- <path>` and
   `git stash` had nothing to restore from. No safety net at all.

Detected only because the harness compared `git hash-object` before/after and printed
`RESTORE MISMATCH`. Without that check it would have been committed with a dead guard.

## Rules

1. **Snapshot out-of-tree first.** `cp "$P" "$TEMP/name.orig.$$"` and restore with `cp` back — not
   by re-replacing text. Outside the repo, so it can never be swept into a commit
   (`mem:gotcha-shared-index-commit-capture`). Delete it at the end.
2. **Verify every restore**: `[ "$(git hash-object "$P")" = "$H" ]`. Print a loud failure. Do this
   even when the mutation "obviously" reverses.
3. **Never use a common token as the mutant or the needle.** Prefer a long unique anchor, and use
   `split(a).join(b)` when you do mean every occurrence.
4. **If the file is untracked, treat the backup as mandatory**, not a nicety.
5. If a restore does fail: grep for the mutation artefacts (both the needle and the mutant) rather
   than assuming what changed, repair by hand, then re-run typecheck AND the suite.

## Worth keeping

The mutations themselves paid off — the highest-value one proved that returning a rebuilt
`{...state}` instead of the same reference on rejection reddens 8+ tests, which is exactly the
guarantee deep-equality assertions would have missed. See
`mem:task-task-a5def097bcb7495e935204bd845160b4-handoff`.
