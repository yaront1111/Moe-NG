# Gotcha: the scheduler package-boundary test greps raw file TEXT, so a comment can turn it red

`packages/scheduler/src/package-boundary.test.ts` has a case
"keeps scheduler registrars behind the package-root import boundary" that walks every
source file under `adapters/`, `apps/` and `packages/` (skipping `packages/scheduler` and
`node_modules`) and regex-tests the file CONTENTS against:

```js
const forbiddenInternalPath = /(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u;
```

It reads the file as a string. It does not parse imports. So prose in a docblock that
merely NAMES a path — e.g. a fixture header saying "mirrors
`packages/scheduler/src/test-fixtures.ts`" — registers as an import-boundary violation and
turns the whole-repo gate red with that file as the sole entry. Observed 2026-08-08:
task ca32f538's planning-run fixture header did exactly this, and the fix (commit d2b1d77)
was to reword the sentence, not to change any code.

Consequence when you are writing a NEW module header in this repo: never spell
`packages/scheduler/src/...` or `@moe/scheduler/...` inside a comment. Describe the module
instead of quoting its path.

## The second-order trap: it looks like a flake

In a SHARED working tree (epic rail 2 pins all agents to one directory) this failure
appears and disappears between two consecutive `pnpm test` runs, because a sibling agent's
in-flight file exists during one scan and is fixed by the next. I hit it on a full-repo run,
then the same test passed 14/14 in isolation minutes later.

Do not write it off as flaky and do not attribute it to your own change. Attribute it:

```bash
git status --porcelain -- <the failing package>      # clean => committed-state red
pnpm exec vitest run <the one test file>             # isolation
git log --oneline -3                                 # did HEAD move under you?
```

If HEAD moved, a sibling landed a fix while you were running. Confirm your own files are
innocent with a direct grep for the forbidden pattern before you claim anything:

```bash
rg '@moe/scheduler/|scheduler[\\/]src[\\/]' <your owned paths>   # must be 0
```

Related: `mem:gotcha-shared-index-commit-capture` for the other way a shared tree lies to you.
