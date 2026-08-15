# QA verdict: broker package + CRT descriptors + non-inheritance proof — APPROVED

Reviewed by qa-f3560083, 2026-08-10. Task task-05bf0e0f (SPIDR 3a of 4).

## What I re-ran myself (not trusted from the worker's summary)
- Task command, both legs, verbatim: `cargo test --locked --manifest-path
  packages/runner/src/platform/windows/native/Cargo.toml --target-dir dist/windows-job-native
  -p moe-windows-job-broker` -> **10 passed, 0 failed, 0 IGNORED**
  (descriptor_block 8, handle_inheritance 1, node_loadability 1, 3 unit targets 0, doc 0).
  Matching `cargo build --locked --release ...` exit 0.
- CORE unchanged and still green: job_sweep 7, process_sweep 28, real_windows 2, 0 ignored.
- Base-ref diff `6de0ad02..HEAD -- .../native/`: 12 files, +1784/-0. Only pre-existing files
  touched are `Cargo.toml` (+15, the `[workspace] members = ["broker"]` table) and
  `Cargo.lock` (+8, one `[[package]]` entry, forced by `--locked`). `src/` and `tests/` under
  native/ are untouched — DoD 1's "no core source file moved" holds.
- `git ls-files` under native/: no binary, no transcript, no smoke evidence.
  `git check-ignore` confirms `dist/` and the crate's `target/` are ignored, including the
  nested `dist/windows-job-native/node-loadability` tree node_loadability builds into.
- Per-file cap: descriptors 222, verify 157, handle_probe 127, boundary 94, main 85, lib 51.
  All `grep -c ''`, all <=250.

## Independent mutation drills (epic rail 6) — I ran my own, did not take the worker's
1. **Pipe check.** `verify.rs:148` `if kind != PIPE_FILE_TYPE` -> `if kind == u32::MAX`.
   RED: `a_handle_that_is_not_a_pipe_is_refused_by_its_slot_index` and
   `the_table_plus_the_type_check_reach_every_reason_in_the_vocabulary`, 6 passed / 2 failed.
2. **The DoD-5 detector, the one that matters.** In `handle_inheritance.rs` I replaced
   `forbidden[0]` with `allowed_values[0]` — a handle the child GENUINELY inherited.
   RED: `a handle the provider must not have reached the child`. That is the proof the
   absence check is not stuck-at-absent; the child really can say `present` and the assertion
   really catches it.
   Restored both; `git diff` over the owned paths empty; full gate re-run green afterwards.

## Why it cleared the bar rather than merely passing
- Every refusal test asserts the **exact reason AND the slot index**, never `is_err()`.
- The hostile-block table's 9 member NAMES are hand-written in a separate test, so a
  generator that shrank could not sweep vacuously (`mem:qa-generated-table-cannot-police-its-own-generator`).
- `DescriptorReason::ALL` is a fixed-length array; a new variant is a compile error until a
  case produces it. Closed vocabulary with a forcing function.
- node_loadability has no `#[ignore]`, no cfg gate, and every prerequisite branch PANICS —
  missing node, wrong version, wrong platform, failed release build. It asserts the
  broker's printed inventory line, so an exit-0-without-checking binary cannot pass.
- `HANDLE_VALUE_FLOOR = 4096` is **asserted, not assumed**, which closes the handle-value
  collision hole (`mem:gotcha-handle-value-collision-makes-absence-ambiguous`).
- Refusals carry reason + Win32 code only. `Display` is hand-written so it cannot grow a
  handle field; the probe prints `{:?}` of the reason alone; main.rs prints one ASCII line
  with no handle, path, argv or env. Rail 3 clean.
- No Job or process syscall restated: boundary.rs is GetStartupInfoW / GetFileType /
  CloseHandle / GetLastError; the probe is GetHandleInformation. Everything Job-shaped comes
  from `moe-windows-job-core`, and the inheritance test launches through the real
  `Job::create` + `ContainedProcess::create` path.
- main.rs carries NO framing, vocabulary, session or CANCEL, not even a placeholder — 3b/3c/3d
  have a clean seam.

## Two deviations I accepted, both disclosed and both correct
- `src/lib.rs` was not in the plan. Forced: `tests/` cannot link a binary-only crate. main.rs
  consumes it, so it is a real internal consumer edge, not a shim.
- The probe's forbidden values arrive on **stdin**, not argv as the plan wrote. The child's own
  process and thread handles are created BY `CreateProcessW`, so no ordering puts them on a
  command line. The plan's scheme is impossible; the substitute is sound.
