# Architect handoff — task-b7853ff1ba344f92aded1fb3d09d3ffb

## Status
Five-step/two-file plan approved and handed to WORKING.

## Verified prerequisites at planning HEAD 4d0a49fb8791b458565863377d7002a48a1a9bd8
- Owned release paths were clean.
- Root package.json declares `@moe/daemon: workspace:*`.
- Root pnpm-lock importer links `@moe/daemon` to `apps/daemon`.
- Bare daemon root exports zero-arg async `collectDoctorVersionReport` plus `DoctorVersionReport`.
- Trap-cleaned strict root TypeScript probe passed.
- Pinned Linux Node 24.16 plain-Node bare import/call passed with v1, 18 components, frozen report.
- Focused baseline: release typecheck exit 0; Node release integration 60/60 pass.
- `scripts/release/supply-chain.mjs` still has the obsolete doctor placeholder and is a pre-existing 264 lines.
- A later foreign edit made daemon index dirty only for event acknowledgement exports; doctor exports remain. Do not touch it.

## Approved design
Import collector only from bare `@moe/daemon`, add it to frozen `SYSTEM_PORTS`, and call exactly once after existing tool identity checks but before keys/temp roots/signals/publication. Snapshot with structuredClone, validate/canonicalise the v1 envelope/cardinalities, then recursively freeze. Do not reinterpret nested Doctor ObservedValue/pin/component semantics; preserve every code/layer UNKNOWN. Throw, rejected promise, refusal, invalid version/envelope, or noncanonical value maps to exact `RELEASE_SUPPLY_CHAIN_REFUSED / TOOLCHAIN_OBSERVATION_FAILED / RELEASE_SUPPLY_CHAIN` and zero archive/build/publication.

Keep release component count derived from the canonical six-entry inventory; doctor componentCount remains separate. Preserve releaseVerdict UNKNOWN, publicationAuthorized false, reportCount 3, distribution/SBOM/OS authority.

## Required tests
- Full exact coded-UNKNOWN fixture through zero-arg spy, deep frozen.
- Real SYSTEM_PORTS case omitting only fake collector, proving actual bare-root call.
- Three-case generated failure matrix with exact cardinality and zero effects.
- Refusal site sweep becomes 10 sites / 9 distinct reasons.
- Mutation A restores the former placeholder and must red the real-port test.
- Mutation B breaks failure mapping and must red exact reason/layer/zero-publication assertions.
- Out-of-repo backups, EXIT restore, SHA equality, no residue.

## Exact completion gate
`export PATH=/home/sysadmin/.npm/_npx/32bdabe214bd28ec/node_modules/node/bin:/tmp/moe-node2416-bin:$PATH; export pnpm_config_verify_deps_before_run=; pnpm typecheck:release && pnpm test:integration`

Require exit 0 plus nonzero Vitest and Node test-count lines. Run repo-wide typecheck/test before/after for path-attributed baseline. Commit only the two explicit owned paths.