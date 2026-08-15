# Gotcha: importing a `.js` specifier that has no `.js` file — Node refuses, vitest and tsc do not

Found 2026-08-08 on `task-791d73407af64b179f6099810d940758` while building a crash-injector
child process. This is the **mirror image** of `mem:gotcha-missing-runtime-bridge-invisible-to-vitest`
and `mem:gotcha-vitest-hides-missing-js-bridge`: there a production `.ts` was shipped without
its `.js` bridge; here a file *imported* a `.js` specifier whose bridge never existed and was
never supposed to.

## What happened

`packages/store/src/projections/projection-drill-test-helpers.ts` did

```ts
import { bytes, text } from "../sqlite-event-store-test-helpers.js";
```

`sqlite-event-store-test-helpers.ts` correctly has **no** `.js` bridge — `*-test-helpers.ts`
is the repo's test-only convention and those files deliberately get none. vitest resolved the
specifier back to the `.ts` sibling and 331 tests stayed green. `tsc` accepted it too, because
`moduleResolution: NodeNext` maps `./x.js` onto `./x.ts` at type level.

Plain Node does not. Probed on **Node v24.16.0**:

```
$ node --experimental-strip-types --input-type=module \
    -e 'import "./packages/store/src/sqlite-event-store-test-helpers.js"'
code: 'ERR_MODULE_NOT_FOUND'
```

`--experimental-strip-types` strips types; it does **not** add TypeScript's `.js -> .ts`
resolution. That needs `--experimental-transform-types`, which this repo does not use.

## Why it mattered

Every crash-worker spawn would have died at import instead of at its transaction boundary.
The drill would have reported "the boundary was never reached" — or, with a weaker parent
assertion, a non-zero exit that reads exactly like a successful crash.

## Rules

1. **Any module a `.mjs` worker or a plain-`node` entry point loads must import only
   specifiers that resolve on disk.** Existing `*-worker.mjs` files in this repo import
   `./sqlite-event-store.ts` with the literal `.ts` extension for exactly this reason.
2. **A shared helper that a spawned child imports cannot depend on a bridge-less module.**
   Fix by inlining the two or three lines (here `bytes`/`text` became local `TextEncoder` /
   `TextDecoder` wrappers), not by adding a `.js` bridge to a test-only file — that would
   break the convention that keeps test helpers out of the runtime surface.
3. **Probe with BOTH controls.** A bridge probe that only imports the new modules can pass
   vacuously. Import a known-good module AND a known-bad one (a `*-test-helpers.js` that must
   raise `ERR_MODULE_NOT_FOUND`) so the probe proves it can still detect a failure.
4. **A types-only contracts module legitimately exports ZERO runtime bindings.** Do not treat
   `exports=0` as a failed bridge — the requirement there is only that it *resolves*. Verify
   against a control: `outbox-relay-contracts.js` is also 0. Only value modules must have
   `> 0` exports with no `undefined` bindings.
