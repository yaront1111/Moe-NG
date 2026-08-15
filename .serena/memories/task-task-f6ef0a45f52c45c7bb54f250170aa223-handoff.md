# task-f6ef0a45f52c45c7bb54f250170aa223 handoff

## Landed
Commit `e391175ed1f46d2e049a5e05f557302b96c447d2` changes only:
- `apps/daemon/src/index.ts`
- `apps/daemon/src/index-surface.test.ts`

The `@moe/daemon` root now re-exports the existing Node-native `collectDoctorVersionReport` and type `DoctorVersionReport`. No wrapper or second collector was introduced.

## Proofs
- Runtime catalogue now has exact entry `["collectDoctorVersionReport", "function"]` and cardinality 79.
- Type-only bare-root import is pinned by `expectTypeOf<ReturnType<typeof daemon.collectDoctorVersionReport>>().toEqualTypeOf<Promise<DoctorVersionReport>>()`.
- Plain Node imports the bare root, awaits the zero-argument collector, and pins `observed.platform` to `process.platform` and `observed.node` to `process.version`.
- Mutation drills proved the count-only change, missing function export, and missing type export all redden their named proofs; a typeof-only callable probe still passed, documenting why the awaited call is load-bearing.

## Verification
Because the shared live tree carried unrelated daemon WIP, the gate used an ext4 audit snapshot of committed parent bytes plus the two owned files. SHA-256 matched live/committed bytes:
- index.ts: `764743f26537a89a45a87d2260d75f060e9384ed0150870165c5f7c5eca55367`
- index-surface.test.ts: `bda2dafdb3fcd817622e71c5f7d4e188abbc0acc1ed20a750ab99c23ab1f50e3`

Fresh final command:
`pnpm --filter @moe/daemon test && pnpm --filter @moe/daemon typecheck`
=> exit 0; 89 files / 1,825 tests passed; tsc exit 0.

Broader regression:
- `pnpm typecheck`: exit 0.
- `pnpm verify:foundation`: exit 0, 661 tests passed.
- `pnpm verify:store`: exit 0, 501 tests passed.
- Root `pnpm test` is baseline-red on Linux before and after the diff with the identical 45 failures / 6,188 passes / 247 skips, all under `packages/runner/src/providers/claude/**` and `packages/runner/src/platform/windows/**` due Windows-only runtime/broker expectations. Owned-path failure delta is empty.

## Consumers and follow-up
- Cross-host evidence consumer: `task-01c5f96ec1e247dc846fd628c929974a`.
- Out-of-scope stale release evidence remains at `scripts/release/supply-chain.mjs:231`: it hardcodes both `componentCount: 5` and missing symbol `@moe/daemon.collectDoctorVersionReport`. This task falsifies the missing-symbol half; `task-ec70ba5b904848b496b9bf5d2c2be92f` falsifies the count half. That file needs an explicit owner.