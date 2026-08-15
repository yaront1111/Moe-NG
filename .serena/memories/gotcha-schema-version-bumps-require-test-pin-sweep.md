# Schema-version bumps require a repo pin sweep

Before planning a store schema-version bump, sweep all package tests for current `userVersion`, `PRAGMA user_version`, and manifest-version literals—not only migration tests. A full owned-package gate cannot baseline-excuse stale pins outside a narrow task pathspec.

At HEAD `6ca5da0`, schema v5 task `task-d20ffd0775b4420bb2318c79019b4127` was blocked because its six-path rail excluded exactly three clean tests that must change:
- `packages/store/src/sqlite-event-store-core.test.ts:26`: fresh health expected v4, must be v5.
- `packages/store/src/command-decision-integrity.test.ts:175,184`: v1-chain health/PRAGMA expected v4, must be v5.
- `packages/store/src/store-project-and-schema-contract.test.ts:65,86`: v5 is used as the too-new fixture and must become v6.

A full `rg 'userVersion|PRAGMA user_version|moe-sqlite-schema' packages/store/src` found no other current-version pins outside the intended six paths plus these three; frozen v1/v2 literals remain intentional. The viable scope is nine files, under Moe's ten-file cap.