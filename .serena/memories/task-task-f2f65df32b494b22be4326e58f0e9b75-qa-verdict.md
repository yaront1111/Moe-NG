# QA verdict: recovery anchor post-switch resume — APPROVED

Task: `settledInstall` recognised only `state === "INSTALLED"`, so a crash
between the SWITCH publish and the INSTALLED marker re-entered `runInstall` and
wrote the database into the now-LIVE slot. Fix: recognise
`state === "PREPARED" && currentSlot === targetSlot` and complete with a
marker-only write (`markInstalled`, new `recovery-anchor-marker.ts`).

## What I re-derived instead of trusting

The whole fix rests on one claim — that the pair is unreachable pre-switch. The
handoff asserted it; I re-traced it from the source, and it holds:

- `RECOVERY_BINDING_SLOTS` frozen `["ACTIVE","PENDING"]` (2 members).
- `selectInactiveSlot` (recovery-anchor.ts:51) returns the OTHER member, never
  its argument.
- `buildAnchorRecord` has **exactly one** production caller (recovery-anchor.ts:90),
  passing `target: selectInactiveSlot(current)` → current != target at PREPARE.
- `resealAnchorRecord` has **two** production sites: install.ts:257 (the switch,
  the only writer of `currentSlot := targetSlot`) and marker.ts:33 (state only).

`grep -rn currentSlot ... | grep -v .test.ts` is the cheap version of this: it
separates the one WRITER from the many readers in a single command.

## The identity hoist was the subtle part

The `preparedIdentity` check was moved ABOVE the state split. Adding a second
arm underneath the old ordering would have left that arm unguarded — an intruder
command would be handed a completed install. Drilling it (scope the guard back
to the INSTALLED arm with `&& stored.state === "INSTALLED"`) reddens the
intruder-fence test with `expected true to be false`. **When a diff hoists a
guard, drill the hoist — it usually is not tidying.**

## Drills I ran (all three reproduced the worker's claims exactly)

| Mutation at recovery-anchor.ts | Result |
|---|---|
| line 123 → `return null` (arm dead) | RED 1 — "records the marker without crossing a single install boundary again", message names `INACTIVE_INSTALL` |
| line 123 → `if (false) return null` (over-broad) | RED 7 — incl. "still runs a full install when the crash landed BEFORE the switch" |
| line 115 → `&& stored.state === "INSTALLED"` (identity scoped back) | RED 1 — intruder-fence test |

Drill mechanics that worked, worth reusing:
- `npx vitest run --root . --config package.json src/recovery-anchor.test.ts`
  from the repo root — 55 tests, ~30s, vs the full store suite.
- Backup to `/d/tmp/qa-drill/` **outside** the repo; restore by `cp`, never
  `git checkout`. Assert `git hash-object <file>` equals the recorded sha after
  every restore, and end with `grep -c DRILL_ = 0` plus
  `git status --porcelain -- packages/store/` empty.
- `sed -n '<line>p'` after each `sed -i` prints the replaced line, so a drill
  that applied nothing cannot read as green.
- Careful: `grep -c` returning 0 exits 1 and silently truncates an `&&` chain.

## Gate

`pnpm --filter @moe/store typecheck` exit 0; `... test` exit 0, 42 files / 502
tests. Worker reported 41/490 — the delta is peer growth, not a narrowed run.
Confirm direction before treating a count mismatch as a defect.

## Provenance

Owned files were swept into foreign whole-tree commit `7263d13`
(task-cbc42f33). Not a rejection (project rail 5). Verified by
`git hash-object <disk>` == `git rev-parse HEAD:<path>` for all five paths, and
reviewed via `git diff 192360e..HEAD -- <owned paths>`.

Sizes (`grep -c ''`): recovery-anchor.ts 210, marker.ts 36, install.ts 262 —
already 263 before the task, so it SHRANK. Over the 250 target but pre-existing
and under the 400 split line; not a rejection reason.

Related: `mem:task-task-f2f65df32b494b22be4326e58f0e9b75-handoff`,
`mem:moe-epic-rails-override-qa-loc-bar`,
`mem:git-checkout-restore-destroys-uncommitted-work`.
