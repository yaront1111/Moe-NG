# Gotcha: `@moe/runner` has ZERO `.js` bridges — the whole package is unloadable by plain Node

> **RESOLVED 2026-08-08 by `task-eb9ff081`, commit `160215a`.** 45 bridges landed plus a
> regression guard, `packages/runner/src/runtime-entrypoint.test.ts`, which spawns a real
> Node child under `--experimental-strip-types`. `import("@moe/runner")` through the
> package's own exports map now resolves with **66 exports, 0 undefined bindings**, and all
> 45 entry points load in separate processes. Everything below is retained because the
> ANALYSIS and the probe-with-controls method are still correct and still apply to any
> package without a build step — only the "zero bridges / unloadable" status is stale.
> Two things the fix added that this note did not anticipate: test-only is a transitive
> CLOSURE, not a filename suffix (`mem:gotcha-test-tier-modules-have-no-test-suffix`), and
> the module set moved three times mid-task, so always re-derive it.
> Handoff: `mem:task-task-eb9ff081a7644e0dbd90a52f94cc7790-handoff`.

Found by QA 2026-08-08 while reviewing `task-2580a578` (supervisor child 1). **Not a defect of
that task** — it is a pre-existing property of the entire package. Recorded so the child that
first depends on `@moe/runner` does not discover it in production.

## The facts

`packages/runner/package.json`: `"exports": { ".": "./src/index.ts" }`, scripts are only
`typecheck` and `test` — **no build step**. Tracked `.js` files under `packages/runner/src`: **0**.
For contrast: `packages/store/src` has 12, `packages/scheduler/src` has 21.

Every internal runner import is written `./foo.js` (NodeNext + `allowImportingTsExtensions:false`),
but no `foo.js` exists to resolve. vitest maps the specifier back to `foo.ts`; plain Node does not
(`mem:gotcha-node-does-not-resolve-js-specifier-to-ts`, `mem:gotcha-vitest-hides-missing-js-bridge`).

## Probe, with both controls (Node v24.16.0, from repo root)

```sh
# CONTROL, store module WITH a bridge          -> OK exports: 1
node -e "import('./packages/store/src/projections/projection-rebuild.js').then(n=>console.log('OK',Object.keys(n).length)).catch(e=>console.log('FAIL',e.code))"
# SUBJECT, new supervisor module               -> FAIL ERR_MODULE_NOT_FOUND
node --experimental-strip-types -e "import('./packages/runner/src/supervisor/effect-lifecycle.ts').then(()=>console.log('OK')).catch(e=>console.log('FAIL',e.code))"
# CONTROL, the package's OWN declared entry    -> FAIL ERR_MODULE_NOT_FOUND
node --experimental-strip-types -e "import('./packages/runner/src/index.ts').then(()=>console.log('OK')).catch(e=>console.log('FAIL',e.code))"
```

The third line is the point: **`packages/runner/src/index.ts`, the package's own entry point,
already fails** — before the supervisor subtree existed. The claude adapter (task-5ff2b39d, DONE)
has the same shape. So the supervisor correctly matched its host package's convention, and
rejecting a task for it would be demanding it fix something it does not own.

## Why it is harmless today and dangerous soon

Nothing depends on `@moe/runner` yet — `grep -l '"@moe/runner"' packages/*/package.json` matches
only the package itself. The moment the **daemon** takes that dependency (child 3's approved
ownership amendment), `import "@moe/runner"` resolves to `./src/index.ts` and dies at the first
internal specifier — under any runtime that is not vitest.

## Rule

Before the first non-vitest consumer of `@moe/runner` ships, either add `.js` bridges package-wide
(`export * from "./<name>.ts";`, one line, LF, trailing newline — the store/scheduler form) or give
the package a real build step. Whoever does it must probe with controls, not just with the new
files: a bridge probe that only imports new modules passes vacuously. Note the supervisor subtree
is NOT exported from `index.ts` (deliberate, claude modules are precedent), so it needs bridges
only if something imports it directly.

Related: `mem:gotcha-scheduler-js-shims`, `mem:gotcha-missing-runtime-bridge-invisible-to-vitest`,
`mem:task-task-2580a578812f46a49cae0af79ff6fc16-qa-verdict`.
