# Gotcha: `.js` files in packages/scheduler/src are load-bearing shims, not build output

Every non-test `.ts` module in `packages/scheduler/src` has a **tracked, committed** sibling `<name>.js` whose entire content is:

```js
export * from "./<name>.ts";
```

They are NOT compiled artifacts and are NOT gitignored (`tsconfig.base.json` sets `noEmit: true`).

## Why they exist
`tsconfig.base.json` sets `moduleResolution: "NodeNext"` with `allowImportingTsExtensions: false`, so every internal import is written with a `.js` specifier (`import { x } from "./graph-internal.js"`). `scheduler-runtime-entrypoint.test.ts` spawns a real `node:worker_threads` Worker with `execArgv: ["--experimental-strip-types"]` that imports `@moe/scheduler` (which resolves to `./src/index.ts`). Node performs no extension rewriting, so it resolves `./graph-internal.js` to the literal file on disk — the shim — which then re-exports the `.ts`.

## Consequence when adding a new internal module
**Create the `.js` shim in the same commit.** Omitting it does not fail `tsc` (the `.js` files are outside `include: ["src/**/*.ts"]`, so they are never typechecked) and does not fail Vitest (Vite resolves the `.ts` directly). It fails ONLY the runtime entrypoint smoke test, with `ERR_MODULE_NOT_FOUND`.

## Exception
Test files and `test-fixtures.ts` have no shim, because nothing imports them from the Node runtime path.

Quick audit:
```sh
cd packages/scheduler/src
for f in *.ts; do case "$f" in *.test.ts) continue;; esac; b="${f%.ts}"; [ -f "$b.js" ] || echo "MISSING SHIM: $b.js"; done
```
Expected output: only `test-fixtures.js`.

## Not scheduler-only
The same convention holds in **`packages/store/src`** (also no build step, also
exports `./src/index.ts`). Confirmed on task-7617c00d, where two production
modules shipped without bridges and made all three public entry points
`ERR_MODULE_NOT_FOUND` under plain Node while 305 vitest tests stayed green.
For the detection blind spot and the plain-node probe that catches it, see
`mem:gotcha-vitest-hides-missing-js-bridge`.
