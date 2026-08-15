# Gotcha: a green vitest suite CANNOT detect a missing `.js` runtime bridge

Found by QA on task-7617c00d (subscriptions), after 305 tests passed green.

## The blind spot
Vite/vitest resolves a `./foo.js` import specifier to `foo.ts` itself. Node does
NOT. So a production module whose sibling bridge is missing is **100% invisible
to the package test gate** — every test passes while the module is unloadable by
anything except vitest.

`tsc` does not catch it either: the `.js` bridges sit outside `include:
["src/**/*.ts"]`, so they are never typechecked.

That means **the focused gate exit-0 is not evidence the module loads.** It only
evidences behaviour under vitest's resolver.

## Why the bridges are load-bearing (see `mem:gotcha-scheduler-js-shims`)
`@moe/store` and `@moe/scheduler` have **no build step** and export
`./src/index.ts`. With `moduleResolution: NodeNext` + `allowImportingTsExtensions:
false`, every internal import is written `./foo.js`, so under `--experimental-strip-types`
Node resolves the literal `foo.js` on disk — the bridge — which re-exports the `.ts`.
They are tracked committed source, NOT build output, and NOT gitignored.

## The trap: plan-deviation splits
The plan named a bridge for each file it declared. Splitting a module mid-task
(`subscription-doc-codec.ts` out of contracts, `subscription-internals.ts` out of
writes) creates production files **no plan step declares** — and the bridge does
not follow, because no step told you to make one. **Every split needs its own bridge.**

## Detection — run this before complete_task on any new store/scheduler module
```sh
# 1. audit: every non-test .ts needs a sibling .js
cd packages/store/src/<dir>
for f in *.ts; do case "$f" in *.test.ts) continue;; esac; b="${f%.ts}"; [ -f "$b.js" ] || echo "MISSING: $b.js"; done
# 2. prove it actually resolves under the runtime that will load it (from repo ROOT)
node -e "import('./packages/store/src/<dir>/<name>.js').then(()=>console.log('OK')).catch(e=>console.log(e.code))"
```
Bridge form is exactly one line, LF, trailing newline:
`export * from "./<name>.ts";`

## Two false passes to avoid
- **Resolution is not enough.** A bridge can resolve while re-exporting nothing.
  Assert the namespace is non-empty: `Object.keys(ns).filter(k=>k!=="default").length > 0`.
- **Import cycles are only exposed once bridges exist.** `contracts.ts` <-> `doc-codec.ts`
  is a real ESM cycle that vitest never exercised under Node semantics. Cycle
  resolution depends on ENTRY POINT, so probe every entry and assert no export is
  `undefined` (TDZ), not just that it imports.

Test files correctly get no bridge — nothing loads them from the Node runtime path.
