# task-6a31a86f - persistFileDurably proves the full write

Audit register item 3 of 11. Landed at HEAD 4aa29d5 (production, inside a
foreign commit) + ada254c (test delta, my own pathspec commit).

## What changed

`packages/store/src/recovery-anchor-fs.ts` (128 -> 200 lines):
- `writeWholePayload()` loops `handle.write(payload, written, expected - written)`.
  Buffer offset advances to bytes already PROVEN written, so a retry completes
  the remainder instead of rewriting from zero. Position is never passed, so the
  file offset and buffer offset stay in lockstep.
- Refuses when `bytesWritten` is non-integer, `<= 0`, or `> remaining`. That
  guard IS the bound: every iteration must advance >= 1 byte, so the loop runs
  at most `payload.byteLength` times. No separate attempt counter - with those
  guards it would be an unreachable dead branch, not a real bound.
- `sync()` stays strictly AFTER the payload is fully written.
- New seam: `DurableWriteHandle` / `DurableWriteOpener`, default
  `openForTruncatingWrite = open(path, "w")`. A real `FileHandle` structurally
  satisfies the interface - no cast needed, tsc confirms. Forwarded through
  `publishFileAtomically`. NOT published on the root barrel.

`recovery-anchor-contracts.ts`: added `RECOVERY_ANCHOR_WRITE_INCOMPLETE` to
`RECOVERY_ANCHOR_REASON_CODES`.

## Two premises in the approved plan that were WRONG on disk

1. Plan said "recovery-anchor-install.ts:79 and :110 are the catch sites" and
   that callers would map the throw to a code. Both are READ-path catches
   (`readStoredAnchor` -> `RECOVERY_ANCHOR_UNREADABLE`; `readSlotManifest` ->
   null). **No caller anywhere catches a WRITE throw** -
   `installRecoveryAnchor` returns `runInstall(...)` uncaught at
   recovery-anchor.ts:136. So the code/layer had to ride on the thrown error
   itself: `class RecoveryAnchorWriteIncompleteError` with `code` + `layer`.
2. Plan implied reusing an existing refusal. I did NOT reuse
   `RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN` - `verifySlot` already returns it from
   3 branches, so a test aimed at the write path could be answered by an
   earlier guard (`mem:refusal-test-answered-by-earlier-guard`). Adding a code
   was safe: the union has exactly ONE consumer (a type re-export at
   index.ts:106), no exhaustive switch, and the vocabulary test pins only
   prefix/uniqueness/non-empty, never a count.

## Second site NOT fixed here - still open

`packages/store/src/backup-generation.ts:41-50` `persistFile` has the identical
missing check. Re-measured at HEAD 4aa29d5, i.e. AFTER its owner task
(task-1fb6e871) landed: still there. Routed as comment-6910e03e, not fixed -
it is that task's owned path. **Measured blast radius is smaller**: both call
sites read back (`:70` sha256 vs entry.digest -> DURABILITY_FAULT; `:174`
JSON.parse + verifyBackupGeneration), so there a short write degrades to a
refusal. The anchor path had no automatic read-back, which is why this one
mattered.

## Honest boundary of the fix

Counting bytes catches a SHORT write, never a LYING device. A port reporting
the full count while writing nothing still publishes empty bytes -
asserted, not hand-waved, in "still leaves read-back to the caller".
`readBackMatches` remains opt-in and was not edited.

## Gate + sizes

`pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` exit 0,
42 files / 502 tests (baseline 41/490; mine +1 file/+10 tests).
`grep -c ''`: recovery-anchor-fs.ts 200 (cap 250), test 386,
recovery-anchor-contracts.ts 261 - **already 260 at merge-base 7263d13**,
I added one line. Pre-existing over-target, disclosed not caused.

Drills: see `mem:gotcha-schedule-based-fake-port-never-stalls-permanently` -
the zero-progress drill found a real hole in my own test twice.
