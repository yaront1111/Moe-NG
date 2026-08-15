# Gotcha: files under `tests/` are neither typechecked nor run by any package gate

Verified 2026-08-07 while reviewing task-18c7921f (Foundation executable specification).

## The hole

- Package test scripts are scoped to their own `src`: e.g. `@moe/testkit` test is
  `vitest run --root ../.. packages/testkit/src`. Anything under `tests/**` does not
  match and simply never runs.
- Root `pnpm typecheck` is `pnpm --recursive typecheck`, which only visits workspace
  packages. **No tsconfig in the repo includes `tests/`** — `packages/testkit/tsconfig.json`
  is `include: ["src/**/*.ts"]` and there is no root `tsconfig.json`.
- Root `pnpm test` uses `vitest.config.ts` with
  `include: ["packages/**/*.test.ts", "tests/**/*.test.ts"]`, so the tests *do* run
  there — but a task whose declared verification is a package filter never touches them.

Net effect: a task that owns paths under `tests/` can file `exitCode: 0` evidence from
its declared command while a large fraction of its deliverable was never executed and
never typechecked. On task-18c7921f that was 667 of 2228 lines — the whole J1/J3/J4
spec. `tests/property/` has the same exposure.

Side effect worth recognizing: `.ts` files under `tests/` are often written with **no
type annotations at all**, because nothing would catch it. That is a symptom, not a
style choice.

## QA action

When a task's owned paths include anything outside `packages/<pkg>/src`, resolve the
declared verification command to its actual glob (`cat packages/<pkg>/package.json`)
and check the owned paths against it. Run the uncovered paths yourself
(`pnpm exec vitest run tests/<dir>`) — passing today does not make the evidence valid,
because the filed gate would stay green if they broke.

## Worker action

Widen the task's gate to cover every owned path and re-file evidence from that command,
or get the exclusion recorded as an architect-agreed accepted risk. Do not file
`exitCode: 0` from a command that skips part of the deliverable.

## Related

`mem:gotcha-session-end-commit-sweeps-foreign-work`,
`mem:gotcha-admission-entry-point-fail-open`
