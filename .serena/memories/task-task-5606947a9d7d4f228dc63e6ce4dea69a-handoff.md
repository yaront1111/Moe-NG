# task-5606947a — Cursor-bound complete backup generation — DONE (worker handoff)

Epic M5 `epic-bf111658`. Commit `c5c46bb`, 12 files, 1489 insertions.
Merge-base `174c07ba`. Gate: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test`
→ exit 0, 32 files / 357 tests.

## Public surface

`createBackupGeneration(request)` (async) and `verifyBackupGeneration(container, trust, options?)`
(sync), both on the `@moe/store` root. Five production modules under
`packages/store/src/backup-generation*`, each with a one-line `.js` bridge.

## The empirical fact the whole design rests on — verify it before changing capture

`node:sqlite`'s `backup` honours a seated read snapshot. Measured directly:
open a dedicated `new DatabaseSync(path, { readOnly: true })`, `PRAGMA
query_only=ON`, `BEGIN DEFERRED`, then **read the tail** — a deferred
transaction acquires nothing until its first read, so the read is what pins the
snapshot. With tail seated at 3, a concurrent commit moved the live database to
4 and `backup` still produced an image at 3.

**API shape people get wrong:** `backup` is a STANDALONE export —
`const { DatabaseSync, backup } = require("node:sqlite")`.
`DatabaseSync.prototype.backup` is `undefined`.

## Two real defects found while building, both worth generalising

1. **WAL sidecars were being published into the signed generation.** Opening the
   staged image read-only — even just to run `quick_check` — leaves `-wal` and
   `-shm` beside it, and those were surviving the rename into the final
   directory. `databaseDigest` covers `database.sqlite` ALONE, so those were
   undeclared bytes inside a signed artifact that could change what restores
   without breaking any digest or signature. Fixed by removing sidecars after
   validation and **before** hashing.
   Test-ordering trap that came with it: the assertion must run BEFORE the test
   opens the captured database, or the test creates the very `-wal` it checks
   for and the assertion measures its own side effect.

2. **A mutation drill survived: the inventory cardinality check.**
   `observed.length !== declared.size` was redundant with the membership loop
   under it *for the case that existed* — an EXTRA path is caught either way.
   The cardinality comparison exists for the opposite direction, a MISSING
   declared object, and nothing exercised it. Added
   `observedLogicalPaths: declared.slice(1)`; the mutant then reddened.
   See `mem:gotcha-redundant-operand-mutants-survive-inside-one-guard` — same
   family, and the lesson is that a redundant-looking guard usually covers a
   direction your tests forgot.

## Sharpest edge for the consumer tasks

`verifyBackupGeneration`'s `observedLogicalPaths` is **optional**, and omitting
it means *"inventory not observed"*, not *"inventory verified"*. The type system
does not force it. The coordinator always supplies it (self-check and
post-rename check), but a consumer could verify a container without ever
comparing it to disk and read `ok:true` as stronger than it is. Deliberate — the
alternative is a filesystem dependency in a pure module — but tell the next
caller.

Also: `restorable: true` means internally consistent, bytes re-verified,
signature valid against an externally anchored key. It does **not** mean anyone
performed a restore.

## Design points that are load-bearing, not stylistic

- Trust is **externally anchored**. Signature verification uses the ANCHORED key
  bytes, never the key carried in the container, so a swapped-in key cannot
  self-authorize. The public key is derived from the private key with
  `createPublicKey`, never accepted from the caller.
- Signature sits structurally OUTSIDE the manifest; canonical bytes exclude only
  `generationDigest`, the field they produce.
- Cursor and every byte length are canonical decimal STRINGS.
  `domain_events.global_position` is a bigint column (`CHECK (global_position >
  0)`, so cursor 0 = empty generation) and SQL reads it as `CAST(... AS TEXT)`.
- Verify order fails closed at each stage: shape → closure → recomputed digest →
  observed inventory → key anchoring → signature.
- Two verifications, not one: the in-memory container before publishing, and the
  bytes re-read from disk after the rename.

## Clause 1 — NOT composed

This lands the capability only. Nothing imports `createBackupGeneration` outside
its own test. Consumers recorded by architect-f39f0c46 in `comment-4d5d3610`:
`task-b6e3dd2af916490fb2bc4d375a530683` (two-slot installer) and
`task-6f786c58cabf4f85be8ed4135e68a752` (R3 completion).

## Plan deviations, both disclosed in step notes

- The plan named ONE manifest module and SIX owned paths; shipped five
  production modules (all ≤223 lines) plus bridges plus one test file. Same
  work, split to satisfy the per-file cap the plan's own step 6 mandates.
- `verifyBackupGeneration` gained the caller-supplied inventory port so it stays
  pure. See above.

## Probing the store root under plain Node

`packages/store/src/index.js` does **not** exist and should not — the package
`exports` map is `{".": "./src/index.ts"}`. A path-based probe fails
`ERR_MODULE_NOT_FOUND` for the wrong reason. Use the bare specifier from an
in-repo referrer:
`cd packages/store && node --experimental-strip-types --input-type=module -e "await import('@moe/store')"`.
See `mem:gotcha-bare-specifier-probe-needs-an-in-repo-referrer`.

## Related

`mem:mutation-drills-in-shared-worktree` (the `git hash-object --no-filters`
capture/restore form used for the drills here),
`mem:gotcha-missing-runtime-bridge-invisible-to-vitest`.
