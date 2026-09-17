# tests/property

The `property` release gate. One lane, one subject: it proves that the hand-authored CORE
schedule universe in `packages/testkit/src/schedule/**` still describes the reducers that
actually landed in `packages/core`, and that the coverage checker over it refuses to report a
PASS it cannot back with evidence. It is the only place the design-20 obligation registry
(`CORE-I1..I22`, `CORE-S1..S14`) is checked against real code, and the only executable owner
of `packages/testkit/src/schedule/**` — that folder has no test file of its own.

## Seams

- `schedule/schedule-coverage.test.ts` is the drift gate. It folds the **landed** tables
  `GOAL_TRANSITIONS`, `GRAPH_REVISION_TRANSITIONS`, `PLANNING_RUN_TRANSITIONS`,
  `PROJECT_TRANSITIONS` from `packages/core/src/index.js` plus `RUNTIME_LIFECYCLES` from
  `packages/contracts/src/index.js`, and compares them to the authored `EDGE` /
  `CORE_TRANSITION_TABLES` / `GENESIS_COMMANDS` / `NEVER_LEGAL_COMMANDS` in
  `packages/testkit/src/schedule/schedule-universe-tables.ts`.
- `schedule/schedule-checker.test.ts` is the unit gate on `checkScheduleCoverage`
  (`schedule-checker.ts`) and `canonicalScheduleForm` / `canonicalScheduleText` /
  `scheduleIdentity` (`schedule-model.ts`). It injects a synthetic two-command `ALPHA`
  aggregate and never touches `@moe/core`.
- Imports are **deep relative paths** (`../../../packages/testkit/src/schedule/…js`), never
  `@moe/testkit`. Root `tests/**` has no workspace dependencies, so bare `@moe/*` specifiers
  do not resolve here; the schedule surface is also deliberately absent from
  `packages/testkit/src/index.ts`, so the package name could not reach it anyway.
- Nothing imports *from* this folder. Its callers are the gate wiring:
  `package.json` `"test:property": "vitest run tests/property"`, the CI step
  `Gate - property` in `.github/workflows/reusable-windows-candidate-build.yml`, and
  `packages/benchmark/src/gate-families.ts` (`family("property", ["test:property"])`).

## The model

- **Two directions, both mechanical.** `deriveScheduleUniverse` generates the transition and
  race-pair universe from the injected tables (every unordered command pair legal in one
  state). Forward: every ref a schedule cites must exist in that universe. Reverse: every
  derived transition, race pair and fault boundary must be claimed by some schedule, else
  `SCHEDULE_UNIVERSE_UNCOVERED`. Authors consume the derived sets; they cannot shrink them.
- **Identity is content, not name.** `canonicalScheduleForm` replaces `scheduleId` with
  `"[schedule]"`, drops `labels` and `obligationRefs` entirely, sorts and de-duplicates every
  ref set, then `scheduleIdentity` is SHA-256 over `canonicalize(form)`. Two schedules with
  the same refs are the *same* schedule however they are named or whichever obligation they
  cite — that is `SCHEDULE_IDENTITY_DUPLICATE`, a FAIL.
- **The verdict ladder is fixed.** `UNKNOWN_CODES` holds exactly
  `SCHEDULE_AGGREGATE_UNLANDED` and `SCHEDULE_EVIDENCE_ABSENT`; the other six codes in
  `SCHEDULE_CODES` are FAIL. A known-but-unlanded aggregate is an auditable UNKNOWN; an
  aggregate outside `knownAggregates` is `SCHEDULE_TRANSITION_UNREACHABLE` and FAILs.
  `manifestVerdict` prefers FAIL over UNKNOWN, and an empty obligation list is UNKNOWN.
- **The CORE manifest is built with `hitEvidence: []` on purpose.** No execution evidence
  exists yet, so every obligation lands UNKNOWN and the lane pins that the *only* reason code
  present is `SCHEDULE_EVIDENCE_ABSENT`. "reports zero FAIL verdicts" asserts
  `verdict !== "FAIL"`, never `=== "PASS"`. Handing the checker evidence would red the lane.
- **Minima cannot be dodged.** `minimaDetails` unions the obligation's `applicableStrata`
  with every stratum whose `SCHEDULE_STRATUM_MINIMA` entry is `MANDATORY`, so `TWO_EVENT`
  applies even to an obligation that declares no strata. Minima are vacuous for an unmapped
  obligation and are then suppressed in favour of `SCHEDULE_OBLIGATION_UNMAPPED` alone.
- **Empty reducer rows are ambiguous and must be partitioned.** A landed table maps a command
  to the states it is legal *from*; an empty row means either a creation command or one no
  state admits. `landedDomain` **throws** `unclassified empty table row: <AGG> <command>` —
  not an assertion failure — when a new empty row is in neither `GENESIS_COMMANDS` nor
  `NEVER_LEGAL_COMMANDS`. `GENESIS` is a pseudo-state: entered from nothing, never a
  `toState`.
- **The manifest is deep-frozen and digested.** `checkScheduleCoverage` returns a
  `deepFreeze`d record whose `digest` is SHA-256 over `canonicalize(body)`; the lane asserts
  run-to-run equality and `/^[0-9a-f]{64}$/`.

## Gotchas

- **Nothing in `tests/` is typechecked.** There is no root `tsconfig.json` and no
  `tests/property/tsconfig.json`; `pnpm typecheck` is `pnpm --recursive typecheck` and only
  visits workspace packages. That is why `schedule-checker.test.ts` helpers
  (`transition`, `racePair`, `schedule`) carry no type annotations — a symptom, not a style.
  A change here is proven only by running the lane.
- **Editing a `*_TRANSITIONS` table in `packages/core` reds this folder, not that package.**
  `pnpm --filter @moe/core test` stays green while `pnpm test` goes red on "keeps the
  authored tables in lockstep with every landed reducer". The sync is three data edits in
  `schedule-universe-tables.ts`: add the `edge(...)` to `EDGE`, drop the command from
  `NEVER_LEGAL_COMMANDS` if listed, delete the now-false comment. An architect sizing such a
  task must count this file as an owned path.
- **Hand-mirrored censuses that red by design.** `CORE_OBLIGATION_COUNT` is pinned at 36 and
  the ids are regenerated as `CORE-I1..22` / `CORE-S1..14`; the fan-in carriers are pinned as
  the exact list `["CORE-I6", "CORE-I8", "CORE-I14", "CORE-I15", "CORE-S13"]`; and
  "re-derives the universe independently" re-implements `deriveScheduleUniverse` by hand, so
  touching the derivation reds its twin. Re-measure, never widen the matcher.
- **The provenance test greps the serialized manifest.** `JSON.stringify(manifest)` must not
  match `/BENCH-/u` or `/"(?:I|S)\d+"/u` — CORE is the engineering namespace
  (`DEVELOPMENT_ONLY_ENGINEERING_EVIDENCE`) and mints no confirmatory-corpus id. Naming
  a schedule or obligation bare `"I3"` reds it.
- **`RELEASE_SCHEDULE_FLOOR` (10 000) is recorded, never asserted.** `releaseBar.status` is
  the literal `"UNKNOWN"` and the lane asserts the 64 authored schedules are *below* the
  floor. Do not turn it into a gate.
- **No `.js` bridges under `packages/testkit/src/schedule/`**, unlike every sibling testkit
  module. The repo-wide bridge rule exists for modules a raw `node` process loads; these are
  vitest-only and unexported, so adding bridges here is noise. It also means a scratch
  `node` script importing them dies with `ERR_MODULE_NOT_FOUND: …/schedule-model.js` — probe
  through vitest instead.
- **"property" does not mean fast-check.** There is no generator library. The only randomized
  arm is the hand-rolled `xorshift32` in `schedule-checker.test.ts`, which permutes ids,
  timestamps, seeds, array order and key order across 64 fixed seeds and asserts the identity
  is unchanged.
- **Path depth:** from `tests/property/schedule/x.test.ts` the repo root is `../../../`.

## Testing

- Whole folder: `pnpm test:property` (= `vitest run tests/property`) — 2 files, 43 tests,
  about a second. It is also swept by the root `pnpm test` (`include` covers
  `tests/**/*.test.ts`) under the root `vitest.config.ts` bounded fork pool.
- One file, from the repo root:
  `pnpm vitest run tests/property/schedule/schedule-coverage.test.ts` (17 tests);
  `…/schedule-checker.test.ts` is the other 26. There is no lane-local vitest config and no
  `tsc -p` leg, unlike `test:security`, `test:fault` and `test:migration`.
- Vitest 4 hides `console.log` from the default reporter; add
  `--silent=false --reporter=verbose` when probing.
- Outside pins on this lane: `tests/security/lane-smoke.security.ts` holds `"test:property"`
  in `INHERITED_SCRIPTS` (the root script must survive byte-for-byte) and
  `tests/integration/release/release-workflow-contract.test.ts` pins the CI line
  `direct:Gate - property:pnpm test:property 2>&1 | Tee-Object -FilePath gate-property.log`
  plus its position in the gate order. Changing the script name means editing both.
