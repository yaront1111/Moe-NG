# Gotcha: vitest run from inside a package finds ZERO test files and does not say why

Hit on `task-4a3b5ec0` (2026-08-08) while trying to run a single new supervisor suite.

## The trap

`packages/runner/package.json` declares:

```json
"test": "vitest run --root ../.. packages/runner/src"
```

The vitest config lives at the REPO ROOT with `include: ["packages/**/*.test.ts", ...]`.
So running vitest from inside the package resolves the include glob against the package
directory, where nothing matches:

```
$ cd packages/runner && npx vitest run src/supervisor/launch-lock.test.ts
 RUN  v4.1.10 D:/projexts/moe-next/packages/runner
No test files found, exiting with code 1
```

It exits 1, so it does not read as green — but the message says "No test files found",
which is easy to skim as "the filter matched nothing, try another path" rather than
"your root is wrong". The same command from the repo root without `--root .` fails
identically, because the config's root is still the package.

## The fix

Always run from the repo root WITH an explicit root:

```bash
npx vitest run --root . packages/runner/src/supervisor/launch-lock.test.ts
npx vitest run --root . packages/runner/src/supervisor          # whole directory
```

## Why it matters beyond annoyance

A TDD RED step is verified by reading the failure. If the "red" you observe is
`No test files found` rather than `Cannot find module './launch-lock.js'`, you have
verified nothing about your test — you have verified your invocation. Always read WHICH
error the red run produced, not merely that it was non-zero.

Related: `mem:gotcha-vitest-hides-missing-js-bridge`,
`mem:task-task-4a3b5ec031f14079bce4141abf922905-handoff`.
