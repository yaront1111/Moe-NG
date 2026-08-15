# Gotcha: a missing `.js` runtime bridge is invisible to the whole vitest suite

Found on `task-7617c00dfc4a46eb81ebb8673f724855` (2026-08-08) at QA. 305 tests green,
typecheck exit 0, and the entire `packages/store/src/subscriptions/` module was
**unloadable by Node**.

## Mechanism

`@moe/store` has **no build step**. `package.json` `exports` points straight at
`./src/index.ts`, so the package is consumed as source under Node strip-types. A production
`.ts` importing `"./sibling.js"` therefore needs a real `sibling.js` on disk — the one-line
`export * from "./sibling.ts";` bridge IS the resolution mechanism, not decoration.
Documented at `docs/plans/2026-08-06-versioned-command-decision-slice.md:75` and
`2026-08-06-phase0-freeze-tooling-slice.md:23`; every non-test, non-entrypoint `.ts` under
`packages/store/src` has one, including all three production files in `outbox-relay/`.

**Vitest resolves a `.js` specifier back to its `.ts` sibling.** So the suite passes whether
or not the bridge exists. `tsc` also passes — it resolves the same way. There is no gate in
this repo that catches a missing bridge.

## How it gets introduced

Not by forgetting the convention outright — by **splitting a file mid-task**. The plan named
a bridge for each file it listed; the two files born from in-flight
"this would burst the 400-line cap, split it" deviations got no bridge, because no plan step
mentioned them. Every file-split deviation needs its bridge created in the same step.

## The check (QA and worker, before complete_task)

From the repo root, plain node, for every public entry point of the new module:

```
node -e "import('./packages/store/src/<module>/<name>.js').then(m=>console.log('OK',Object.keys(m).length)).catch(e=>console.log('FAIL',e.code,e.message.split('\n')[0]))"
```

`ERR_MODULE_NOT_FOUND` names the exact unresolvable specifier and the importer. Run a known-good
module (e.g. `outbox-relay/transactional-outbox-relay.js`) as a control so a cwd mistake does not
read as a defect — a wrong cwd fails with a doubled path like `packages/store/packages/store/...`.

Cheap static equivalent, no node needed:

```
grep -rhno '"\./[a-z0-9-]*\.js"' packages/store/src/<module> --include=*.ts \
  | sed 's/.*"\.\///;s/"//' | sort -u \
  | while read f; do [ -f "packages/store/src/<module>/$f" ] || echo "MISSING $f"; done
```

Related: `mem:gotcha-line-cap-is-a-design-constraint-not-a-cleanup` (the split that causes it),
`mem:task-task-7617c00dfc4a46eb81ebb8673f724855-qa-verdict`.
