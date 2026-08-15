# archiveSource cleanup plan handoff

Planned and approved on 2026-08-15 at HEAD `2e34a5f` after active task `task-ec70ba5b904848b496b9bf5d2c2be92f` landed and cleared the shared-file collision.

Fresh measurement:
- `scripts/release/supply-chain.mjs` is 257 lines.
- `archiveSource` at lines 56–66 still ends in an unguarded `finally { rmSync(...) }`.
- `cleanRoots` at lines 185–188 already catches cleanup errors and reports `release temporary cleanup failed: ...`.
- Existing `tests/integration/release-supply-chain.test.mjs` is 761 lines and must remain byte-unmodified.
- Contrary to the stale task rail, the `.mjs` begins `// @ts-check` and `pnpm typecheck:release` checks it with `--allowJs --checkJs`.
- Vitest discovers new `tests/**/*.test.ts` files, so the plan adds `tests/integration/release-archive-cleanup.test.ts` rather than changing the existing Node test.

Approved approach: export the production `archiveSource` and add only an optional `rmSync` override, defaulting to the imported real function. Use real git/tar against a tiny temp Git repo; inject a deterministic cleanup throw. Four explicit tests pin exact success, exact release refusal code/reason/layer, cleanup reporting/attempt, and real archive absence after default cleanup on both exits. Production catches cleanup exactly like `cleanRoots`, without changing SYSTEM_PORTS, evidence, cleanRoots, or vocabulary. Mutation temporarily restores the equivalent unguarded removal; two named tests must fail; restore byte-exact by SHA-256.

Completion evidence command: `pnpm typecheck:release && pnpm test:integration`. Repo-wide legs are also measured before/after for path-attributed baseline disclosure.