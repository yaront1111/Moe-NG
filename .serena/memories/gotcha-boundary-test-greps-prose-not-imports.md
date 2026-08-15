# Gotcha: the scheduler package-boundary test greps raw file CONTENT, so a doc comment can fail it

`packages/scheduler/src/package-boundary.test.ts` — "keeps scheduler registrars
behind the package-root import boundary" — walks every source file under
`adapters/`, `apps/`, `packages/` (skipping `packages/scheduler` itself and
`node_modules`) and does:

```ts
const forbiddenInternalPath = /(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u;
if (forbiddenInternalPath.test(contents)) violations.push(relative(root, file));
```

`contents` is the raw file text. It does not parse imports. A **prose mention**
inside a `/** */` module doc, a string literal, or a commented-out line trips it
exactly like a real deep import would.

Observed 2026-08-08: `packages/core/src/planning/planning-run-test-fixtures.ts`
line 4 read

    * Mirrors `packages/scheduler/src/test-fixtures.ts`: it lives under `src/` so

and the whole-repo gate went red — `AssertionError: expected [ Array(1) ] to
deeply equal []` — while `pnpm --filter @moe/core test` stayed green, because
the boundary test lives in the scheduler package, not core.

## What to do

- When you write a module doc that references the scheduler package's internals,
  say "the scheduler package's test-fixtures module", not the path. Any phrasing
  without `scheduler/src/` or `@moe/scheduler/` is fine.
- Whole-repo red with a package-scoped green is the signature. Find the culprit
  with
  `grep -rlnE "@moe/scheduler/|scheduler[\\/]src[\\/]" --include=*.ts adapters apps packages | grep -v "^packages/scheduler/"`
  — it prints the exact violation list the test builds.
- Same class of trap applies to any content-scanning guard test: check what it
  greps before assuming your file is clean because its *imports* are clean.
