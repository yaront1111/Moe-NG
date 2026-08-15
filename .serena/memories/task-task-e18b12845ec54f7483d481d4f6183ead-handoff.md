# task-e18b1284 (Broker hardening 3d) — DONE, in REVIEW

worker-27fddcb2, 2026-08-11. Commit `8ba1d2c`, 3 files, +1272/-2.
Gate: `cargo test --locked --manifest-path packages/runner/src/platform/windows/native/Cargo.toml
--target-dir dist/windows-job-native -p moe-windows-job-broker && cargo build --locked --release ...`
exit 0. 89 tests (3c baseline 77, +12 mine), zero warnings.

LAST of task-af3d7bc8's four SPIDR children.

## THE ONE THING TO READ IF YOU READ NOTHING ELSE

**A drill that hangs is not a drill that passes, and it is not a drill that fails.**
Removing the harness's `child.kill` from tests/containment.rs left the broker alive, so
Node stayed alive awaiting its exit, so my unbounded `wait_with_output` blocked. The run
was killed at 600s having produced no verdict. A hang is the only failure mode that
never names itself and never goes red — it just eats the session.

Fixed with a bounded `await_harness`; the same drill now fails by name in 20.15s. **Every
out-of-process drill needs a bound on every wait, or a broken guard is indistinguishable
from a slow one.** Also: an externally SIGKILLed test leaves the `Reaper` unrun, so its
workspace survives — no destructor survives a kill, and that stale dir is not a defect.

## What landed

- `broker/tests/idempotence.rs` 707 (pre-existing from a dead session; I verified, removed
  an unused `NativeOp` import, drilled it). 450 rounds, 3 timeout biases.
- `broker/src/bin/detached_spawner.rs` 185 — the only NEW production file, under the 250 cap.
- `broker/tests/containment.rs` 1085 — DoD 2, 3 and 4.

## Things a reviewer will ask about

1. **`idempotence.rs` was already committed — inside a FOREIGN commit.** `08b7028`
   (`feat(task-584f4af0...)`) swept it up. Not mine to repair (global rail 5 clause 1).
   Review by base-ref diff, not by looking for a commit bearing this task's id.
2. **Why the rendezvous is inside `wait_for_process` and not the fd0 read.** `watch` checks
   `remaining == 0` BEFORE reading fd0, so a timeout-biased round would skip a rendezvous
   the peers were already blocked on and hang. The first wait is the only point the loop
   always reaches. A `Barrier` was rejected: no timeout, so a pre-release failure deadlocks
   instead of failing.
3. **Why `append` is refused after `end`.** A parent that closed its write end cannot then
   write. Without that refusal the reader always drains pending bytes before honouring EOF
   and CANCEL wins every round — a fixed answer dressed as a race.
4. **The suite finishes in ~0.15s and that is real.** Node startup here is 27-38ms measured.
   The drill taking the full 20s bound to fail is what proves the machinery runs.
5. **`OpenProcess` is the ONE raw Win32 call, and it is in a test.** The core has no
   open-by-PID on purpose (lifecycle.rs: a PID is reused). Every judgement delegates to
   `SystemWin32`: `creation_time`, `exit_code`, `terminate_process`, `close_handle`.
6. **`STILL_ACTIVE = 259`** — a process exiting with literal 259 would read as Running. No
   binary here can produce it, and the direction is fail-closed (can only make a test fail).

## Gotchas this task proved

- `mem:gotcha-out-of-process-drill-hangs-instead-of-failing`
- `mem:gotcha-detached-grandchild-needs-a-premise-guard` — a containment proof is only
  evidence if an ordinary kill would have MISSED the grandchild. Assert that separately.
- `mem:gotcha-powershell-cwd-syncs-to-the-bash-tool-cwd` — a Bash `cd` silently moved the
  PowerShell cwd and broke every relative `--manifest-path`.

## Drill results (all restored byte-exact, hash-verified)

| target | mutation | red test |
|---|---|---|
| settle.rs | double `unwind_after_membership` | idempotence.rs:610 `terminated 2 times` |
| settle.rs | ordinary completion skips `wait_until_job_is_empty` | containment.rs:380 `left: []` |
| watch.rs | control decoder reads `provider_out` | `Ran(Cancelled, ...)` — deputy confused |
| descriptors.rs | `count < 1` | `every_hostile_block_refuses_with_its_own_reason_and_slot` |
| frames.rs | version check `if false` | 4 reds, incl. sweep missing `VersionMismatch` |
| completion.rs | Cancelled not a termination | `cancel_on_fd0_terminates_and_reaps_exactly_once` |

Hashes: descriptors b945cf8c, frames d325b031, completion 3e27e104, watch 69fe1451,
settle 0b4086a2 — identical before and after every drill.

## Consumer edge

`task-4d1f8ba54cb6476c930c46b413f882aa` ("Windows Job Object provider process boundary",
BLOCKED) recorded per pure-package rail clause 1(a). Re-measured: still NO Node-side
consumer on disk. containment.rs contains a working six-pipe drive of the broker they can
use as a reference — it is a test, so it does NOT satisfy clause 1(a).

Related: `mem:task-task-55e2c4c836894a788b7a30960e4fdb1f-handoff`,
`mem:decision-broker-crate-seam-as-landed`,
`mem:gotcha-broker-syscall-grep-matches-comments`,
`mem:gotcha-completion-hook-commits-whole-tree`.
