# Task task-8f84c56d88504f80aa2fefdf69f093bd - QA verdict

Status: APPROVED -> DONE by qa-ce3ba361 at 2026-08-16 (HEAD 376523cdee462cc2f4cc5af5253c5047e4076177).

## What shipped
`deriveActivationAggregateId` in `apps/daemon/src/activation/activation-ledger-contracts.ts`
keeps the exact legacy `moe-activation-ledger/1|aggregate|<len>:<agg>|<len>:<key>` string whenever
`Buffer.byteLength(legacy,"utf8") <= 512`, and only otherwise returns
`moe-activation-ledger/1|aggregate|sha256:<64 lowercase hex>` over the COMPLETE framed legacy preimage.
Production file 241 lines. New focused suite `activation-ledger-aggregate-id.test.ts` (243 lines, 4 tests).

## Independent QA evidence (not inherited from the worker)
- Base-ref diff `f4966b53..HEAD -- <2 owned paths>`: 2 files, +254/-14, nothing else. Committed bytes
  == gated bytes: contracts bd568cf71cf6ce6f04e718e909171dfe410e81e118304e85c4d73156234727a8,
  test 61ee9dbc53f2f2510b41045f54378fece65e853ccffbc3442c57d4347323b150.
- Recomputed byte math in a separate Node process: fixture legacy 69 B, boundary (`a`*200/`b`*269) 512 B,
  `b`*270 -> 513 B, overflow ID 105 B.
- Recomputed ALL FOUR pinned SHA-256 vectors over the full versioned+length-framed preimage; every one
  matched the literal in the test (bdd4da67, c2c6dfea, 2f8707d2, f5d4c1cb). This is the check that
  proves the pinned vectors are not echoes of whatever production happens to do.
- Re-ran BOTH mutation drills myself (out-of-repo mktemp backup + EXIT trap + count==1 python guard):
  * D1 replaced the 512-byte guard with an unconditional `return legacy;` -> named real-store test red
    with exact `ACTIVATION_LEDGER_FIELD_INVALID` / layer `ACTIVATION_LEDGER` / storeCode `STORE_INPUT_INVALID`.
  * D2 replaced `.update(legacy,...)` with `.update(aggregateId + idempotencyKey,...)` -> framing test red,
    expected 2f8707d2..., received 1ff936e7....
  Source restored to bd568cf7 byte-exact after each.
- Scoped tsc exit 0 WITH a positive control: `--listFiles | grep -c moe-next` = 530 and both owned roots
  present, so the exit 0 is not an empty program.
- Owned suites `vitest run --root . --config package.json src/activation/activation-ledger`: exit 0,
  Test Files 4 passed (4), Tests 40 passed (40).
- `pnpm --filter @moe/daemon typecheck` now exits 0 - the foreign review TS2741 that forced the governor
  rescope has since been fixed by its owner.

## Foreign red at approval (disclosed, not attributed to this task)
`pnpm --filter @moe/daemon test`: 97 files / 1993 tests, 10 failures in 4 files, all foreign:
`orchestrator/agent-spawner.test.ts`, `telemetry/provider-run-codec.test.ts`,
`activation/foundation-launch-authority.test.ts`, `work/foundation-attempt-windows.test.ts`.
(An earlier run of the same command additionally flaked `goals/goal-services`, `goals/j1-command-path`,
`bootstrap/bootstrap-durability`, `review/review-refusal-vocabulary` - all foreign, all green on rerun.)

Attribution method worth reusing: two of those failing files DO import `deriveActivationAggregateId`
(`foundation-launch-authority.test.ts:55` and `foundation-attempt-windows.test.ts:109`), which looks
damning at first glance. Both call it with SHORT inputs (`effect-aggregate-1`/`idem-key-1`, `agg-1`/`idem-1`)
whose legacy form is 69 B and below, so they take the preserved branch and their derived ids are
byte-identical pre/post. That is a cheaper and stronger acquittal than re-running a baseline.
Failing-path set INTERSECT owned paths = EMPTY.
