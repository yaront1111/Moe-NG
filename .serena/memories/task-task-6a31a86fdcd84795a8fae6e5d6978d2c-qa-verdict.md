# QA verdict: task-6a31a86fdcd84795a8fae6e5d6978d2c — APPROVED

persistFileDurably must prove the full write. Verified 2026-08-15 by qa-50f0d628 at HEAD 79d9651.

## Where the bytes live (foreign-commit hazard, NOT a defect)
No commit bears this task id for the owned paths. `de936fe` IS labelled with this
task id but carries only packages/import + packages/review — a foreign whole-tree
sweep. The actual deliverable bytes landed in:
- `4aa29d5` (labelled task-1fb6e871) — recovery-anchor-fs.ts, contracts.ts, test.ts
- `ada254c` (correctly labelled) — the stalled-port test only

`git status --porcelain -- packages/store` is EMPTY, so working tree == index == HEAD.
Reviewed by base-ref diff `git diff 192360e..HEAD -- <owned paths>`: contracts +1,
fs.ts +84/-6, test.ts +386 new.

## Gate (re-run by QA, foreground, `&&` chained, redirected not piped)
`pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` FINAL_GATE_EXIT=0.
tsc clean. 42 test files / 502 tests passed, 0 failed / 0 skipped.

## Mutation drills — all three RED, on the right assertions
Pre-drill sha256 of recovery-anchor-fs.ts recorded, restored and re-hashed IDENTICAL
after each drill (3eba453bdc026bd8244067e1bbf01fda83872d2dddef63262195f1c029684712).
Drills applied with Edit (not `node -e`), never `git checkout`.

1. **Remove the bytesWritten comparison** (guard deleted, `written = expected`) —
   8 named tests red, all on `expected the durable write to refuse, but it reported
   success`. This is DoD 4's required drill.
2. **Sync inside the completion loop** (`await handle.sync()` after `written +=`) —
   2 red: `1-bytes-via-[1] flush: expected [ 1, 1 ] to deeply equal [ 1 ]`. The
   flushed-truncation direction IS guarded, not merely commented about.
3. **Offset rewound to zero** (`handle.write(payload, 0, remaining)`) — 2 red on
   CONTENT equality (duplicated bytes), incl. the publishFileAtomically case.

## Why the sweep is not vacuous
4 payloads x 4 schedules = 16, pinned by hand-written `EXPECTED_CASES = 16`, plus
separate hand-written `EXPECTED_EMPTY_PAYLOAD_CASES = 4` and
`EXPECTED_MULTI_CHUNK_CASES = 6`. I recomputed 6 by hand from the table (7-byte and
16-byte payloads x schedules [1], [1,2,3], [3,1] = 3 + 3) — it matches. A table edit
that dropped either shape reddens even if the total stays 16.

Refusals assert the exact PAIR `{code: "RECOVERY_ANCHOR_WRITE_INCOMPLETE", layer:
"RECOVERY_ANCHOR"}` via `toEqual`, never "it threw". `refusalOf()` throws a named
error on a RESOLVED call, so a silent success cannot read as a pass.

## Sizes
recovery-anchor-fs.ts 200 lines (`grep -c ''`, was 128). Under 250.
recovery-anchor-contracts.ts 261 — over the 250 TARGET but under the 400 split
threshold, and it was already 260 before this diff; the +1 is the forced new reason
code in the frozen `RECOVERY_ANCHOR_REASON_CODES` array. Not chargeable here.

## Known live hole this task did NOT close (by design)
`packages/store/src/backup-generation.ts:45` still does `await handle.write(payload)`
with the identical discarded bytesWritten. Explicitly out of scope (owned by
task-1fb6e871). Do not read "persistFileDurably now proves the full write" as "the
store can no longer truncate a durable file".

Related: `mem:gotcha-a-lying-write-port-defeats-a-byte-count`
