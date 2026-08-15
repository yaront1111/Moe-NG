# Adding ANY value export to @moe/runner reddens a second test file

`packages/runner/src/index-surface.test.ts` hand-transcribes the entire root namespace and
asserts:

```ts
expect(Object.keys(runner).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name).sort());
expect(EXPECTED_EXPORTS.length).toBe(<N>);   // separate assertion, must be bumped too
```

So publishing a new value through `src/surface/*-surface.ts` — even though `index.ts` picks it
up automatically via `export *` — makes `pnpm --filter @moe/runner test` fail with
"publishes exactly the reviewed root namespace, with no loss and no addition". You must add
`["name", "function"|"array"|"number"|"string"|"regexp"]` AND bump the count literal.

This is the guard working as designed (an unreviewed addition is supposed to go red), not a
workaround. Budget the edit: `index-surface.test.ts` is effectively a co-owned path of every
task that widens the runner root, even when the task description does not list it.

Type-only exports do NOT appear in `Object.keys` and need no entry there.

Related: `packages/runner/src/runtime-entrypoint.test.ts` separately requires an exact one-line
`export * from "./<name>.ts";` bridge next to every runtime `.ts`, and requires that `*.test.ts`
/ `*-test-fixtures.ts` / `*-test-helpers.ts` have NO bridge. Forgetting either half fails a
different test than the one you were working on.
