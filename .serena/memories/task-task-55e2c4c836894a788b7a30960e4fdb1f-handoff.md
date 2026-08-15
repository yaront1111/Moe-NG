# task-55e2c4c8 (Broker session 3c) — DONE, in REVIEW

worker-767ae903, 2026-08-10. Commit `2de3a08`, 10 files, +2145/-37.
Gate `cargo test --locked --manifest-path packages/runner/src/platform/windows/native/Cargo.toml
--target-dir dist/windows-job-native -p moe-windows-job-broker && cargo build --locked --release ...`
exit 0. 77 tests (baseline 48, +29 new in tests/session.rs).

## THE ONE THING TO READ IF YOU READ NOTHING ELSE

`take_instruction` in `watch.rs` **BLOCKS on a real Win32 pipe**. `ByteChannel::read` is
synchronous; against a parent that sends LAUNCH then holds fd0 open and silent, the loop parks in
the control read after the first 50ms slice, and a child that exits meanwhile is not observed until
the parent writes or closes.

**No test can see this.** The scripted channel returns from every read immediately, so the suite
exercises an interleaving a real pipe does not produce. A green suite is not evidence here.

Not a live regression: the only real-parent path (tests/node_loadability.rs) sends nothing and takes
`Outcome::NoInstruction` without entering the loop. The fix is an I/O-model change — overlapped I/O
on fd0, a reader thread, or gating on `PeekNamedPipe`. Reversing the order does NOT help: waiting
the full timeout before reading fd0 makes CANCEL cost a whole timeout. Documented in watch.rs's
module docs. Belongs to `task-e18b1284` or a follow-up.

## What landed (broker/src/, all under the 250 cap)
- `session.rs` 214 — vocabulary is in completion.rs; this holds the launch sequence and the single
  outbound emission path (`publish`). Every refusal goes through one function.
- `watch.rs` 148 — the run loop: WHY a run ended.
- `settle.rs` 123 — the four completion preconditions: WHAT was observed.
- `launch.rs` 167 — LaunchRequest -> owned UTF-16 buffers -> `ProcessSpec`.
- `completion.rs` 167 — `Precondition`, `Unobserved`, `Completion`, `Stopped`, `Outcome`.
- `boundary.rs` 173 (+83) and `main.rs` 154, `lib.rs` 111, `Cargo.toml`, `tests/session.rs` 1123.

## Four things a reviewer will ask about

1. **`Outcome::NoInstruction` exists to keep fd1 clean.** main.rs prints `descriptors ready 6 of 6`
   as ASCII on fd1, and 3a's node_loadability.rs asserts it — but fd1 is also the binary frame
   channel. fd0 ending BEFORE any launch is not a refusal (nobody violated anything, and the peer
   that would read a REFUSED frame is the one that just closed), so that path writes NO frame. The
   ASCII line is emitted only there. **node_loadability.rs passes UNCHANGED**; I edited no test of
   3a's.
2. **The session can never emit `Completed::Unknown`.** COMPLETED and UNKNOWN are alternatives per
   DoD 3, so emitting COMPLETED requires a known exit. status.rs keeps the variant representable
   (3b's surface, covered by frame_sweep); this session simply never reaches it. Deliberate.
3. **Two forced out-of-plan edits**, both disclosed in step 7's note:
   `PipeChannel` in boundary.rs (the crate ships NO ByteChannel impl — both existing ones are test
   doubles — and boundary.rs is the designated unsafe site), and the `Win32_System_IO` feature.
   Cargo.lock unchanged.
4. **`ShutdownSignal`** is new one-method surface. Not a Win32 call table; DoD 5's helper-shutdown
   path is not triggerable without it. Polled once per turn so a stop cannot land between the
   terminate and the reap — that keeps concurrency 3d's question.

## Gotchas this task proved on the board
- `mem:gotcha-broker-syscall-grep-matches-comments` — the DoD 2 grep returns 5 hits, all comments.
- `mem:gotcha-readfile-broken-pipe-is-eof-not-failure` — without the ERROR_BROKEN_PIPE mapping,
  fd0 EOF is unreachable in production while every test reaches it.
- `mem:gotcha-windows-sys-readfile-gated-on-system-io` — ReadFile/WriteFile live in
  Storage::FileSystem but are gated on `Win32_System_IO`; the error names the module, not the
  feature.
- **DoD 6 is enforced by the type system, not by a test.** Writing the raw-query mutation fails to
  compile: `error[E0624]: method 'process_handle' is private`. The core keeps it `pub(crate)`, so
  the broker has no handle to query with.

## Verification notes for QA
- Per-file cap: hand-measure with `grep -c ''`. Max in the crate is frames.rs 223 (pre-existing).
- Drill evidence is in the step-8 note: 7 drills, each reddening a NAMED assertion. Drill (d) is the
  sharpest — terminating twice on CANCEL reddens EXACTLY ONE test and leaves the other four
  termination paths green, proving the five call-count assertions are independent.
- A drill corrected a comment of mine in settle.rs that stated its reason backwards (the
  short-circuit direction). Executable lines unchanged.

Related: `mem:decision-broker-crate-seam-as-landed`,
`mem:gotcha-cargo-test-multi-target-aborts-after-first-red`,
`mem:gotcha-nested-cargo-build-deadlocks-on-target-dir`,
`mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.
