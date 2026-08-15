# A `.js` bridge in @moe/core is ILLEGAL unless index.ts reaches the module

Found on task-b863bae8, 2026-08-11, by the full core suite going red on a file I did not own.

## The trap

Every module under `packages/core/src` appears to have a one-line sibling
`export * from "./<name>.ts";`. It reads like a universal convention, and a plan's owned-path list
may even name the bridge files. Create them for a new module and you get:

```
FAIL packages/core/src/runtime-entrypoint.test.ts
  > bridges exactly the modules reachable from the package entry point
unexpected: ["expansion/expansion-approval.js", "expansion/expansion-preparation.js"]
```

## The actual rule

`runtime-entrypoint.test.ts:157-188` requires `missing`, `unexpected` AND `wrongContent` to be
empty, where the expected bridge set is EXACTLY the transitive closure of relative `.js` import
specifiers from `src/index.ts`. `packages/core/package.json` pins
`"exports": { ".": "./src/index.ts" }` — an exclusive map, so no consumer can deep-import and
runtime reachability IS reachability from index.ts.

A bridge exists so real Node's `--experimental-strip-types` runtime, which does NOT do
TypeScript's `.js` -> `.ts` resolution, can load the RUNTIME surface. A module not on that surface
does not need one, and having one is a hard failure.

Note the guard also compares bridge bytes through utf8, so a CRLF bridge lands in `wrongContent`
where `git diff --stat` would not have shown it.

## What to do

If your module is not exported from `index.ts`, DO NOT create a bridge. Keep writing `.js` import
specifiers everywhere — vitest and tsc both resolve them back to `.ts`, and the guard's own
scanner matches on them. The repo already relies on this:
`packages/core/src/planning/planning-invariant-drivers.ts:12` imports
`"./graph-revision-test-fixtures.js"` and no such bridge exists on disk.

Add the bridge in the SAME change that adds the `index.ts` export, never before.

## Why you cannot just export it and move on

`index.ts` is usually not in your owned paths, and on an epic that assigns the public surface to a
dedicated hardening task, publishing early takes a decision that belongs to that task. Landing the
module unbridged and unexported is the correct state; the consumer task adds both together.

Related: `mem:gotcha-git-diff-is-blind-to-untracked-paths` (a new bridge is untracked, so
`git status` alone will not tell you it broke a suite — only the red test will).
