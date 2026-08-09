//! Win32 Job object primitive: create a Job, configure it to kill its contents
//! when the last handle closes, verify that configuration by reading it back,
//! and own the handle so it closes exactly once.
//!
//! This crate is a PRIMITIVE, not authority. It holds no policy, grants no
//! capability, and produces no evidence claim. It is Windows-only by
//! construction and has no non-Windows fallback: a fallback would be untested
//! authority on a host that cannot exercise it.
//!
//! # Two decisions a later reader would otherwise re-litigate
//!
//! **Why a call table instead of `#[cfg(test)]` shims.** Every Win32 arm has to
//! be independently failure-injectable, and the sweep has to prove WHICH arm
//! refused — not merely that something refused. Conditional compilation would
//! mean the tested code is not the shipped code. [`Win32Calls`] is that seam,
//! and [`SystemWin32`] is the only implementation that ships.
//!
//! **Why an explicit close exists alongside `Drop`.** `Drop` cannot return a
//! `Result`, so a Drop-only design must silently discard a failed close —
//! converting an UNKNOWN cleanup outcome into an implicit success. The
//! consuming [`OwnedHandle::close`] is therefore the supported path, and `Drop`
//! is only a leak guard.
//!
//! # Scope
//!
//! Job configuration and verification; suspended process creation with atomic
//! `PROC_THREAD_ATTRIBUTE_JOB_LIST` membership, the explicit assignment
//! confirmation, the membership and live-handle identity proofs and resume; and
//! teardown — wait, exit query, terminate, the `ActiveProcesses == 0` query and
//! the two-regime reverse-order unwind.
//!
//! A GREEN SWEEP PROVES LESS THAN IT LOOKS, AND THAT IS NOT THEORETICAL. The
//! sweeps in tests/ drive a scripted call table, so they prove the production
//! logic and prove the windows-sys implementations COMPILE — never that they
//! work. tests/real_windows.rs is the only thing that reaches the kernel, and
//! the first time it ran it caught `SetInformationJobObject` rejecting
//! `KILL_ON_JOB_CLOSE` through the basic limit class with
//! ERROR_INVALID_PARAMETER, a defect two green suites and a QA pass had already
//! carried. Keep that file running.
//!
//! Note for later work: every source is held to 250 physical lines, so new arms
//! arrive with a split by responsibility rather than by reformatting — that is
//! why `win32/` holds one file per seam. [`NativeOp`] is a closed enum with no
//! catch-all, so adding a variant is a compile error at every match site AND at
//! [`NativeOp::ALL`], whose length is part of its type. That is the intended
//! forcing function, not an obstacle: both sweeps in tests/ then fail until the
//! new variant has a case.

// Modules are private: every item has exactly one public path, re-exported
// below. The sweep's scripted call table lives in tests/ and never reaches this
// surface.
mod handle;
mod job;
mod lifecycle;
mod process;
mod spec;
mod unwind;
mod win32;

pub use handle::OwnedHandle;
pub use job::Job;
pub use lifecycle::{
    query_exit_status, query_identity, terminate_process, wait_for_process,
    wait_until_job_is_empty, ExitCode, ExitStatus, Identity, SignalledProof, UnknownExit, Waited,
};
pub use process::ContainedProcess;
pub use spec::{CreatedProcess, ProcessSpec};
pub use unwind::{unwind_after_membership, unwind_before_membership};
pub use win32::{
    NativeError, NativeOp, ProcessCalls, RawHandle, SystemWin32, WaitOutcome, Win32Calls,
    ATTRIBUTE_HANDLE_LIST, ATTRIBUTE_JOB_LIST, EXPECTED_PRIOR_SUSPEND_COUNT,
    INHERITED_HANDLE_COUNT, REQUIRED_LIMIT_FLAGS,
};
