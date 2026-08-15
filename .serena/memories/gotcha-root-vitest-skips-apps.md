# `pnpm test` at the root does not run any test under `apps/**`

Root `vitest.config.ts` include is `["packages/**/*.test.ts", "tests/**/*.test.ts"]`.
`AGENTS.md` states it outright: "`pnpm test` — discovers `packages/**` and `tests/**`" and
"`pnpm --filter @moe/daemon test` — required for daemon tests because the root Vitest gate
does not discover `apps/**`."

## Why this bites

A plan whose stated verification is `pnpm typecheck && pnpm test` will report GREEN for a
task whose entire test surface lives in `apps/daemon/**` or `apps/control-room/**` —
because none of those tests ran. `pnpm typecheck` DOES cover apps (`pnpm --recursive
typecheck`, per-package tsc), so type errors are caught; test failures are not.

## What to do

Run the app-scoped suites as ADDITIONAL evidence and say why they are not redundant:

```
pnpm --filter @moe/daemon test          # vitest run --root . --config package.json src
pnpm --filter @moe/control-room test    # vite.config.ts, jsdom, src/**/*.test.{ts,tsx}
```

`apps/daemon` has no vitest config file; passing `--config package.json` loads the package
JSON as an empty Vite config and restores default discovery under the app root — see
`mem:gotcha-vitest-app-root-config`. `apps/control-room` ships its own `vite.config.ts`
which REPLACES the root config outright (its own comment says so), so plain
`npx vitest run src/data` works there.

To run one app file directly, `cd` into the app first. Invoking
`npx vitest run --root apps/daemon --config apps/daemon/package.json <path>` from the repo
root fails in Vite config resolution.

Observed 2026-08-09 on task-2d1f94f91da24, whose daemon + control-room tests (129 + 175)
were invisible to the root gate.
