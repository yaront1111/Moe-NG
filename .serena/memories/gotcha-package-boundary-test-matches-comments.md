# Gotcha: the scheduler package-boundary test flags doc comments, not just imports

`packages/scheduler/src/package-boundary.test.ts:37-49` enforces "nothing deep-imports
scheduler internals". The rule is right. The detection is not:

```js
const contents = await readFile(file, "utf8");
if (/(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u.test(contents)) violations.push(...)
```

It reads whole file CONTENTS across `adapters/`, `apps/` and `packages/` with no notion
of imports, strings or comments. **Any prose that spells the path fails the build.**

Observed 2026-08-07: `packages/core/src/planning/planning-run-test-fixtures.ts:4` had an
accurate doc comment —

> `Mirrors \`packages/scheduler/src/test-fixtures.ts\`: it lives under \`src/\` so ...`

— and that alone turned main red (1 failed / 13 passed). Nothing was importing anything.
Rewording to "Mirrors the scheduler package's own test-fixtures module" -> 14/14 green;
reverting -> red again. Causally proven both directions.

## Two traps

1. **Correct documentation becomes a gate break.** The natural way to explain a mirrored
   module is to name it. Don't spell scheduler-internal paths in any file under
   `adapters/`, `apps/` or `packages/` — describe the module instead.
2. **It scans the working tree, not the index.** While the offending file was untracked
   (`??`) the failure was already live for every agent in the shared repo, then became
   permanent once a sweep committed it. Any agent mid-write can turn this red for
   everyone.

## Why the focused gate can't see it

The check lives in `@moe/scheduler` but scans `packages/**`. A task whose verification is
`pnpm --filter @moe/core ...` will never run it. Plans that drop the full-repo gate in
favour of one focused package gate are structurally blind to this class. Run `pnpm test`
once before completing and attribute foreign red by path.

## Durable fix (unowned as of writing)

Match import/export/require specifiers rather than raw contents. Until then, expect
recurrence on comments, changelog lines and error messages.

## Related

`mem:gotcha-tests-dir-outside-every-gate`,
`mem:gotcha-session-end-commit-sweeps-foreign-work`,
`mem:pattern-qa-mutation-testing-the-claim`
