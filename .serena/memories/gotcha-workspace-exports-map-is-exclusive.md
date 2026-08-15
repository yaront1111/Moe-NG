# Gotcha: a workspace package's `exports` map is EXCLUSIVE — being a dependency ≠ symbols being reachable

Found 2026-08-08 while planning `task-ba3a45f9` (daemon work services). The task description
asserted the daemon could use `reserveAll`/`reserveProviderSlot`/`fenceAuthority` "because
@moe/scheduler is already a daemon dependency". **That inference is invalid**, and it blocked
the task at plan time.

## The rule

Every package in this repo pins:

```json
"exports": { ".": "./src/index.ts" }
```

That is an **exclusive** map. It publishes the root specifier and **nothing else** — no
subpath resolves, under Node *or* under `moduleResolution: NodeNext`. So the reachable
surface of a dependency is **exactly what its `src/index.ts` re-exports**, never what exists
in its `src/` tree.

Adding the dependency to `package.json` **links** the package. It makes **zero symbols
reachable**. Those are separate facts and it is easy to conflate them when writing a task
description.

## Probe, with both controls (run from the consuming package)

```sh
# SUBJECT — deep subpath                      -> ERR_PACKAGE_PATH_NOT_EXPORTED
node --experimental-strip-types -e "import('@moe/scheduler/authority/lease-resource.js').then(()=>console.log('DEEP OK')).catch(e=>console.log('DEEP FAIL',e.code))"
# CONTROL — package root                      -> ROOT OK exports=17
node --experimental-strip-types -e "import('@moe/scheduler').then(n=>console.log('ROOT OK exports=',Object.keys(n).length)).catch(e=>console.log('ROOT FAIL',e.code))"
```

The control matters: without it, `DEEP FAIL` could be a broken workspace link rather than the
exports map. Then **list the root export names** — resolution succeeding says nothing about
which symbols are on it.

## What it hid, in both directions

- `@moe/scheduler` root exported **17 names, all graph-kernel**. The entire `authority/` and
  `budget/` surface — the point of the package for a scheduler consumer — was unreachable
  from every package except scheduler itself.
- `@moe/runner` root exported artifacts/scope/workspace only. The `supervisor/` subtree was
  deliberately internal (`mem:task-task-2580a578812f46a49cae0af79ff6fc16-qa-verdict`).

Nobody had noticed because **there were zero external consumers**: the only mention of
`fenceAuthority` outside `packages/scheduler` was a *comment*. Internal-by-default is the
correct default; it only becomes a defect at the moment something first consumes it.

## Rules

1. **Architects: before writing "package X already exposes Y", read X's `src/index.ts`.**
   Presence in the tree, or in the dependency list, is not reachability. This is the
   `explore-before-assume` skill applied at package granularity.
2. **Publishing a seam is its own task**, owned by whoever owns the package. A consumer task
   cannot legally reach around it — and `git` ownership rails make "just add the export"
   a foreign-path edit.
3. **Do not work around it with injected ports and fakes.** That reimplements the production
   surface in test code and collides head-on with the "assert against the production surface"
   rail.
4. **Check the sibling defect at the same time.** A package with no build step also needs
   `.js` bridges for anything to load under plain Node — the export list and the bridge set
   are independent, and a green vitest run proves neither
   (`mem:gotcha-vitest-hides-missing-js-bridge`,
   `mem:gotcha-runner-package-does-not-load-under-plain-node`).

Related: `mem:gotcha-scheduler-js-shims`, `mem:gotcha-node-does-not-resolve-js-specifier-to-ts`.
