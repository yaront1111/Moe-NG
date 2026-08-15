# Running one runner test file by hand exits 1 without running anything

`packages/runner/package.json` defines:

```
"test": "vitest run --root ../.. packages/runner/src"
```

The `--root ../..` is load-bearing. The vitest config lives at the repo root and
its `include` is repo-root-relative (`packages/**/*.test.ts`). Invoking vitest
from the package without that flag resolves the include against
`packages/runner`, matches nothing, and prints:

```
No test files found, exiting with code 1
```

**That is exit 1 having run zero tests, not a red suite.** Piped through `tail`
or read as "the gate failed", it looks exactly like a failure you caused — and if
you are mid-TDD expecting RED, it looks like the RED you were after.

To run a subset, keep the flag and pass ROOT-RELATIVE paths:

```sh
pnpm --filter @moe/runner exec vitest run --root ../.. \
  packages/runner/src/recovery/safe-boundary.test.ts
```

Package-relative paths (`src/recovery/...`) fail the same silent way even with
the flag, because the filter is matched against the root-relative path.

General form of the trap: **a runner that finds no work and a runner that found
failing work both exit non-zero.** Always read the "Test Files N passed" line
rather than the exit code alone — a count is falsifiable, an exit code is not.
Same family as `mem:gotcha-vitest-root-silently-finds-no-tests` and
`mem:gotcha-pipe-to-tail-hides-the-gate-exit-code`.
