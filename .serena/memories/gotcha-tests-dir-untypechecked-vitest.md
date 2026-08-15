# Root `tests/` is UNTYPECHECKED — gate teeth must be runtime assertions

No tsconfig covers root `tests/**` (`pnpm typecheck` runs `--recursive` over `packages/*` only), and vitest's esbuild transform strips types without checking them. Consequences:

1. A test file can carry type errors, wrong imports or bogus generics and still go green. Anything a gate asserts must be a RUNTIME assertion (`expect(...)`), never a type-level one.
2. `pnpm test` passing does NOT imply `pnpm typecheck` passes for the packages the tests exercise. Observed live: property tests were 40/40 green while `pnpm --filter @moe/testkit typecheck` failed on a missing type import in the production module. Always run `pnpm verify:foundation` (typecheck + meta tests) before completing a task that adds package sources.
3. Conversely, `.ts` files under `packages/*/src/**` ARE typechecked recursively even when no test in that package imports them — a new unexported subdirectory still breaks `pnpm typecheck`.

Related tripwire: `packages/scheduler/src/package-boundary.test.ts` scans the CONTENTS of every source file under `adapters/`, `apps/`, `packages/` for the substrings `@moe/scheduler/` (trailing slash) or `scheduler/src/` — including inside comments and string literals. Files under root `tests/` are outside that walk, so the same string is safe there.
