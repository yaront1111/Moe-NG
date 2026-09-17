# @moe/testkit

Five unrelated bodies of DEVELOPMENT_ONLY / NOT_CONFIRMATORY reference code in one private
package: the deterministic hashing primitives the Phase 0 freeze evidence is built from, the
held-out J1/J3/J4 foundation journey models, the CORE schedule-coverage checker, the §8.4
scheduler-fairness aging reference, and the golden provider stream corpora. Its job is to hold
the executable specifications and fixtures that must NOT be reachable from production code —
nothing here may be cited as evidence about what the landed system does. No workspace package
depends on it; only tests do, and `packages/scheduler` has a suite whose whole purpose is to
prove it never will.

## Seams

- `exports` is `"." → ./src/index.ts` and nothing else. Only the root-level modules are on it:
  `canonicalize` / `CANONICAL_JSON_VERSION`, `identifyEvidence` / `identifyCanonicalEvidence` /
  `snapshotEvidenceBytes`, `capturePhase0Evidence`, `verifyPhase0EvidenceManifest`,
  `evaluatePhase0FreezeCandidate`, `createNodePhase0EvidenceCapturePort` (+ `…Default…`).
  Every subfolder is unreachable through the package name — by design, not by omission.
- `src/foundation/**` — imported by relative path from `tests/fault/foundation/`:
  `foundation-harness.ts` plus `j1-linear.test.ts`, `j3-crash.test.ts`, `j4-replan-stale.test.ts`.
- `src/schedule/**` — `tests/property/schedule/schedule-checker.test.ts` and
  `schedule-coverage.test.ts` feed it the real `*_TRANSITIONS` tables from `@moe/core`.
- `src/providers/{claude,codex}/*-golden-streams.ts` — `packages/runner/src/providers/*/
  *-stream.test.ts` do not import these; they `readFileSync` the module source as text.
- `src/scheduler-fairness/index.ts` is an internal barrel, deliberately not re-exported from
  `src/index.ts`; only its own six `*.test.ts` files import it.
- Sole dependency is `@moe/contracts`. `foundation/**` imports nothing else at all — `@moe/core`,
  `@moe/store` and `@moe/scheduler` reach it only through ports `foundation-harness.ts` injects.

## The model

- **Refusals are thrown `Error`s, not result objects.** `freezeError` (`phase0-freeze-codec.ts:23`),
  `captureError` (`phase0-evidence-capture-port.ts:67`) and `nodePortError`
  (`phase0-node-paths.ts:27`) all throw `` `${code}: ${detail}` ``. ~60 `PHASE0_*` codes live in
  the message string; callers match on the prefix before the first colon.
- **`snapshotEvidenceBytes` does not trust the argument's own accessors.** It reads `buffer`,
  `byteLength` and `byteOffset` off the intrinsic TypedArray prototype getters via
  `Reflect.apply`, and refuses proxies and `SharedArrayBuffer`, so a subclass cannot lie about
  its bytes. `canonicalize` refuses lone surrogates, symbol keys, non-index array properties and
  strings over `MAX_JSON_STRING_UTF8_BYTES` with `TypeError: Unsupported canonical JSON value: …`.
- **The freeze verifier never grants a freeze.** `evaluatePhase0FreezeCandidate` emits
  `evaluation: "EVIDENCE_CONSISTENT"` with `requiredAction: PHASE0_FREEZE_REQUIRED_ACTION`
  (`REQUIRE_TRUSTED_ATTESTATIONS`), and the reviewer's `FREEZE_READY` travels as
  `reviewClaim.claimedVerdict` — a claim, never the verdict.
- **Foundation outcomes are a closed vocabulary of four**: `EXPECTED_RED`, `HONEST_UNKNOWN`,
  `PASS_EXPECTED`, `PRODUCTION_BEHAVIOR_ABSENT` (`foundation-outcomes-fixtures.ts`). A fifth kind
  means a new `FOUNDATION_EXPECTED_OUTCOME_VERSION`, not an append. `HONEST_UNKNOWN` is a
  first-class result and must never be reported green.
- **Every `PRODUCTION_BEHAVIOR_ABSENT` row owes a falsifiable probe.** `evaluateAbsenceProbe` is
  run against the *real* root exports of the named package (`exportNames(...)` over the live
  barrels, assembled as `LIVE_EXPORT_SURFACES` in the fault harness). The probe goes red the
  moment the surface lands — that is the mechanism that forces a shipped capability to retire its
  row. Patterns match **case-sensitively** on purpose: `/timer/i` hits `historicalRuntimeResult`,
  `/lease/i` hits every `Release*`, `/review/i` hits every `Preview*`.
- **Fixture digests are hand-written literals**, not recomputed (`foundation-journey-fixtures.ts`).
  `identifyFoundationFixture` excludes volatile fields (`recordedAt`, `seed`), so editing a
  payload reds `foundation-spec.test.ts` until the digest is re-pinned by hand.
- **Determinism is enforced, not assumed.** `createFixedClock` throws `RangeError` when the
  caller-supplied instants run out rather than repeating the last one, so a schedule that changed
  shape cannot pass quietly.
- **Schedule verdicts fail closed but distinguish ignorance.** Only
  `SCHEDULE_AGGREGATE_UNLANDED` and `SCHEDULE_EVIDENCE_ABSENT` downgrade to `UNKNOWN`; every
  other `SCHEDULE_*` code is a `FAIL`, and a `PASS` with no unique evidence or no reachable refs
  is demoted (`schedule-checker.ts:233`). The obligation namespace is closed at `CORE-I1..I22`
  and `CORE-S1..S14` — no id may be minted in `schedule-obligations.ts`.
- **Fairness aging promotes toward P0**: `BYPASSES_PER_LEVEL = 8`, `DEFAULT_M_D = 10_000`,
  `MAX_FAIRNESS_EVENTS_PER_REDUCTION = 100_000`, `MAX_FAIRNESS_ID_UTF8_BYTES = 256`; eleven
  `FAIRNESS_*` codes. All state is caller-confirmed: the model never infers readiness,
  compatibility, capacity or authority.
- **Golden provider payloads are base64 inside a marked template literal.** `.gitattributes`
  opens with `* text=auto eol=lf`, which would silently rewrite a committed CRLF stream and break
  its pinned digest; the `complete` fixture carries CRLF so this stays tested. The `sha256` is
  over the RAW DECODED bytes so a reader needs no canonicalizer.

## Gotchas

- **`.js` bridges exist only for the root-level modules** — the ones `src/index.ts` reaches under
  Node's strip-types loader. Nothing under `foundation/`, `schedule/`, `scheduler-fairness/` or
  `providers/` has one, and `index.ts` itself has none (the exports map points at the `.ts`).
  A new root module needs its bridge; a new subfolder module must not get one.
- **`foundation-gate-coverage.test.ts` reads the tool configuration off disk.** It pins this
  `package.json`'s `test` script positional args to exactly `["packages/testkit/src"]`, requires
  `vitest.config.ts` to contain `"tests/**/*.test.ts"`, and requires both
  `packages/testkit/tsconfig.json` and `tests/fault/foundation/tsconfig.json` to extend
  `tsconfig.base.json` and to `include` every owned file. Touch any of those and this reds.
- **`foundation-spec.test.ts` sweeps `adapters/`, `apps/` and `packages/`** for an import matching
  `testkit[\/]…foundation`, and floors the scan (≥100 files, ≥7 foundation sources). The regex
  was narrowed once because a bare `foundation[\/]` false-positived on `apps/daemon/src/foundation/`
  and reddened unrelated tasks. It also fails on any `BENCH[-_]` identifier under `src/foundation`.
- **Hand-written counts that red**: `EXPECTED_PROBE_COUNT = 6` in
  `foundation-incident-probe-precision.test.ts`; `FOUNDATION_PARTITION_COUNTS` per journey;
  `packages/scheduler/src/package-boundary.test.ts` asserts exactly 7 forbidden import spellings
  and 6 allowed prose citations, and names three scheduler comments verbatim
  (`fairness-contract.ts:11`, `fairness-evidence.ts:7`, `fairness-ring.ts:9`) — re-wording one of
  those comments reds the scheduler suite, not this package.
- **Outside pins on this folder**: `tests/security/boundary-roster.security.ts` excludes
  `packages/testkit/` from its production-module scan and asserts `CORE_FAULT_BOUNDARIES` never
  enters the roster; `tests/integration/release/release-version-surfaces.test.ts` pins
  `packages/testkit/package.json`; `apps/control-room/src/scaffold.test.tsx` carries a
  `heldOutImport` tripwire for `@moe/testkit/…foundation/…`.
- **Renaming `CLAUDE_GOLDEN_CORPUS_VERSION` / `CODEX_GOLDEN_CORPUS_VERSION` breaks two runner
  suites**: they `lastIndexOf` the literal `moe-<provider>-golden-corpus/1 DATA BEGIN` / `DATA END`
  markers in this file's text and throw if they are missing.
- **`foundation-runtime-entrypoint.test.ts` spawns a real `node:worker_threads` worker with
  `--experimental-strip-types`** and asserts a byte-exact result object, including the sha256 of
  `"abc"` and `freezeProbe: "PHASE0_AUTHORIZATION_SHAPE_INVALID"`. It is the only arm that sees a
  missing root `.js` bridge; vitest rewrites `./x.js` back to `.ts` everywhere else.
- **`phase0-node-capture-port.test.ts` shells out to real `git`** in `mkdtemp` roots, and
  canonicalises the root with `realpath` at creation (macOS `/var` → `/private/var` otherwise trips
  the port's own stable-root guard). It is one of the files that hits the 5 s timeout under a full
  parallel root run; re-run it alone before attributing a red. `phase0-node-git.ts` strips every
  `GIT_*` variable from the child env and sets `GIT_CONFIG_GLOBAL` to `NUL` on win32.

## Testing

- One file, from the repo root:
  `pnpm vitest run packages/testkit/src/scheduler-fairness/fairness-reducer.test.ts` — the root
  `vitest.config.ts` includes `packages/**/*.test.ts` with `environment: "node"`.
- `src/schedule/**` has **no test file of its own**: it is exercised only from
  `tests/property/schedule/`, so the package gate can be green while that folder is untouched.
- Whole package: `pnpm --filter @moe/testkit test`, which is
  `vitest run --root ../.. packages/testkit/src`. There is no testkit-local vitest config; it
  re-roots to the repo on purpose so the bounded worker pool and include list still apply.
- The named gate for this package is `pnpm verify:foundation` = `pnpm typecheck && pnpm test:meta`,
  and `test:meta` is `vitest run packages/contracts/src packages/testkit/src`.
- Outside coverage: `pnpm test:fault` (`tsc -p tests/fault/tsconfig.json`, then
  `tests/fault/vitest.config.ts` — `fileParallelism: false`, `maxConcurrency: 1`, code-unit file
  ordering) executes the three foundation journeys; `tests/property/schedule/*` run inside the
  ordinary `pnpm test`; the runner's `claude-stream` / `codex-stream` tests cover the golden
  corpora; `pnpm test:security` covers the boundary roster exclusion.
