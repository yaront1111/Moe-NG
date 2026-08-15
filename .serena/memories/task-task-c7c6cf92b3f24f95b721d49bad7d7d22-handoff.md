# Handoff: retire scheduler authority-lease absence ratchet

Implemented and committed as `3944a9d347a235cc8b846b34fb2d1e7f8caee9ed`.

## Owned files
- `packages/testkit/src/foundation/foundation-fault-schedule.ts`
- `tests/fault/foundation/j4-replan-stale.test.ts`

## What changed
- `schedule:j4-stale-lease-enforcement` now declares `PASS`.
- The executor drives `scheduler.fenceAuthority` from the existing typed foundation-harness scheduler index namespace. A direct static `@moe/scheduler` import from `tests/` is unresolvable because the repository root has no `node_modules/@moe` link; the harness is the established production-package boundary (`mem:gotcha-bare-moe-specifier-unresolvable-from-repo-root`).
- The stale proof uses epoch 2 against authoritative epoch 3. Assertions pin `AUTHORITY_STALE_EPOCH` plus the exact `LEASE` security-record layer, command kind, lease id, state, and expected/observed epochs.
- The identical current-epoch proof must be accepted, preventing refuse-everything false confidence.
- Removed the now-unclaimed `probe:scheduler-authority-lease`: `foundation-spec.test.ts` enforces a bijection between ABSENT rows and probe definitions, and went red until this target probe was retired. No other row/probe/guard changed.
- Corrected stale comments in both files.

## Load-bearing proof
- Reason-code mutant (`AUTHORITY_STALE_EPOCH` expectation -> `AUTHORITY_STALE_LEASE`) failed naming received `AUTHORITY_STALE_EPOCH`.
- Positive-control mutant (current case forced to epoch 2) failed at `expect(current.ok).toBe(true)`.
- Both drill windows byte-restored to working blob `270e59007b328b006476002c1e01c29787115b3e`; HEAD blob remained `4b5197fa00a86e304d6a571e6a8fa0bbf16425d0` during drills.

## Verification
Fresh post-commit command:
`pnpm --filter @moe/testkit typecheck && npx vitest run --root . tests/fault/foundation/j4-replan-stale.test.ts && pnpm test`
Exit 0: focused J4 15/15; root 159 files, 2870 passed, 1 skipped, 0 failed.

Commit inspection showed exactly the two owned files. #general notification: `msg-b01357f61e5645108b69958870ecf8ac`.