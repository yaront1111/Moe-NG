# Root `tests/` cannot use `@moe/*` — use relative paths, and beware `.js` specifiers

Root `tests/**` has no workspace deps (pnpm strict node_modules), so bare `@moe/contracts` / `@moe/core` / `@moe/testkit` specifiers do NOT resolve there.

Working pattern (verified under root vitest 4.1.10, `tests/property/schedule/*`):
```ts
import { RUNTIME_LIFECYCLES } from "../../../packages/contracts/src/index.js";
import { GOAL_TRANSITIONS, PROJECT_TRANSITIONS } from "../../../packages/core/src/index.js";
```
Vite resolves the relative `.ts` file, and bare specifiers INSIDE those package files still resolve because node_modules lookup walks up from the importing file (`packages/<pkg>/node_modules/@moe/*` symlinks exist).

Count the levels: from `tests/<area>/<sub>/x.test.ts` the repo root is `../../../`, not `../../`.

## The trap: raw `node` cannot run these modules
Repo TS sources use NodeNext `.js` specifiers for intra-package imports. Vite rewrites `./x.js` -> `./x.ts`; **raw `node` does not**, so a scratch script that imports `packages/**/src/**/*.ts` dies with `ERR_MODULE_NOT_FOUND: .../schedule-model.js`. That is exactly why some testkit modules ship committed `export * from "./x.ts"` `.js` shims (needed only for the node smoke worker). Do not add shims just to debug — run the probe through vitest instead.

## vitest 4 swallows test stdout
`console.log` inside a test is hidden by the default reporter. To surface it:
`pnpm exec vitest run <file> --silent=false --reporter=verbose`
