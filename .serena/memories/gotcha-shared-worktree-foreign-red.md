# Foreign red in the shared worktree: attribute by PATH, and scope your gate to owned paths

All moe-next agents share one working directory, so a completion gate aggregates every
concurrent task's state. Two distinct traps, both hit on task-5855a9c6 (2026-08-09).

## Trap 1 — a wide glob in your own gate swallows a neighbour's red

My owned daemon paths were six files under `apps/daemon/src/recovery/`. I scoped the gate as
`vitest run ... src/recovery` — the whole DIRECTORY. Another task's in-flight
`doctor-version.node.test.ts` lives in that same directory and was red:

```
expected { known: true, value: 'v24.16.0' } to deeply equal { known: true, value: 'v9.99.99' }
```

That bounced my gate for work I did not own. The reverse is worse: a wide glob can also make
your gate look green because it never ran the file that matters, or make you "own" a failure
you cannot fix.

**How to apply:** scope the verification command to the ENUMERATED owned files, not to their
parent directory. Directory adjacency is not ownership. Owned-path lists in the task
description are per-FILE for a reason.

## Trap 2 — the failing package is not the failing path

A red leg inside an OWNED package can still be foreign. `pnpm --filter @moe/daemon test` failed
on `src/runtime-entrypoint.test.ts` (a bridge-parity test) naming three `.js` files that were
`ABSENT` at my merge-base and committed by another task's whole-tree sweep. The project rail
permits completion when
`(failing paths at HEAD) minus (failing paths at merge-base)` intersected with owned paths is
EMPTY — but you must actually compute it.

Decisive commands:
- `git cat-file -e <merge-base>:<path>` — was the offending file even there before me?
- `git log --oneline -1 -- <path>` — which task's commit introduced it?
- `git status --porcelain -- <path>` — untracked/modified means in-flight, empty means committed.

Never revert or "fix" the foreign file. Report it verbatim with attribution.

## Trap 3 — your finished work may already be inside someone else's commit

`git status --porcelain` over ALL my owned paths returned EMPTY at completion: a foreign
whole-tree commit had swept every file, including production ones. Do NOT amend, reset, stash,
or mint an empty commit to claim it. Verify committed bytes equal gated bytes by reading
markers back out of `git show HEAD:<path>`, and hand QA a base-ref diff
(`git diff <merge-base>..HEAD -- <owned paths>`) instead of a commit sha.

## Trap 4 — transients are real here

One daemon run reported `2 failed | 678 passed (680)` immediately after an edit; two consecutive
re-runs gave 680/680. Another agent was mid-write. Re-run before believing a single result, and
say so if you report it.

See `mem:task-5855a9c6-handoff`.
