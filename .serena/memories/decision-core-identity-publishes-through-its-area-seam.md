# Decision: add core identity exports to `identity/index.ts`, never to `packages/core/src/index.ts`

Measured 2026-08-09 while planning `task-b4f12e63baca4ecc9f2c159ed3c3ad78`.

## The convention, as recorded in the code
`packages/core/src/index.ts` publishes most areas as per-module export blocks, but line 221 is a
single wildcard:

```ts
export * from "./identity/index.js";
```

Lines 217-220 above it carry the explicit reason: `./identity/index.ts` already curates the three
identity modules, so duplicating its surface at the root would create a second place to keep in
sync.

## Consequence
- To publish a new identity symbol from `@moe/core`, add it to
  `packages/core/src/identity/index.ts`. It reaches the root automatically. **No root edit is
  needed, and adding a per-module identity block at the root contradicts the documented decision.**
- A task description that names `packages/core/src/index.ts` as the owned path for an identity
  export is naming the wrong file. Swapping it for `identity/index.ts` is same-package, same-area,
  and net-surface-identical — but say so explicitly in `planningNotes`, because QA sees a path that
  was not in the description's owned-path list.
- Prove root publication in the test by importing `../index.js` and asserting the symbol is live;
  that keeps the wildcard honest without editing the root.

## Related gate
`packages/core/src/runtime-entrypoint.test.ts` walks the reachable module closure from the package
entry. A module published only through the area seam is still reachable, so it must have its
byte-exact `.js` bridge — `export * from "./<name>.ts";` plus one **LF** (verified with `od -c`; a
CRLF bridge fails that test while `git diff --stat` shows nothing). That test uses
`toBeGreaterThan`/filter assertions, not an exact export count, so adding exports does not redden it.

See `mem:task-task-b4f12e63baca4ecc9f2c159ed3c3ad78-handoff`.
