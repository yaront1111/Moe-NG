# Root `pnpm test` never runs `apps/**` — an unchanged repo-wide count is NOT proof your tests vanished

`vitest.config.ts` at the repo root:

```ts
include: ["adapters/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
```

`apps/**` is absent. So `pnpm test` (root `vitest run`) does not execute a single
`apps/daemon` or `apps/*` test.

## Why this bites

You add 45 tests under `apps/daemon/src`, run the full gate, and the repo-wide
leg reports the **identical** total before and after (`Tests 5386 passed | 1
skipped (5387)` both times). That reads exactly like "my new test files were
silently dropped from the run" — the failure mode where a mistyped path arg or a
narrowed gate quietly excludes owned files. It is not. The root suite never had
them in scope.

## How to settle it in one command each way

Positive control, not inference:

```bash
find apps/daemon/src -name '*.test.ts' | wc -l     # e.g. 65
pnpm --filter @moe/daemon test                      # must report Test Files 65 passed (65)
```

If the two numbers agree, every test file on disk ran. Then run your new files
alone and subtract: `1074 total - 45 mine = 1029 pre-existing`.

## The general rule

An unchanged aggregate count across a diff has two causes — your work was
excluded, or it was never in that scope. Read the runner's `include` before
concluding the first. And conversely: **the owned-package leg
(`pnpm --filter <pkg> test`) is the one that actually gates `apps/*` work**; the
repo-wide leg's green says nothing about it.

Related: `mem:gotcha-gate-narrowed-by-exclude-reads-as-green`.
