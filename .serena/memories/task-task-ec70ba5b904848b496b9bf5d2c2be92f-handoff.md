# Task ec70ba5b handoff — canonical shipped distribution subject inventory

## Landed
Commit `2e34a5fe5e65cb936dbfdaf731090ab245382ffd` contains exactly:
- `tools/packaging/distribution-inventory.ts`
- `scripts/release/release-subject.mjs`
- `scripts/release/supply-chain.mjs`
- `tests/integration/distribution/distribution-packaging.test.ts`
- `tests/integration/release-supply-chain.test.mjs`
- `package.json`

The 113-line production inventory is one frozen, hand-written six-component authority. It includes the real JetBrains adapter with the current measured 12 assets (ide-contract .js/.ts plus five JetBrains .js/.ts module pairs). Release-subject re-exports the exact same object. Supply-chain derives its count from that authority, so it no longer rejects a correct six-component subject as stale five-component evidence.

## Test integrity
The distribution test imports the canonical list as the subject but retains literal independent pins: count 6, six literal IDs, all exact assets. Do not derive those expectations from the import. The duplicate assertion must compare `Set.size` to `ids.length`; comparing only to literal 6 was proven vacuous by mutation.

Failure paths pin code and layer:
- startup omission: `COMPONENT_SET_INCOMPLETE@DISTRIBUTION_STARTUP`
- startup duplication: `COMPONENT_DUPLICATE@DISTRIBUTION_STARTUP`
- asset byte drift: `ASSET_DIGEST_MISMATCH@DISTRIBUTION_STARTUP`
- caller alternative/reorder: `RELEASE_INPUT_INVALID@RELEASE_SUPPLY_CHAIN`
- stale five-count at supply chain: `RELEASE_INVENTORY_EMPTY@RELEASE_SUPPLY_CHAIN`

Mutation drills covered omission, asset drift, duplicate id, reordered caller input, explicit typecheck-list omission, and stale consumer count; all production bytes were SHA-restored before the green gate.

## Verification
Fresh completion command:
`pnpm typecheck:packaging && pnpm test:integration`
Exit 0. Packaging tsc explicitly names three files including inventory. Vitest: 3 files, 204 tests passed (distribution suite 51). Plain Node release suite: 60 tests / 4 suites, pass 60, fail 0. Expected cleanup-warning tests print EISDIR diagnostics but do not fail.

`pnpm typecheck:release` also exited 0 during implementation. Plain Node loadability is exercised by the integration suite.

## Scope and consumer
`package.json` was the planned fourth path because the packaging typecheck is an explicit file list and otherwise would not execute against the new module. The final gate exposed stale hard-coded five-count logic in `supply-chain.mjs`; the human said “continue”, authorizing that file and its release test. Moe comment `comment-e7bef9b0a57247f58eb2c765180977ba` records the expansion.

Real downstream evidence consumer: `task-01c5f96ec1e247dc846fd628c929974a`.

Related persistent gotcha: `mem:gotcha-canonical-inventory-consumers-hide-hard-coded-counts`.

## Moe status
Worker completion accepted by Moe; task moved to REVIEW after the fresh exit-0 gate.