# vitest is blind to a MISSING `.js` bridge, but follows an EXISTING one

Measured 2026-08-14 in `packages/runner` while publishing `surface/codex-surface.ts`.

The repo's existing memories (`mem:gotcha-vitest-hides-missing-js-bridge`,
`mem:gotcha-missing-runtime-bridge-invisible-to-vitest`) say vitest rewrites
`./foo.js` -> `foo.ts`. That is only half true, and the half matters when you
design a mutation drill.

**vitest rewrites `./x.js` -> `x.ts` ONLY when `x.js` does not exist on disk.**
If the bridge file exists, vitest loads it and follows its contents like any
other module.

Consequences for drilling a bridge:

| drill | vitest suites | child-Node probe |
|---|---|---|
| bridge CONTENT mutated (`./x.ts` -> `./x-absent.ts`) | **RED** — "Cannot find module './x-absent.ts' imported from .../x.js" | RED |
| bridge FILE removed | **GREEN — fully blind** | RED, `ERR_MODULE_NOT_FOUND` |

So a content mutation does NOT demonstrate the blindness; only removal does.
Measured on this task: with `surface/codex-surface.js` moved out of the tree,
`index-surface.test.ts` passed **239/239** — count literal, exact `Object.keys`
set equality and 42 type annotations all green — while
`runtime-entrypoint.test.ts` reddened twice, naming the module both times
(`missing: ["surface\\codex-surface.ts"]`, and the probe's
`specifier: file:///.../surface/codex-surface.js`).

Make the child probe's failure branch report a **specifier**, not just `code`.
A downstream `typeof x === "undefined"` names nothing.

Restore by reverse `Edit` or move-back and sha256-check. A new bridge is
UNTRACKED, so `git checkout` deletes it rather than restoring it
(`mem:gotcha-git-checkout-restore-destroys-uncommitted-task-work`).

Related: `mem:gotcha-entry-bridge-is-not-on-the-bare-specifier-path` — drilling
`src/index.js` proves nothing, because `exports` maps `.` straight to
`./src/index.ts` and Node never consults the sibling.
