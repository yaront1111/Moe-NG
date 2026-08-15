# task-a02496 (Win32 Job membership, SPIDR child 2 of 2) — SPLIT into 2a + 2b

**Outcome: no plan submitted. Task is now a SPIDR parent shell (BLOCKED).**
Architect architect-5aba94da, 2026-08-09, HEAD 025dc49. Human confirmed the split
in the REPL before either child was created.

## Children

| id | role | status | files |
|---|---|---|---|
| `task-885a46e9fb274a94b12faa826ba580dc` | 2a — suspended process, atomic JOB_LIST membership, assignment proof, resume | PLANNING, order 74.1 | 8 |
| `task-af99cf146c9b4f4d99b49d8c00caed63` | 2b — lifecycle, reverse-order unwind, real-Windows acceptance | BLOCKED behind 2a, order 74.2 | 6 |

Split was on **plan shape**, never on lines (epic rail 5). The single plan
re-derived to **10 distinct affectedFiles and 12 steps — both exactly at the
daemon hard ceiling**.

## Three things measured on disk that the task description got wrong

Recorded because the description read as authoritative and was not. See
`mem:gotcha-closed-enum-ALL-array-breaks-sibling-sweep`.

1. **`grep -c '' src/win32.rs` => 252.** Child 1's win32.rs already EXCEEDED
   task-a02496's own DoD item 6 (`<=250 physical lines`) on arrival. Its own
   `lib.rs:31` says "win32.rs sits at 246 of its 250-line target" — false at
   HEAD. So win32.rs could not absorb the process arms; it needs splitting
   first, which neither the parent nor child 1 budgeted. The chosen split:
   extract the `#[cfg(windows)] mod system` block (win32.rs:134-252) verbatim
   into `src/system_job.rs`, leaving ~135 lines of vocabulary + trait.
2. **`tests/job_sweep.rs:169` asserts `assert_eq!(produced, all)`** where `all`
   is built from `NativeOp::ALL`, declared `pub const ALL: [NativeOp; 6]`.
   Adding any process-side variant breaks that currently-passing test. Child 1's
   test file is a file this work must edit — the 10th file, unnamed in the
   description. Must be repaired WITHOUT softening it to a subset test.
3. **The task description's file list was incomplete**, naming 6 files
   (process.rs, lifecycle.rs, lib.rs, win32.rs, process_sweep.rs,
   real_windows.rs). Real count is 10: + Cargo.toml, system_job.rs,
   system_process.rs, job_sweep.rs.

## Verified good (do not re-check from scratch)

- Child 1 is genuinely landed: 9 files tracked at HEAD under
  `packages/runner/src/platform/windows`, `git status --porcelain` over that
  path empty, `cargo test --locked -p moe-windows-job-core` => **7 passed, 0
  failed**.
- All 19 windows-sys symbols present in the pinned `=0.61.2`.
  `CreateProcessW`, `PROC_THREAD_ATTRIBUTE_JOB_LIST`,
  `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, `InitializeProcThreadAttributeList`,
  `UpdateProcThreadAttribute`, `DeleteProcThreadAttributeList`, `ResumeThread`,
  `GetProcessId`, `GetProcessTimes`, `QueryFullProcessImageNameW`,
  `WaitForSingleObject`, `GetExitCodeProcess`, `TerminateProcess`,
  `STARTUPINFOEXW`, `EXTENDED_STARTUPINFO_PRESENT`, `CREATE_SUSPENDED`,
  `CREATE_UNICODE_ENVIRONMENT` are all in
  `Windows/Win32/System/Threading/mod.rs` and need the **`Win32_System_Threading`
  feature added to Cargo.toml** (child 1 omitted it deliberately).
  `AssignProcessToJobObject` and `IsProcessInJob` are in
  `Windows/Win32/System/JobObjects/mod.rs` and are **already reachable** under
  the current feature set — no manifest change needed for those two.
- The governor's unblock note claimed an adversarial audit alleged "three
  independent hard-compile failures against the landed crate". It does NOT
  reproduce — `cargo check --offline --all-targets` and the full test run are
  both clean on this win32 host. Do not plan around that claim.

## Design decision handed to 2a

Trait impls may live in any module of the defining crate, so
`impl ProcessCalls for SystemWin32` goes in `src/system_process.rs` while
`SystemWin32` stays declared in win32.rs. That is what keeps the process-side
call-table trait in win32.rs (as the description asked) without a 277-line file.

Rejected alternative: a separate `ProcessOp`/`ProcessError` vocabulary to avoid
touching `NativeOp`. Rejected because unwind must report both job ops
(`TerminateJob`, `QueryAccounting`) and process ops in one `Result`, which
forces a union type anyway — two error vocabularies for one crate.

## If you are picking this up

Do not re-plan the shell. Claim 2a. Once both children are DONE, close the shell
via a **REVIEW transit hop** — direct BLOCKED -> DONE is not legal
(`mem:moe-backlog-to-done-transition-blocked` covers the same trap).
