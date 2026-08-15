# A new workspace ROOT's tests are not collected, and the suite stays green

Found during QA of `adapters/ide-contract` (task-c2d92880), 2026-08-10.

## The hole
`vitest.config.ts` at the repo root pins collection by explicit globs:

    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"]

Add a package under a NEW top-level directory — `adapters/`, and note `apps/` is missing too —
and every test in it is silently uncollected. `pnpm test` exits 0. `passWithNoTests: false` does
not save you: the rest of the suite still passes, so there is nothing to notice. Every other DoD
item then gets certified by a suite that never executed the code under review.

The pnpm workspace glob (`adapters/*`) and the vitest include are INDEPENDENT. A package can be
installed, typechecked, linked and importable while contributing zero tests.

## The check, for QA and for workers
Do not read the totals; read the collection:

    pnpm exec vitest list | grep -c "<new-package-path>"

Must be non-zero, and must be run against the ROOT config — a package-local
`vitest run --root ../.. <pkg>/src` collects fine and proves nothing about `pnpm test`.
Comparing "Test Files N passed" against a recorded baseline works too, but only if you took the
baseline BEFORE writing bytes.

## Generalisation
Any repo-wide gate defined by an allowlist of paths — vitest include, eslint globs, a tsconfig
`include`, a coverage `--include` — fails OPEN for a directory nobody added. The failure is
invisible because the gate's exit code is about the paths it DID scan. Whenever a task creates
a new top-level directory, treat every path-allowlisted gate config as part of the diff.

Related: `mem:gotcha-gate-narrowed-by-exclude-reads-as-green`,
`mem:gotcha-hop-count-scan-roots-narrow-silently`.
