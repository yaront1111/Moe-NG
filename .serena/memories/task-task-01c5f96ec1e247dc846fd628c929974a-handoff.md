# task-01c5f96e cross-host evidence planning handoff (2026-08-15)

## Outcome
Real Linux/macOS CI now exists, but a fresh Clause-2 audit found three prerequisite production/consumer-edge gaps. I created ordered prerequisite tasks, commented the parent, and reported it BLOCKED. No mock-backed evidence plan was submitted.

## Measurements
- Committed/local HEAD moved through `26ac640` / `8d9afb8`; relevant workflow/tests paths were clean.
- `.github/workflows/cross-host.yml` has ubuntu-latest + macos-latest and `fail-fast:false`, but runs only frozen install, typecheck, and root `pnpm test`; no `test:fault`, receipts, uploads, downloads, or aggregation.
- Latest real run 31901640846 reached both hosts but stopped at the same foreign typecheck error: missing `apps/daemon/src/recovery/effect-inventory.js`. Earlier run 31900708118 reached tests and exposed Windows-only assumptions plus a macOS path-realpath defect. These are disclosed baseline evidence, not host effect receipts.
- Public `@moe/runner` root exposes exactly seven boundaries and Linux/macOS observe/classify plus real process/activation/cancellation/crash seams.
- `scripts/release/release-subject.mjs` has five `RELEASE_COMPONENTS` and omits the shipped JetBrains adapter; the integration test independently asserts six. Binding a receipt to the five-component subject is wrong; copying the six-entry list into a test would create duplicate authority.
- `collectDoctorVersionReport` exists at `apps/daemon/src/recovery/doctor-version.node.ts:164`, but a bare `@moe/daemon` probe sees it as undefined.
- Root `package.json` / root importer declare neither `@moe/runner` nor `@moe/daemon`; root bare import fails `ERR_MODULE_NOT_FOUND`. Tests/fault cannot plan a legal bare consumer until this edge lands.
- Existing classifiers judge caller-supplied observations by design. Parent schedules must execute real runner/OS effects and assert their exact outcomes independently; never treat a caller `PROVEN` envelope alone as host proof.

## Created prerequisites
1. `task-ec70ba5b904848b496b9bf5d2c2be92f` — canonical six-component shipped distribution inventory shared by release subject and integration test (3 files).
2. `task-f6ef0a45f52c45c7bb54f250170aa223` — publish existing Node doctor collector/type from bare `@moe/daemon` root (2 files; wait for current foreign daemon-root WIP).
3. `task-c690a7a0c5a14daaa088acbc32e26815` — after doctor publication, add root manifest+lock dependencies and a durable tests/fault bare-root call site (3 files; wait for current foreign lock WIP).

## Resume shape
After all three are DONE, re-probe committed bytes and plan roughly six cohesive files:
- workflow update;
- shared host schedule driver;
- canonical evidence protocol/verifier/aggregator;
- hostile verifier fault test;
- Linux host fault suite;
- macOS host fault suite.

Each real host runs the hand-written seven-boundary x three-schedule set (crash-before, crash-after, cancellation), asserts exact runner and platform code/layer/boundary with positive cardinality, derives host from process/doctor rather than CLI claims, uploads raw+canonical artifacts, and an always-running aggregate job maps only a missing/bad host row to UNKNOWN. Baseline repo red remains visible and path-attributed; focused host gates must be green. Consumer remains `task-22cfca91c5134b24aaf3e5734444fb93`.