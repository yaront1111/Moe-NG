# A workspace package.json committed before its entry point reddens a shared gate

Creating `adapters/jetbrains/package.json` with `exports: { ".": "./src/index.ts" }` and
NO `src/index.ts` yet immediately broke the root suite:

```
FAIL tests/runtime/package-loadability.test.ts
     > loads every Node-entry workspace package or pins its temporary bridge owner
Test Files  2 failed | 223 passed (225)      # baseline was 1 failed | 224 passed
```

That test walks EVERY workspace package and loads its declared entry. A manifest is
therefore not an inert scaffolding step — it enrols the package in a repo-wide gate the
moment it exists.

**Consequence:** `package.json` + `src/index.ts` + the `.js` bridge must land in the SAME
change. Splitting them across steps leaves a red gate for every other agent on the shared
worktree, and the red is genuinely yours under global rail 3.

**If you must stop mid-way** (blocked, out of time), remove the package directory and
`git checkout -- pnpm-lock.yaml`, then re-run `pnpm install` and re-run the root suite to
confirm you are back at baseline. Record the measurements in a task comment first — the
evidence survives, the two files take seconds to recreate.

## Related, found on the same task

`@moe/contracts` publishes ONLY `{ ".": "./src/index.ts" }` and its barrel does **not**
re-export `src/distribution/distribution-contract.ts`. Every existing importer is either a
relative sibling inside `packages/contracts/src/distribution/` or a ROOT path
(`tools/packaging/*`, `tests/integration/*`) that bypasses the exports map. So the
distribution refusal vocabulary (`distributionRefusal`, `DISTRIBUTION_MANIFEST_VERSION`,
`DISTRIBUTION_REFUSAL_*`) is unreachable from ANY workspace package — deep import fails
TS2307, barrel import fails TS2305.

A declared workspace dependency is necessary but NOT sufficient: the edge can be perfect
and the SYMBOL still unreachable because the barrel never re-exported it. Check the
barrel, not just the manifest. See `mem:deps-done-is-not-deps-reachable`.
