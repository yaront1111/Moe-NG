# @moe/benchmark

The measurement and freeze-gate package for the pinned "is Moe the best tool" claim. It does
three separable jobs and deliberately no fourth: it **projects** one sealed provider-run record
into machine-readable benchmark rows, it **audits** the pinned benchmark spec's own internal
consistency before a campaign may be frozen, and it **admits** the GO_ACTIVATE binding and the
confirmatory freeze manifest. It scores nothing, ranks nothing, compares no two runs and decides
no claim — `src/index.ts` states that ban at length, and every module restates the half of it it
could break. README calls the package DEVELOPMENT_ONLY and parked to v0.2, but three of its
exports are on the daemon's live path.

## Seams

- Root export map is `"." : "./src/index.ts"` only (no subpaths, no build step). Sole runtime
  dependency is `@moe/core`, used at exactly one call site: `decideApprovalAuthority` in
  `activation-binding.ts`.
- **Daemon callers**: `admitActivationBinding` + `ACTIVATION_GENERATION_KEYS` in
  `apps/daemon/src/cutover/cutover-activate-service.ts`, `cutover-attempt-commit.ts`,
  `cutover-activate-contracts.ts`, `cutover-attempt-contracts.ts`; `resolveAll` /
  `GateFamilyEvidence` in `apps/daemon/src/cutover/v2-readiness-evidence-producers.ts`, which
  grades the e2e lane's exit codes and count lines through this package rather than its own rule.
- **Test-only callers reach past the root on purpose**: `tests/security/*-cases.ts` and the two
  campaign checkers import `../../packages/benchmark/src/<module>.js` directly, because
  `claim-ladder-contract`, `claim-ladder-resolver`, `claim-permit`, `gate-families` and
  `benchmark-record-fixture` are package-internal and stay that way.
- The projection surface: `admitRunRecord` → `projectBenchmarkRun`, `projectCostClass`,
  `projectCounts`, plus `BENCHMARK_PROJECTION_CODES/LAYERS/MESSAGES` and `BENCHMARK_UNKNOWN_BASES`.
- The freeze surface: `runPreFreezeAudit` / `auditPreFreezeSources`, `readPinnedBenchmarkSpec`,
  `readPinnedRebuildDesign`, `readPinnedCorpusAuthority`, `decodeConfirmatoryFreezeManifest`,
  `admitConfirmatoryFreezeManifest`, `readConfirmatoryFreezeAuthority`, and the `FROZEN_*` rosters.

## The model

- **Projection never re-judges sealed bytes.** `ProviderRunRecord` lives in `apps/daemon` and a
  package cannot import an app, so `benchmark-record-contracts.ts` re-declares the shape and pins
  `PROJECTED_RECORD_VERSION = "moe-provider-run-record/1"` against the daemon's
  `PROVIDER_RUN_RECORD_VERSION`. Admission answers only "is this the schema I project?" — no
  digest is recomputed, no identity re-derived.
- **Shape is checked to the depth it is read.** `benchmark-container-shapes.ts` guards each
  container's projected members, because `{}` passes `isPlainRecord` and its absent members read
  back as `undefined`, which publishes `{known: true, value: undefined}` — missing evidence
  wearing an observation's authority. Guard order is load-bearing and is the layer order:
  `BENCHMARK_INPUT` → `BENCHMARK_VERSION` → `BENCHMARK_SHAPE` → `BENCHMARK_ROW`.
- **A cell is two-directional.** `BenchmarkValue<T>` is `{known: true, value}` or
  `{known: false, basis, code, layer}`; an unknown carries no `value` key at all, and a
  PRODUCER-attributed basis (`PRODUCER_DECLARED_UNKNOWN`, `SELECTION_UNREADABLE`) must carry the
  producer's non-null code and layer. The other three bases (`BOOT_IDENTITY_MISMATCH`,
  `OBSERVATION_ABSENT`, `QUANTITY_ABSENT`) are the harness's own reading and carry none.
- **Three refusal vocabularies stay separate**: `usageRefusals` (scheduler), `upstreamRefusal`
  (provider seam), and this package's own codes, which fire only when it cannot emit a row at all.
  Likewise `costBasis` is `NO_BINDING` or `PRICEBOOK_BINDING` and there is no multiplication
  anywhere in `benchmark-cost-projection.ts` — a binding is a list price, never what the run cost.
- **The claim ladder is a permit list.** `CLAIM_LADDER` (L1–L5) in `claim-ladder-contract.ts` is a
  verbatim transcription of Section 1 of the spec at `PINNED_SPEC_SHA256`. `resolveReachedRung`
  stops at the last all-PASS rung and never upgrades absence or UNKNOWN; `permitClaim` regex-matches
  the rung's template with every slot filled, and `PERMANENTLY_FORBIDDEN` (16 phrases, including
  "parity", "cheaper", "production-ready") answers *before* the rung so L5 cannot override it.
- **Gate families grade evidence, not exit codes.** `resolveFamily` returns PASS only for exit 0
  *plus* a vitest count line matching `NONZERO_COUNT_LINE` where `passed + skipped === total`;
  exit 0 with no count line is UNKNOWN. `resolveAll` fills every omitted member of the ten-family
  roster with UNKNOWN and refuses `GATE_FAMILY_EVIDENCE_DUPLICATE`. `NON_APPLICABLE` needs a
  non-empty `permitReason` and is available only when no execution evidence was recorded.
- **Nothing parses unpinned bytes.** `readPinnedSource` hashes first and refuses
  `SPEC_BYTES_UNPINNED`; it mints a `PinnedSource` branded with the unique symbol
  `PINNED_SOURCE_BRAND`, and every collector in `pre-freeze-source-reader.ts` takes only that type,
  so the hash gate is a type guarantee rather than a convention. The pin is a *parameter* so tests
  can open synthetic documents with their own true digests instead of mocking the gate.
- **Corpus authority is observed from Git, never supplied.** `pre-freeze-pinned-documents.ts` is
  the only file here that touches a path. It resolves `MOE_PINNED_DOCUMENT_ROOT` (no default —
  deliberately, a built-in path made the audit pass on one machine), requires a clean repo, and
  re-observes HEAD *and* porcelain status after the read: a change between the two is
  `CORPUS_ROOT_MOVED`. Public readers are zero-arity, so no caller can hand in a SHA.
- **The audit blocks a freeze; it never performs one.** `preFreezeAuditVerdict` appends
  `SWEEP_ZERO_CASES` whenever `generatedCases === 0`, so a check that generated nothing can never
  report `ok`. `readConfirmatoryFreezeAuthority` refuses
  `CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED` unconditionally today, because no human has installed
  `packages/benchmark/authority/confirmatory-freeze-authority.json`.
- **Activation admits, it does not activate.** `admitActivationBinding` hard-wires
  `REQUIRE_HUMAN_POLICY`, takes one argument, and refuses in a fixed order
  (ABSENT → SHAPE_INVALID → DECISION_MISMATCH → WORK_MISMATCH → core's human-gate refusal
  verbatim → GENERATION_UNBOUND). All four `ACTIVATION_GENERATION_KEYS` must be 64 lowercase hex,
  `sourceCommit` 40. `composeActivationRecord` can only emit `NOT_ACTIVATED` or
  `BINDING_ADMITTED_ACT_PENDING` — there is no `ACTIVE` status by design.
- **The `FROZEN_*` rosters in `pre-freeze-audit-rosters.ts` are hand-transcribed, never derived**,
  so they *disagree* when the spec moves: 20 gate IDs, 5 rungs, 6 comparator gates,
  `FROZEN_CONSTANT_SYMBOL_COUNT = 38`, cardinalities `{BENCH-S: 14, CORE-I: 22, CORE-S: 14}`,
  and `FROZEN_NI_TAIL_DIRECTIONS` pinning the acceptance-gate sign inversion.

## Gotchas

- `pnpm --filter @moe/benchmark test` runs `vitest run --root ../.. packages/benchmark/src` — it
  **does not run `campaigns/**`**. And `tsconfig.json` includes only `src/**/*.ts`, so the three
  campaign checkers are typechecked by *no* tsc project in the repo; only the root vitest gate
  (`packages/**/*.test.ts`) ever executes them.
- Every non-test `.ts` here has its one-line `.js` bridge — **except `index.ts`, which has none**
  and needs none, because `exports["."]` points straight at `./src/index.ts`. Internal imports all
  use `./x.js`, so a new module without its bridge breaks the daemon's runtime graph only.
- `tests/security/boundary-roster.security.ts` pins `"packages/benchmark": 5` and names the exact
  five exported `*_LAYER(S)` constants. A sixth reds `pnpm test:security` while the package leg and
  `pnpm typecheck` stay green. The private constants in `gate-family-resolver.ts` and
  `claim-ladder-*.ts` are literally named `LAYER`, which slips under both roster patterns
  (`[A-Z0-9_]+(?:LAYERS|LAYER|BOUNDARIES)`); renaming one to `GATE_FAMILY_LAYER` would red the
  TASK-LV private census (82) in `tests/security/layer-visibility-cases.ts`, which already lists
  this package's `AUTHORITY_LAYER`.
- `src/index-production-surface.test.ts` pins that the 8 `benchmark-record-fixture.ts` exports are
  **absent** from the root surface. `tests/security/runtime-provider-benchmark-cases.ts` imports
  that fixture by deep path instead; adding it to `index.ts` reds both sides.
- `src/benchmark-cell-invariant.test.ts` asserts `cellCount === 127`. Adding or removing a
  projected column moves it; re-measure rather than widening the walker.
- Six suites in `src/` plus both corpus campaigns are `it.skipIf(!isPinnedCorpusAuthority(...))`.
  Without `MOE_PINNED_DOCUMENT_ROOT` pointing at a **clean** checkout holding
  `docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md` (CRLF) and
  `…-moe-rebuild-design.md` (LF), every real-byte arm skips and the file still reports green — the
  first arm always runs and names the closing code, so read it before trusting a pass.
- The version pin is duplicated by hand and **nothing cross-tests it**: `PROJECTED_RECORD_VERSION`
  here vs `PROVIDER_RUN_RECORD_VERSION` in `apps/daemon/src/telemetry/provider-run-contracts.ts`.
  Drift shows up only as `BENCHMARK_RECORD_VERSION_UNRECOGNISED` at runtime.
- `gate-families.ts` makes this package's own `test` script the `benchmark` gate family's leg
  (`packageLeg: "@moe/benchmark"`), so the folder grades a lane that includes itself.
- `admitConfirmatoryFreezeManifest` shells out to real `git` and refuses unless the frozen SHA is
  HEAD over a totally clean tree — unreachable in this shared worktree, which is why the accepted
  arm in `campaigns/task-3a34adca…/freeze-record.test.ts` supplies the horizon explicitly.
- `tests/integration/release/release-version-surfaces.test.ts` pins `packages/benchmark/package.json`
  in its manifest roster.

## Testing

- One file: `pnpm vitest run packages/benchmark/src/pre-freeze-audit.test.ts` (root config,
  `environment: "node"`, `packages/**/*.test.ts`). A campaign file the same way:
  `pnpm vitest run packages/benchmark/campaigns/task-8af4562f…/decision-rule-checker.test.ts`.
- Whole package: `pnpm --filter @moe/benchmark test` (src only) and
  `pnpm --filter @moe/benchmark typecheck`. Full coverage needs the root `pnpm test`, which is the
  only gate that reaches `campaigns/**`.
- Outside coverage: `pnpm test:security` — `boundary-roster`, `layer-visibility`,
  `runtime-provider-benchmark-cases` (registered into `runtime-provider-launch.security.ts`),
  `integrity-hostile-cases`, `scheduler-activation-hostile-cases`, `durable-store-boundary-scenarios`
  — plus `pnpm --filter @moe/daemon test` for the `cutover-activate-*` and `cutover-attempt` arms,
  and `pnpm test:integration` for the release version surfaces.
