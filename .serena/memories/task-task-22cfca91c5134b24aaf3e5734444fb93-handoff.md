# Portability shadow gate planning handoff (2026-08-15)

## Outcome
Reclaimed after a human scope amendment for root `package.json`, but reported BLOCKED after current board remeasurement. No acceptance plan was submitted.

## Current prerequisite truth
Five formerly missing capabilities are now DONE:
- `task-2159fa19` Codex public runtime surface
- `task-159be643` production Streamable HTTP host
- `task-69d32b1d` legacy decoder + shadow projection
- `task-9fff3d42` shipped JetBrains host
- `task-45d12ec` macOS observation boundary

Two acceptance prerequisites remain open:
- `task-01c5f96ec1e247dc846fd628c929974a` real Linux/macOS effect evidence is PLANNING.
- `task-6cbff01023b14b26a78fc5e3eb1dd8a9` durable provider consumer is BLOCKED.

The first GitHub cross-host run (31900708118, commit 5c40d38) is valuable but red on both ubuntu and macOS. It exposed non-Windows broker-test assumptions, a real macOS symlink containment defect, Windows-path-vocabulary tests on POSIX, and four runner suites failing at import time. This is evidence to repair, not a PASS claim.

## Resume gate
Resume only after both 01c5 and 6cb are DONE, then re-probe their committed production/evidence surfaces. The amendment still permits root `package.json` solely for a real `test:migration` script; it must execute a nonempty migration/import shadow lane, never alias integration or pass zero cases. Then plan frozen-snapshot comparisons bound to one commit across provider, transport, OS, JetBrains, and importer subjects.

Do not use UNKNOWN rows to certify an absent/unaccepted subject, off-host fixtures as host evidence, synthesized legacy authority, or fake IDE packaging.