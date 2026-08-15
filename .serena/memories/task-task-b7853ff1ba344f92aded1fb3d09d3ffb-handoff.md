# task-b7853ff1ba344f92aded1fb3d09d3ffb — blocked planning handoff

Status: BLOCKED on prerequisite `task-c690a7a0c5a14daaa088acbc32e26815`.

Fresh measurement at committed HEAD `ee284416bfd8d6f4672afb039f455b150d363dbb`:
- `task-f6ef0a45f52c45c7bb54f250170aa223` is DONE and `apps/daemon/src/index.ts:174-175` exports `collectDoctorVersionReport` plus `DoctorVersionReport` from the bare `@moe/daemon` root.
- `task-c690a7a0c5a14daaa088acbc32e26815` is still BLOCKED.
- `git show HEAD:package.json` has no `dependencies` object and no `@moe/daemon` entry.
- The `.` importer in `git show HEAD:pnpm-lock.yaml` has no `@moe/daemon` entry.
- A temporary in-root `.mts` probe importing `collectDoctorVersionReport` from `@moe/daemon` failed with TS2307 (`./node_modules/.bin/tsc`, exit 1) and was deleted in the same command.
- Plain Node `import("@moe/daemon")` failed with `ERR_MODULE_NOT_FOUND` (exit 1).
- Current working tree has foreign WIP in `pnpm-lock.yaml` and `apps/daemon/package.json`; b785's owned paths (`scripts/release/supply-chain.mjs`, `tests/integration/release-supply-chain.test.mjs`) are clean.

The remaining b785 production gap is still real: `scripts/release/supply-chain.mjs` emits the obsolete `missingSymbol: "@moe/daemon.collectDoctorVersionReport"` / `DOCTOR_COMPATIBILITY_UNAVAILABLE` placeholder. However, the task explicitly may not edit package.json/pnpm-lock.yaml and its rail says not to start until c690 is DONE. A plan now would violate the global cross-package dependency rail or require a forbidden deep import.

Re-promote only after c690 is DONE and all three edge checks pass: committed root manifest dependency, committed root lock importer link, and temporary compiled + plain-Node probes from the repository root importing the bare `@moe/daemon` specifier. Then plan only the two owned files, preserving releaseVerdict UNKNOWN and publicationAuthorized false.