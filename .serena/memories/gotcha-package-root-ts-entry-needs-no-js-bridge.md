# A `.js` bridge is NOT load-bearing for a package's ROOT specifier

Measured 2026-08-09 on `adapters/ide-contract`, contradicting a plan that predicted otherwise.

## The claim that is wrong
"Delete `src/index.js` and the plain-Node import probe fails with ERR_MODULE_NOT_FOUND."
It does not. With the bridge deleted:

    {"outcome":"IMPORTED","keys":6}

## Why
`exports: { ".": "./src/index.ts" }` points Node straight at the `.ts` file, and
`--experimental-strip-types` loads `.ts` natively. The root specifier never goes looking for a
`.js`. Bridges exist for **relative `./foo.js` specifiers between modules** — NodeNext source writes
`.js`, TypeScript resolves that back to `.ts`, plain Node does not. A single self-contained entry
module with no relative imports needs no bridge to be importable.

The same is true of the `packages/control-room-client` reference: its bridge matters for the modules
`index.ts` imports, not for its own root entry.

## What this changes
- DoD-style "root reachable by plain Node" is proven by the **exports map**, not by the bridge. Do
  not cite the bridge as the mechanism.
- A bridge-deletion drill is still worth running, but expect it to redden the **bridge-audit** tests
  (`bridges exactly the non-test modules`, `bridges every module reachable from the entry point`) and
  any file-count vacuity floor — not the import probe.
- Keep the bridge anyway: it is the repo-wide convention, the copied audit enforces it, and it
  becomes load-bearing the moment the entry gains a relative import.

Related: `mem:gotcha-git-diff-is-blind-to-untracked-paths` — every file in a new package is
untracked, so verify drill restores with `git hash-object`, never an empty diff.
