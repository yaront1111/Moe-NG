# Decision: Windows provider containment uses a Rust Job core plus crash-contained broker

For the per-run Windows provider process boundary, use three sequential layers:

1. version-pinned Rust/`windows-sys` Job lifecycle core;
2. out-of-process Rust broker with a bounded six-pipe Node protocol;
3. internal TypeScript validation/fail-closed facade and final process-tree smoke.

This SPIDR split is required by distinct security responsibilities and <=60-minute task sizing, not task-level LOC.

## Why Rust broker

- Node 24.16 has no public per-run Job Object / suspended-create API.
- Taskkill and PID enumeration cannot prove descendants dead after the root exits.
- Koffi would put handwritten pointer/struct mistakes inside the daemon and makes wait/read scheduling depend on FFI worker capacity.
- A Node-API addon is viable but couples the boundary to Node ABI/build plumbing and makes async stdio/cleanup larger inside the daemon.
- An out-of-process Rust helper has no Node ABI, isolates native faults, and owns the sole Job handle; helper death therefore closes the last handle and invokes `KILL_ON_JOB_CLOSE`.
- Fresh Windows x64 probes established rustc/cargo 1.96.0 plus `windows-sys = =0.61.2` compile/run on the project host.

Pin `rust-toolchain.toml`, exact `windows-sys = 0.61.2`, and committed Cargo.lock; run Cargo with `--locked` and `--target-dir dist/windows-job-native` so no generated native artifact is committed.

## Crash-atomic assignment while preserving the assign failure arm

Traditional CreateProcess(CREATE_SUSPENDED) -> AssignProcessToJobObject leaves an orphaned suspended child if the launcher crashes between calls. On Windows 10 / Server 2016+, put the Job into `PROC_THREAD_ATTRIBUTE_JOB_LIST` so membership happens atomically during CreateProcess, still with CREATE_SUSPENDED. Then explicitly call AssignProcessToJobObject against that same Job, query membership/identity, and resume only after all succeed. A host probe confirmed the explicit same-Job assignment succeeds, so the design keeps a distinct injected JOB_ASSIGN_FAILED arm without accepting the crash window.

Set queried Job limit flags to exactly `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; never set BREAKAWAY_OK or SILENT_BREAKAWAY_OK. Use `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` so provider inheritance is explicit.

## Broker pipes (freshly proven on Node 24.16 / Rust MSVC)

- fd0: bounded launch/CANCEL control; EOF cancels.
- fd1: bounded status/result frames.
- fd2: bounded non-authoritative diagnostics.
- fd3/fd4/fd5: raw provider stdin/stdout/stderr.

A real probe confirmed Rust `_get_osfhandle(3..5)` receives valid inheritable `FILE_TYPE_PIPE` handles from Node `child_process.spawn(...stdio:[six pipes])`. Duplicate only fd3..5 into provider-owned inheritable handles; verify pipe type and exclude control, status, diagnostic, Job, process, thread, and ambient handles from the provider HANDLE_LIST.

## Proof semantics

Keep original process/Job handles; never reopen by PID for authority. Process identity is PID + creation time + final image path.

On controlled cancel/timeout/error after membership: TerminateJobObject -> await root -> query Job ActiveProcesses until exactly zero -> await provider stdio EOF -> close handles in reverse acquisition order. Preserve the first operational failure and append cleanup failures deterministically.

Last-handle close is crash safety, not ordinary proof. Do not claim tree death after closing the Job, because the query handle is gone.

Source anchors:
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
- https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
- https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject
- https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812
