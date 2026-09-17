# tests/runtime

The one gate that loads every workspace package the way **Node** will, not the way vitest
will. It reads `pnpm-workspace.yaml`, resolves each manifest's `exports["."]`, and imports
that entry in a real `node --experimental-strip-types` child. Vitest rewrites a `./x.js`
specifier back to `./x.ts`, so an absent `.js` bridge is invisible to every in-package
suite; this lane is where it goes red. Two files, no package of its own, no build step.

## Seams

- `package-loadability.test.ts` — the only test file. Seven `it(...)` arms, no `describe`.
  It owns the two hand-maintained censuses: `noRuntimeEntryReasons` (today exactly
  `{"@moe/control-room": "browser-only Vite application; no Node entry by design"}`) and
  `allowedPackageFailures`, currently `Object.freeze({})`.
- `package-loadability-support.ts` — the mechanism, imported with a literal `.ts`
  extension. Exports `readWorkspacePatterns`, `expandWorkspacePattern`,
  `workspacePackageDirectoriesOnDisk`, `discoverWorkspacePackages`, `hasRuntimeEntry`,
  `observeWorkspacePackage`, `probeRuntimeEntry`, `mapWithConcurrency`,
  `observationIssues`, `formatObservation`, `runtimeProbeMarker`, and the types
  `WorkspacePackage`, `RuntimeProbeResult`, `AllowedPackageFailure`.
- Nothing imports this folder. It has no `package.json`, no `index.ts`, no `.js` bridges,
  and no workspace name — it is reached only by the root vitest `include` glob
  `tests/**/*.test.ts`.
- It is cited *by* five folder docs as their outside coverage: `apps/control-room`
  (justified no-entry), `adapters/ide-contract` (the `adapters/*` glob assertion),
  `packages/scheduler` (the positive control), `packages/context` and `packages/review`
  (bridge enforcement).

## The model

- **Discovery is a fold over the manifest, not a file walk.** `readWorkspacePatterns`
  hand-parses the `packages:` block of `pnpm-workspace.yaml` with a regex (it stops at the
  first non-indented line, so `overrides:` below it is never read). A manifest enters the
  gate the moment it exists — see `mem:gotcha-workspace-package-manifest-before-entry`.
- **Three entry states, one enum.** `readWorkspacePackage` classifies each manifest as
  `NO_RUNTIME_ENTRY` (no string `exports["."]`, or one whose extension is not `.ts/.js/
  .mts/.mjs`), `PRESENT`, or `MISSING_ENTRY` (declared but not a file on disk). The first
  bucket must be justified by name in `noRuntimeEntryReasons`; the other two are probed.
- **The probe is a source string, not a file.** `runtimeProbeSource` is passed to
  `node --input-type=module --eval` with the entry as `argv[1]`, and prints one JSON line
  stamped `MOE_RUNTIME_PROBE_V1`. `parseProbeOutput` scans stdout **in reverse** and only
  trusts the marker line, so a package that prints at import time is tolerated; a nonzero
  exit is `PROCESS_FAILED` with the child's stderr inlined.
- **Five outcomes, and every one is data:** `IMPORTED`, `IMPORT_FAILED` (carries the Node
  `error.code`, normally `ERR_MODULE_NOT_FOUND`, plus `error.url` as `specifier`),
  `MISSING_ENTRY`, `PROCESS_FAILED`, `TIMED_OUT`. Nothing throws out of the probe; a
  refusal is a value, and `formatObservation` is the single renderer used both in the
  failure message and by `observationIssues`.
- **`observationIssues` is symmetric, and that is the point.** An `IMPORTED` package that
  still has an allowlist entry fails with `allowlist entry is stale` — fixing the package
  without deleting its allowance keeps the gate red. It also fails a successful import
  with zero `exportNames`, or with any name whose namespace value is `undefined` (a
  circular-import hole through a barrel).
- **The allowlist can only ever excuse one failure.** `AllowedPackageFailure.addedOn` is
  the *literal type* `"2026-08-09"` and `expectedCode` the literal `"ERR_MODULE_NOT_FOUND"`
  — a new allowance cannot be stamped with today's date, or with any other code, without
  editing the type. `ownerTaskId` must match `/^task-[a-f0-9]+$/u`, and the match is
  path-scoped: `expectedPathFragment` must appear in the failing specifier after
  backslashes are normalised to `/`.
- **The probe imports the `.ts` path from the exports map verbatim**, so a barrel needs no
  sibling `index.js` to pass here — six do without one (`benchmark`, `contracts`,
  `control-room-model`, `coordination`, `store`, `testkit`). What this gate sees is the
  bridges *underneath* the barrel, reached through `./x.js` specifiers.
- **Bounded fan-out.** `mapWithConcurrency` is a cursor over a preallocated slot array
  (order preserved, no `Promise.all` over the whole set): width 4 for the repo sweep,
  2 in the fixture and control arms. `probeRuntimeEntry` defaults to a 30 s child timeout
  and `child.kill()`; the sweep arm carries a 180 s test timeout, the controls 45 s.

## Gotchas

- **`tests/runtime/deliberately-unresolvable.ts` must never exist.** It is the negative
  control for `ERR_MODULE_NOT_FOUND`. Creating a file at that path silently inverts the
  "positive and negative controls" arm.
- **Nothing typechecks this folder.** There is no root `tsconfig.json` and no
  `tests/runtime/tsconfig.json`; `pnpm typecheck` is `pnpm -r typecheck` over packages, and
  the fault/security/migration/e2e lane tsconfigs each `include` only their own directory.
  Point `tsc` at `package-loadability.test.ts` with `tsconfig.base.json`'s settings and it
  errors `TS5097` immediately — the `./package-loadability-support.ts` import is legal only
  because `allowImportingTsExtensions: false` never reaches it. Every other lane uses
  `.js`-spelled relative imports; this one does not. Do not "fix" it in isolation.
- **`@moe/scheduler` is hard-coded as the positive control**, twice. Renaming that package
  or emptying its barrel reds two arms here for reasons that name no scheduler file.
- **The `adapters/*` arm is a two-sided pin**: it asserts `adapters/*` expands to contain
  `adapters/ide-contract`, and uses `no-such-workspace-base/*` for the absent-base path
  (the comment records that `adapters/` used to be empty). Removing `ide-contract` reds it.
- **Adding a workspace package is a three-file landing.** `package.json` + the declared
  entry + the bridges must land together, or every other agent in the shared checkout sees
  this file red. A package with no Node entry must also be added to `noRuntimeEntryReasons`
  — that arm is an ordered `toEqual` against `Object.keys`, not a subset check.
- **Grep `ownerTaskId` for your task id before you start.** A tracked allowance can name
  your task as the owner of a cleanup that your package-scoped gate cannot observe;
  `pnpm --filter @moe/<pkg> test` scopes to `packages/<pkg>/src` and never runs this file.
  See `mem:gotcha-package-loadability-allowlist-names-its-owner-task`.
- The failure message prints the whole sweep (`runtime package report:\n…`) as the second
  argument to `expect(issues, …)`. Read that block before bisecting: it names every package
  and its outcome, and the red is frequently a *foreign* package's missing bridge.

## Testing

- One file (this is the whole folder): `pnpm exec vitest run
  tests/runtime/package-loadability.test.ts`. It is fast — 7 tests, ~2 s wall, ~1.2 s of
  which is the 18-package sweep — so there is no reason to skip it before pushing.
- It runs inside the root gate `pnpm test` (include `tests/**/*.test.ts`, `pool: "forks"`,
  workers capped at 2–8 by `vitest.config.ts`). No lane script targets it: it is not in
  `test:security`, `test:fault`, `test:migration`, `test:integration` or `test:e2e`.
- Related but narrower coverage lives in the fourteen per-package
  `*runtime-entrypoint.test.ts` files, which audit bridge bytes exhaustively inside one
  package. `@moe/benchmark` has no such test, so this lane is the only real-Node load its
  barrel ever gets.
- The fixture arm writes under `os.tmpdir()` via `mkdtemp("moe-runtime-loadability-")` and
  removes it in `finally`; never point it at the repo root.
