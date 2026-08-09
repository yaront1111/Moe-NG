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
//! # Scope and consumer
//!
//! Composed by child 2, task-a02496064e9e4e87a888cc112830d7a4 (suspended
//! process creation, `PROC_THREAD_ATTRIBUTE_JOB_LIST` membership, identity,
//! resume, unwind, real-Windows acceptance). Process creation, assignment and
//! membership are deliberately absent here.
//!
//! Note for that work: `win32.rs` sits at 246 of its 250-line target, so new
//! arms should arrive with a split by responsibility rather than by
//! reformatting. [`NativeOp`] is a closed enum with no catch-all, so adding a
//! variant is a compile error at every match site — the intended forcing
//! function, not an obstacle.

// Modules are private: every item has exactly one public path, re-exported
// below. The sweep's scripted call table lives in tests/ and never reaches this
// surface.
mod handle;
mod job;
mod process;
mod win32;

pub use handle::OwnedHandle;
pub use job::Job;
pub use process::{ContainedProcess, CreatedProcess, ProcessSpec};
pub use win32::{
    NativeError, NativeOp, ProcessCalls, RawHandle, SystemWin32, Win32Calls, ATTRIBUTE_HANDLE_LIST,
    ATTRIBUTE_JOB_LIST, EXPECTED_PRIOR_SUSPEND_COUNT, INHERITED_HANDLE_COUNT,
    REQUIRED_LIMIT_FLAGS,
};
