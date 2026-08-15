# Worker handoff — bounded activation-ledger aggregate identifiers

Task `task-8f84c56d88504f80aa2fefdf69f093bd` is implementation-complete through step 4 and BLOCKED at step 5 only by live foreign daemon orchestrator WIP.

## Landed owned bytes

- `apps/daemon/src/activation/activation-ledger-contracts.ts`
  - Builds the exact legacy namespace/code-unit-length-framed identifier once.
  - Returns it byte-for-byte when `Buffer.byteLength(legacy, "utf8") <= 512`.
  - Only overflow returns `moe-activation-ledger/1|aggregate|sha256:<lowercase hex>`, hashing the complete versioned framed legacy preimage.
  - 241 physical lines; SHA-256 `bd568cf71cf6ce6f04e718e909171dfe410e81e118304e85c4d73156234727a8`.
- `apps/daemon/src/activation/activation-ledger-aggregate-id.test.ts`
  - Exactly four tests: 69/512-byte legacy pins, two exact public-parser maximum vectors, swapped-length bare-concatenation adversary, and two real file-backed SQLite commits/reopen reads.
  - Every generated sweep pins exact nonzero cardinality; mutation refusal output exposes exact code/layer/storeCode.
  - SHA-256 `61ee9dbc53f2f2510b41045f54378fece65e853ccffbc3442c57d4347323b150`.
- Fresh focused gate after restoration: 1 file, 4/4 tests passed.

## Mutation evidence

Pre/post source hash was byte-identical `bd568cf7...`.
1. Overflow->legacy mutation: named real-store test executed 1 (3 skipped) and reddened for both cases with `ACTIVATION_LEDGER_FIELD_INVALID` / `ACTIVATION_LEDGER` / `STORE_INPUT_INVALID`.
2. Digest-input->bare-concatenation mutation: named framing test executed 1 (3 skipped), expected `2f8707...` and received the shared bare digest `1ff936...`.
No backup/probe/transcript/tmp residue remained.

## Shared-tree/commit hazard

Foreign whole-tree completion commit `6ca5da07da2c28f56867ab0ddf39c6448785cbdf` for task `task-d92b1b15a5b048e49671ed34990fa4a1` swept both owned files byte-exact. Do not amend/reset/recommit or create an empty claim commit. QA review surface:
```
git diff f4966b534ee5e9f9671668795d5dd1e844f0521b..HEAD -- \
  apps/daemon/src/activation/activation-ledger-contracts.ts \
  apps/daemon/src/activation/activation-ledger-aggregate-id.test.ts
```

## Final-gate block

Fresh exact command `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test` exited 1 in typecheck before tests because foreign live orchestrator tests expect production still being written:
- `agent-spawner.test.ts:393,405`: missing `close` / `activeCount`.
- untracked `agent-wrapper-main.test.ts:30,31,60,61,83,84`: missing `shutdownWrapperRuntime` / `createWrapperStopSignal`.
- `verifier-process-runner.test.ts:126,155,187,217,241,249,251,257`: missing `killGraceMs` / `close` / `activeCount`.

Repo-wide/head failure intersection with the two owned paths was empty. The separately executed daemon suite proved execution (94 files, 1964 tests) but had 23 foreign failures; focused owned tests are green. Resume step 5 only after foreign orchestrator WIP settles, rerun the exact gate fresh, then perform step 6 adversarial review.