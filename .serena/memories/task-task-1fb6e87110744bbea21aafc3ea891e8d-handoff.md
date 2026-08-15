# Crash-safe backup generation publish (audit register item 1 of 11)

Landed 2026-08-15. Commit `a462cf4` (own, explicit pathspec) + foreign sweep `6482e5f`.
Gate `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` EXIT=0, 493 tests.

## What changed

`backup-generation.ts:172-173` was `rm(finalPath)` immediately followed by
`rename(stagingRoot, finalPath)`. Between those two awaits the old generation was
already destroyed and the new one not yet published — a crash there left NOTHING.

New module `packages/store/src/backup-generation-publish.ts` (120 lines, plus the
mandatory `.js` bridge — see `mem:new-ts-module-needs-a-js-bridge-invisible-to-tsc-and-vitest`):

- `publishStagedGeneration(stagingRoot, finalPath)` — rename final → `${final}.previous`,
  rename staging → final, then `rm` the aside. Failed staging rename renames the aside BACK.
- `resolveInterruptedPublish(finalPath)` — runs at publish ENTRY, before staging.
- `generationIsComplete(path)` — the fact both decide from.

`backup-generation.ts` grew 5 lines (213 total). The fsync-reopen and the final
`verifyBackupGeneration` re-read are untouched. Digest contract untouched and pinned.

## The three non-obvious design facts

1. **Rename-aside is FORCED on Windows, not chosen.** `rename` onto an EXISTING
   directory fails, which is exactly why the original code deleted first. There is no
   atomic replace-directory primitive to reach for.
2. **Recovery is not housekeeping — it is load-bearing.** A leftover aside blocks
   EVERY later publish for the same reason as (1). Without `resolveInterruptedPublish`
   the aside design wedges the destination permanently.
3. **`generationIsComplete` anchors the carried key to ITSELF, on purpose.** It answers
   "are these bytes an internally consistent, fully populated generation", never "is this
   trusted" — the previous generation's trusted key is unknowable during recovery. It runs
   the production `verifyBackupGeneration` (no reimplementation) and then requires
   `database.sqlite` plus every declared object file to EXIST, because a manifest alone is
   precisely the half-published directory the DoD forbids.

## Honest limit, stated in chat and in complete_task

Rename-aside is NOT atomic: `finalPath` itself is briefly absent between the two renames.
A COMPLETE generation always exists under one of two known names. Continuously-present
`finalPath` is the pointer-indirection design the architect REJECTED in planningNotes
(it changes the published-path contract that `generationPath: finalPath` returns) and
routed as a separate task. Do not smuggle it in here.

## Not fixed, disclosed

- Two concurrent publishes to one destination share `${dest}.staging` — pre-existing race,
  unchanged; needs a destination lock. Walked every interleaving: none destroys data, worst
  case one publisher refuses while the other's complete generation sits at `finalPath`.
- A caller whose `destinationPath` equals another's `${path}.previous` collides. `.staging`
  already had that exact shape.

## Evidence shape QA asked for

Base-ref diff, not a commit: `git diff e6597e4..HEAD -- packages/store/src/backup-generation.ts
packages/store/src/backup-generation-publish.ts packages/store/src/backup-generation-publish.js
packages/store/src/backup-generation.test.ts`. See `mem:gotcha-foreign-sweep-lands-a-partial-revision`.

5 mutation drills, each red on the intended assertion, each restored with sha256 == base
`57cc6c9bbf0b01f3bfd35f6fc9e3a4388b1c1d3113f6d4bfd0ee53996284da57`.

Related: `mem:gotcha-interrupt-the-production-publish-with-a-scoped-fs-mock`,
`mem:gotcha-digest-pin-needs-a-fixture-not-a-captured-image`.
