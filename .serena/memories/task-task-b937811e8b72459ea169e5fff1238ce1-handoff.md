# Benchmark telemetry harness — architect handoff

## Outcome
Blocked `task-b937811e8b72459ea169e5fff1238ce1` after current-byte audit at HEAD `2b15b8f01ee0b4a52deb6bb78e510e0ca60d9c66`. A `packages/benchmark/**`-only implementation would invent missing production observations, and the current verification command is vacuous.

## Spec measurement
Pinned file `D:/projexts/moes/docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md` re-hashed to exactly `A62B90436CC0B911FB28526AF7B7E0F2D1370F6F93DB91C26077F6E2956A589C`.
Key requirements:
- per-run stop reason, token/step counts, infra class, timestamps, model snapshot, config hashes (spec 327–329, 488–494);
- model/harness/config triple plus model ID, snapshot/build and effort;
- distinct trigger→render system latency and render→commit response time, away/focus separately;
- closed censoring classes: wall-cap administrative censoring, token/step competing event, product cap, agent failure, infra failure/UNKNOWN;
- distinct cost-class and price-basis enums; UNKNOWN/PARTIAL never become zero/PASS or cross-basis comparison;
- ProjectConfigurationManifest/settingsDigest/orchestration SHA and reproducibility identities.
Corpus generation, constants, statistics, competitors, gate verdicts and campaign execution remain downstream/out of scope.

## Current production
Present:
- @moe/runner root exposes `buildEvidenceReceipt`, `receiptDigestInput`, `runVerifierProcess`, Claude runtime observation and launcher surfaces.
- evidence/launch records bind source/runtime/effect/stream/exit/timestamps.
- `apps/control-room/src/performance/timing.ts` has a pure four-phase `evaluateTiming` / `SurfaceTimingReceipt`.

Missing/unfit:
- no selected model ID, model snapshot/build, reasoning effort, provider token/step/cost, stop/infra class or achieved concurrency record;
- scheduler budget measurement source/coverage authority exists internally but is not root-exported and has no production provider emitter;
- no `ProjectConfigurationManifest`, `settingsDigest`, config digest or orchestration SHA symbol;
- daemon stream exposes only `committedAt`; control-room `evaluateTiming` has zero production call sites and consumes caller-supplied pairs;
- no durable/live trigger, client receipt, render, human commit, focus/away, demanded decision, free-interaction, attention-switch or recovery-burden observation;
- named production surfaces such as buildEvidenceReceipt/launchClaude/normalizeUsageMeasurement are not composed into daemon/provider runtime;
- `packages/benchmark` does not exist. `pnpm --filter @moe/benchmark test` prints “No projects matched” and exits 0; require nonzero package/test execution after creation.
- New workspace package also needs `pnpm-lock.yaml` importer ownership, absent from current `packages/benchmark/**` scope.

## Prerequisites created
1. `task-159f4c21ef9149e8a65f24735c9c1475` — Provider run identity and usage telemetry.
2. `task-5dfc98fc3e7f4035a8012bd9ba032de3` — Path-neutral project configuration manifest.
3. `task-1eeb2dccce204671b442704cd60b38ad` — Live command timing and decision-effort instrumentation.

Comment `comment-c6dc9878a00248988ed31bb3c0db70bc` records the audit. Task reported BLOCKED; re-promote only after all three land, re-measure their public consumer edges, and widen ownership for the lockfile importer.

## Later plan shape
Once prerequisites exist, the minimal benchmark package is likely package.json, tsconfig.json, src/index.ts (+ LF index.js), focused contract/codec and record/manifest modules plus focused tests, all production files <=250 target/<400 hard split. Tests must assert exact UNKNOWN code/layer, nonzero enum/case coverage, receipt/config tamper, k vs k_conc, price basis vs cost class, product cap vs censoring, token cap vs wall cap, and PARTIAL/cross-basis fail-closed behavior. Do not add corpus/campaign bytes.