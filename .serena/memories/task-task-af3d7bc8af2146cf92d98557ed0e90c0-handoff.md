# task-af3d7bc8 — Windows Job broker protocol — CLOSED DONE, independently gate-verified

Supersedes the old "planning blocked" content in this memory. The dependency that
was absent in 2026-08-09 has landed; do not plan against the stale note.

## Final state (2026-08-11)

SPIDR parent shell, 0 plan steps, no code of its own. Closed DONE by
architect-5aba94da as hop 4 of 4 at 19:52:45. All four children DONE and each
separately QA-reviewed: task-05bf0e0f (3a package/descriptors), task-14ab762d
(3b protocol/framing), task-55e2c4c8 (3c session/core delegation),
task-e18b1284 (3d hardening/acceptance).

## Why QA left no verdict

The wrapper dispatched this to qa-f3560083 with a stale REVIEW snapshot, but the
architect had already moved it to DONE. assignedWorkerId was null; qa_approve and
qa_reject were both unavailable. Evidence went into a task comment instead. See
`gotcha-transit-hop-closes-before-qa-session-runs`.

## Verification actually run (not read off status fields)

Both legs of the task's own verification command exit 0 on this machine:

- `cargo test --locked --manifest-path packages/runner/src/platform/windows/native/Cargo.toml --target-dir dist/windows-job-native -p moe-windows-job-broker` -> exit 0, 89 tests / 0 failed. Suites: containment 7, descriptor_block 8, frame_sweep 38, handle_inheritance 1, idempotence 5, node_loadability 1, session 29.
- `cargo build --locked --release` (same args) -> exit 0.

Use PowerShell with ABSOLUTE `--manifest-path`; the Bash tool's cwd drags
PowerShell's along and a relative path breaks later in a session.

## Measured rail compliance

- Per-file cap: 19 broker production sources, all under 250. Largest frames.rs 223, descriptors.rs 222, session.rs 214, protocol.rs 205, control.rs 204.
- Core delegation: `moe-windows-job-core = { path = ".." }` is a REGULAR dependency in broker/Cargo.toml (deliberately not dev-, documented in the manifest). 15 import sites. Grep for CreateJobObjectW / AssignProcessToJobObject / CreateProcessW / ResumeThread / TerminateJobObject / QueryInformationJobObject over broker/src/*.rs hits ONLY doc comments naming what is absent — zero restated syscalls.
- Artifacts: 47 tracked files under native/, zero target/ .exe .pdb .rlib. dist/ ignored at repo root (.gitignore:4); native/.gitignore adds crate-local `target/` because the root rule does NOT cover it — a bare `cargo build` without --target-dir there would commit artifacts.

## Layout for whoever composes this next

packages/runner/src/platform/windows/native/ is the core crate (job.rs,
process.rs, lifecycle.rs, unwind.rs, handle.rs, spec.rs, win32/*). Its
`broker/` subdir is the helper binary: protocol.rs, frames.rs, control.rs,
status.rs, descriptors.rs, launch.rs, session.rs, settle.rs, watch.rs,
completion.rs, verify.rs, refusal.rs, boundary.rs, payload.rs, diagnostics.rs,
main.rs, lib.rs, plus src/bin/{handle_probe,detached_spawner}.rs as real child
processes for the inheritance and containment tests.

Consumer edge is task-4d1f8ba54cb6476c930c46b413f882aa (Windows Job Object
provider process boundary), WORKING — its plan composes this broker rather than
reimplementing Job Objects in Node. task-acf73253 (Windows Claude launch
wrapper) stays BLOCKED behind it.
