# An intra-`tools/` import needs a `.js` bridge, exactly like `packages/*`

Found on task-69d32b1da9e345f09cd18224b301747c (legacy snapshot decoder), 2026-08-14.

`tools/` is NOT a workspace package (pnpm-workspace.yaml globs only `apps/*`,
`adapters/*`, `packages/*`), so a tool imports production code by deep relative
path — `../../packages/import/src/index.js`. That resolves because every module
under `packages/*/src` has a sibling `.js` bridge.

**The trap is the FIRST import between two files inside `tools/`.** Before this
task, `tools/packaging` held two files that never import each other, so the repo
had no precedent and no bridge. Splitting a tool into two files and importing
`./shadow-input.js` typechecks green and then dies at runtime:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  D:\projexts\moe-next\tools\import\shadow-input.js
  imported from D:\projexts\moe-next\tools\import\import-shadow.ts
```

`pnpm typecheck:import` stays exit 0 throughout — tsc resolves `.js` to `.ts`,
Node does not. Nothing in the repo catches this either: `tools/` is outside every
vitest include, and `tests/runtime/package-loadability.test.ts` probes WORKSPACE
package entries only, so a broken tool import is invisible to all of them.

Fix is the same one-line bridge used everywhere else, named for its own sibling:

```
export * from "./shadow-input.ts";
```

**Only RUNNING the tool finds this.** If you split a file under `tools/`, execute
it (`node tools/<x>/<entry>.ts`) before believing the typecheck. See
`mem:gotcha-node-does-not-resolve-js-specifier-to-ts` and
`mem:convention-js-bridge-tier-classification` for the packages/* rule this
mirrors, and `mem:gotcha-missing-runtime-bridge-invisible-to-vitest`.
