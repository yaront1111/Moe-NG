# Bare `@moe/*` specifiers do NOT resolve from the repo root

MEASURED 2026-08-08 during QA of task-eb9ff081 (runner .js bridges), Node v24.16.0.

There is no `node_modules/@moe` at `D:\projexts\moe-next`. pnpm links workspace
packages into each consuming package's own `node_modules`, not into the root.
So from the repo root:

```
node --experimental-strip-types -e 'await import("@moe/runner")'
-> ERR_MODULE_NOT_FOUND: Cannot find package '@moe/runner'
```

This is NOT a defect in the package. `@moe/store` — which has shipped correct
`.js` bridges for a long time — fails identically from root. Confirmed:
`ls node_modules/@moe` -> does not exist; `ls packages/runner/node_modules/@moe`
-> only `contracts` (its one declared dependency).

## Two resolutions that DO work

1. **Self-reference through the exports map** (what a real dependent gets):
   `cd packages/runner && node -e 'await import("@moe/runner")'` -> 66 exports.
   Works because Node's self-reference rule reads the package's own `exports`.
2. **Path import from repo root**:
   `node -e 'await import("./packages/runner/src/index.js")'` -> same 66 exports.

## Why this matters for probe design

Any DoD or plan that says "run a plain-Node probe FROM THE REPO ROOT using
`import('@moe/pkg')`" is unsatisfiable for every package in this workspace. It
cost this QA pass a full false-alarm cycle: the first probe reported EVERY
import FAILED and read as a catastrophic regression.

**The regression control is what caught it.** A probe with only a positive and a
negative control would have looked like a real defect. Because the probe also
imported known-good `@moe/store`, and THAT failed identically, the fault was
immediately attributable to cwd rather than to the code under review. This is
the concrete case for `mem:gotcha-vitest-hides-missing-js-bridge`-style control
discipline: the control does not just prove the harness works, it tells you
WHICH side of the comparison broke.

Related: `mem:gotcha-runner-package-does-not-load-under-plain-node`,
`mem:gotcha-node-does-not-resolve-js-specifier-to-ts`.

A second cwd trap in the same family: running the probe from inside
`packages/runner` with a repo-root-relative path yields the doubled path
`packages/runner/packages/runner/src` and also reads as a defect. Print `pwd` in
the probe output when the result is surprising.
