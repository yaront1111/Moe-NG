# Handoff: @moe/control-room-client (IMPLEMENTED, commit 9583ab6)

10 files, +1814. Focused gate `pnpm --filter @moe/control-room-client typecheck &&
pnpm --filter @moe/control-room-client test` -> exit 0, 25/25. Repo gate `pnpm
typecheck` exit 0, `pnpm test` 81 files / 1064 passed | 1 skipped. `pnpm --filter
@moe/daemon test` 28/28.

## Shape

- `generator/generate.ts` (337) — SINGLE file on purpose. A helper module would need a
  committed `.js` shim for the raw-node `--experimental-strip-types` run or die
  ERR_MODULE_NOT_FOUND, and that failure is invisible to BOTH tsc and vitest. Exports
  `renderGeneratedClient()` (pure) + `emitGeneratedClient(outDir)`. CLI guard compares
  `resolve(process.argv[1])` to `fileURLToPath(import.meta.url)` — not `import.meta.main`
  (Node-version-gated type).
- `src/generated/generated-client.ts` (886, GENERATED — line-cap exempt) — 92 command
  builders, 16 query builders, 38-row error table (full `RuntimeErrorDescriptor`
  projection, so tests deep-equal `lookupRuntimeError`), telemetry re-export, pins.
- `src/client-compat.ts` (165) + `src/index.ts` (21, exports ONE value:
  `createCompatGate`).

## Decisions a reviewer will ask about

1. **Field name**: the contracts field is `recoveryCommands`, NOT the plan's
   `recoveryOperations`.
2. **The refusal is not a `RuntimeError`.** See `mem:gotcha-create-runtime-error-requires-source`
   — `createRuntimeError({code:"DISTRIBUTION_MISMATCH"})` silently returns
   `UNKNOWN_ERROR` because that row declares `validSources:["PROJECT"]`. Faking a
   PROJECT state, or accepting `truthClass: DAEMON_VERIFIED` for a client-side string
   compare, would invent daemon truth. Local `CompatRefusalError` instead:
   code + retryability/recoveryCategory/transport projected from the generated table
   (facts about the CODE) + `truthClass: "OBSERVED"`. One shared frozen refusal object
   for every path (identity asserted with `toBe`).
3. **Structural-typing residual, documented in the emitted header**: no builder
   synthesizes identity and no raw-field builder exists, but `NextAllowedCommand` is
   structural, so TS cannot prove an affordance came from `buildNextAllowedCommands`.
   Rejected an `Object.isFrozen(affordance)` heuristic — an attacker can freeze, and it
   would falsely refuse `structuredClone`d affordances crossing a worker boundary.
4. **`apiCompatibilityRange` is a degenerate exact-pin** (v1). Can refuse a compatible
   build; can never admit an incompatible one.
5. **`buildToolVersions`/`sourceSha`/`assetDigest` are shape-checked only** — the client
   holds no expected value, and inventing one would be a fabricated pin.
6. **Digest blind spot**: envelope key arrays are module-private in contracts, so
   `contractDigest` cannot see envelope-shape drift. Compensation verified LIVE by
   flipping a key: TS1360 (`satisfies`) + TS2344 (`AssertNever`) both fire.
7. **No event-stream vocabulary** — spec 13-D3 TBD, no domain-event type in contracts.

## If you change @moe/contracts

Goldens break BY DESIGN. Ritual: `pnpm --filter @moe/control-room-client generate`,
review the diff, update `GENERATED_FILE_SHA256` and `CONTRACT_DIGEST` in
`src/generated-coverage.test.ts`. Current: file
`ad292bf487677731431892d3b5af7a09980f0a9cfe480132479b50aa964d741c`, digest
`1d96f39e6399ce63090405ca6168175540cce1c783154a52007a8905eaa47106`.

## Verified environment facts

- vitest DOES resolve NodeNext-style `"./x.js"` specifiers to `x.ts`. No `.js` shims
  were needed or added for this package (nothing raw-node-imports `src/`).
- Determinism oracle is tmpdir byte-compare, never `git diff` (HEAD moves under
  concurrent workers; `mem:gotcha-moe-wrapper-autocommit`).
- Lockfile diff was mine alone (6 insertions, one importer), so `pnpm-lock.yaml` IS in
  the commit. A collision warning against another task never materialised.
