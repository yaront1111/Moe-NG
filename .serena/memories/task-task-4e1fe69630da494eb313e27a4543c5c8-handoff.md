# task-4e1fe69630da494eb313e27a4543c5c8 worker handoff (2026-08-15)

Legacy quiesce drill. **DONE as a HARNESS ONLY.** Commit `47739ed`, 9 files,
1205 insertions, branch `moe/work-2026-08-08`.

## The gate is STILL OPEN — do not read this as a cutover
`GO_QUIESCE` was **never given**. No real daemon, IDE, launcher, watcher,
scheduled start, process or handle was stopped, denied, signalled or killed.
Every access path is a simulated fixture-table entry; every byte is under
`mkdtempSync(join(tmpdir(),"moe-cutover-"))`. The narrowing was an **explicit
human instruction** this session ("plan as much as u can prod way and try not to
block"), not an architect's call. Scope disclosure is on the task as
`comment-fb6b2b27`. `task-09008b4c` (GA activation) still needs a LIVE run; a
green `pnpm test:migration` is NOT that.

Unmet hard deps at handoff: `task-22cfca91` (portability shadow gate, not DONE,
different epic) and `task-0c89476b` (disaster restore proof, BLOCKED). Re-measure.

## What landed
- **`pnpm test:migration` NOW EXISTS** — it did not before, yet it was this
  task's own stated verification command. Also `tests/migration/tsconfig.json`,
  so that whole tree (including the pre-existing importer determinism test) is
  typechecked for the first time. See `mem:migration-lane-was-typechecked-by-nothing`.
- `tests/migration/cutover/`: `cutover-fixture.ts` (211), `cutover-manifest.ts`
  (204), `cutover-compare.ts` (102), `cutover-inventory.ts` (186),
  `cutover-drill.test.ts` (339), `cutover-refusals.test.ts` (77).

## Two disclosed deviations from the plan
1. **Fifth+sixth files.** The manifest hit 286 lines once the walk seam landed,
   so the judging half was split into `cutover-compare.ts`; both still refuse
   under ONE layer and ONE code set via the exported `refuseManifest`. A sixth
   file `cutover-refusals.test.ts` came out of the adversarial review.
2. **`captureCutoverManifest(root, {maxDepth,maxEntries,ports})`** — defaults are
   the production constants and real `node:fs`. It exists because
   UNREADABLE_ENTRY / UNSUPPORTED_ENTRY cannot be provoked portably on Windows
   from pure Node without `exec`, which the scope fence forbids. The *branches*
   under test are production; the shipped constants are pinned by assertion.

## Six mutation drills, all reverted from own byte copies (never `git checkout`)
A always-match comparison -> POSITIVE CONTROL red (1/14).
B empty inventory -> "expected 0 to be greater than 0" (4/14).
C self-consistent restore-to-OPEN -> exact-state deep-equal red naming
  `legacy-archive-mount: DENIED vs OPEN` (1/14). Self-consistent was required:
  a write-only mutant trips the module's own RESTORE_NOT_APPLIED guard first.
D wait shortened to 200ms -> "expected 213.9712 to be >= 10000" (1/14).
E deny silently skips `legacy-daemon` -> denied-set red naming it (2/14).
F deny post-condition deleted -> "expected a refusal, received ok:true" (1/4).

## Gates
`pnpm test:migration` EXIT 0 — 3 files / 25 tests, ~11s (the 10s wait is the
drill working). `pnpm test` EXIT 0 — 271 files / 6413 passed. Baseline at
merge-base was 269 / 6395, so the delta is +2 files +18 cases, all mine. No
foreign red at either end. No `moe-cutover-*` tree left under the OS temp dir.

## Gotchas worth the next reader's time
- All 15 declared reason codes are asserted BY NAME. The four internal invariant
  guards needed `createDefectiveAccessTable("duplicate"|"missing-state"|
  "inert-writes")` to be reachable at all — see
  `mem:gotcha-internal-invariant-guards-need-a-defective-fixture`.
- Expected `pathId` for the deny/restore readback refusals is
  **`legacy-cli-process`, not `legacy-daemon`** — the readback walks ids in UTF-8
  order and `legacy-archive-mount` was already DENIED.
- `legacy-archive-mount` starts DENIED on purpose. A uniform initial state would
  make "restore everything to OPEN" indistinguishable from an exact restore.
- Manifest carries content identity only; **mtime is deliberately not in it**.
