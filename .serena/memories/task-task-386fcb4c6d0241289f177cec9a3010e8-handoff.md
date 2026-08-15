# task-386fcb4c handoff — package-wide `.js` runtime bridges for `@moe/core`

**DONE, committed `3e7081d`** on `moe/work-2026-08-08`. 27 files, +35/-9, **26 A + 1 M**,
zero foreign paths, zero `.ts` behaviour change. Executed by `worker-29cc6667` 2026-08-09.
Same defect class as `task-eb9ff081` (`@moe/runner`, commit `160215a`).

## What landed

26 one-line bridges `export * from "./<name>.ts";` (LF, trailing newline) joining the 4
that already existed under `identity/`, plus `packages/core/src/runtime-entrypoint.test.ts`
(200 lines, 4 tests). `import("@moe/core")` under plain Node now resolves with
**39 exports, 0 undefined bindings** — from `apps/daemon`'s cwd, through the real exports
map. `task-6054520b` can publish the core-backed services on the daemon root.

## Read this before reviewing: the bridge set is 26, not 28, not 32

Three plausible rules disagree on this package and two are wrong. Full reasoning:
`mem:gotcha-core-bridge-set-needs-reachability-not-name-or-closure`. Short version: the
`@moe/runner` import-direction closure yields 32 here, because
`planning-invariant-drivers.ts` / `planning-invariant-fixtures.ts` are test-only by
CONSUMER direction, match no naming convention, and import no name-matched fixture.
The governing rule is reachability from `index.ts`, valid because
`packages/core/package.json` pins an exclusive `"exports": {".": "./src/index.ts"}`.

Four planning modules are deliberately unbridged: `graph-revision-test-fixtures`,
`planning-run-test-fixtures`, `planning-invariant-drivers`, `planning-invariant-fixtures`.

## Evidence (a green vitest run is NOT evidence for this task)

- Plain-Node probe, Node v24.16.0, from the repo root. POSITIVE `import('./packages/core/src/index.ts')`
  39 exports / 0 undefined (was `FAIL ERR_MODULE_NOT_FOUND :: project/project-reducer.js`).
  CONSUMER `import("@moe/core")` from `apps/daemon` 39 / 0. REGRESSION CONTROL scheduler 36,
  store 26, runner 66 — all reproduce plan-time numbers. NEGATIVE CONTROL all four test-only
  paths raise the **literal** `ERR_MODULE_NOT_FOUND`.
- All 30 bridges probed as their own entry in **separate** processes (ESM cycles resolve per
  entry): `PROBED=30 FAILED=0 UNDEFINED_BINDINGS=0 ZERO_EXPORT=6`. The 6 are types-only,
  verified against committed zero-export precedent in scheduler and store.
- Byte sweep `SWEPT=30 BAD=0`, and separately over the **committed blobs** `N=26 BAD=0`.
- Two-directional audit `MISSING=0 UNEXPECTED=0`.
- **Four mutation drills, all killed**, each reddening 2-3 tests: delete a bridge; bridge the
  negative control's subject; bridge `planning-invariant-drivers` (the drill that proves the
  reachability rule is enforced, not merely described); flip one bridge to CRLF.
- Gate `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` exit 0,
  **16 files / 239 tests**, up from **15 / 235**. Repo-wide `pnpm test` 165 files /
  3028 passed / 1 skipped, zero failures.

## HEAD was RED between `c699422` and `3e7081d` — not this task's doing, and now fixed

Foreign commit `c699422` (`task-e17da1c9`, Predecessor input materializer) swept my
in-progress `runtime-entrypoint.test.ts` into its tree via a whole-tree commit while the
bridges were still untracked, so that commit contains a test that fails on a clean checkout.
That is also why my commit shows the test as **M** rather than **A**. Anything checked out
strictly between those two commits shows 2 failures in that file; pulling past `3e7081d`
resolves it. Consequence for anyone running drills here: `git status` cannot confirm a
restore in this shared working directory — verify by bytes or by a red test
(`mem:mutation-drills-in-shared-worktree`).

## Also worth knowing

- `tests/runtime/package-loadability.test.ts` exists untracked in the shared tree (foreign,
  not mine). It looks like a repo-wide version of this probe. `@moe/core` is green for it,
  but a filename-driven sweep in it would mis-handle the four planning exclusions.
- `mem:gotcha-bash-tool-mangles-dollar-quoted-cr-pattern` — `grep -c $'\r'` reports a false
  CR through the Bash tool. Use `od`. The committed blobs, not just the working tree, are
  what matter: `core.autocrlf=true` is set globally and only `.gitattributes` `eol=lf` saves it.
- For the next module added to `@moe/core`: add its sibling bridge in the SAME commit.
  `runtime-entrypoint.test.ts` will now redden if you don't, in both directions.

Related: `mem:gotcha-vitest-hides-missing-js-bridge`, `mem:gotcha-scheduler-js-shims`,
`mem:gotcha-node-does-not-resolve-js-specifier-to-ts`,
`mem:gotcha-test-tier-modules-have-no-test-suffix`,
`mem:task-task-eb9ff081a7644e0dbd90a52f94cc7790-handoff`.
