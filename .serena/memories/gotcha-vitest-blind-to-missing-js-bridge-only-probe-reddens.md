# A missing `.js` bridge reddens exactly one test, and it is the plain-Node probe

Measured on task-e8e27f76, mutation drill 5, `packages/scheduler`.

## The experiment

Moved `packages/scheduler/src/fairness/fairness-ring.js` (contents:
`export * from "./fairness-ring.ts";`) out of the tree, then ran both harnesses.

vitest, whole package:

    Test Files  1 failed | 37 passed (38)
    Tests  1 failed | 881 passed (882)
    FAIL packages/scheduler/src/scheduler-runtime-entrypoint.test.ts
      > loads and executes the scheduler entrypoint in Node's strip-types runtime

plain Node:

    PROBE_ERROR code=ERR_MODULE_NOT_FOUND
    Cannot find module '...\packages\scheduler\src\fairness\fairness-ring.js'
      imported from ...\packages\scheduler\src\index.ts

## The point

The **only** red was the test that spawns a real Node worker. 881 other tests passed,
including all 154 tests of the module whose bridge was missing and the hand-written
47-export root-surface test. `tsc` was also clean. Vitest resolves a NodeNext `./x.js`
specifier back to `./x.ts`, so it cannot see the gap; a green suite plus a green typecheck
proves nothing about plain-Node loadability.

## How to run the probe standalone

No scratch file needed — this is transient and leaves nothing to commit:

```bash
node --input-type=module -e "import {Worker} from 'node:worker_threads'; \
const w = new Worker(new URL('file:///<abs>/scheduler-entrypoint-smoke-worker.mjs'), \
{execArgv: ['--experimental-strip-types']}); \
w.once('message', m => { console.log(JSON.stringify(m, null, 2)); w.terminate(); }); \
w.once('error', e => { console.error('PROBE_ERROR code=' + (e.code ?? 'none')); process.exit(1); });"
```

## When the bridge is load-bearing, and when it is not

Load-bearing here because `index.ts` imports the module by a **relative** `./x.js`
specifier. NOT load-bearing for a package's own ROOT specifier when `exports` maps
`"." -> "./src/index.ts"` — see `mem:gotcha-package-root-ts-entry-needs-no-js-bridge`,
where deleting `src/index.js` left the probe green. Both facts are true at once; the
distinction is relative-import vs exports-map entry.

Make the probe assert **behaviour**, not just presence: a validator's refusal code string
(`"REFUSED:SOME_CODE:SOME_LAYER"`) proves the module executed, where a `.length` could be
satisfied by a stub.

Related: `mem:gotcha-package-root-ts-entry-needs-no-js-bridge`,
`mem:type-only-export-invisible-to-count-test`.
