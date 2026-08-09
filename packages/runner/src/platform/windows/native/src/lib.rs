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
//! Suspended process creation, atomic `PROC_THREAD_ATTRIBUTE_JOB_LIST`
//! membership, the explicit assignment confirmation, the membership and
//! live-handle identity proofs, and resume were added by
//! task-885a46e9fb274a94b12faa826ba580dc. Teardown is NOT here: wait, exit
//! query, terminate, the `ActiveProcesses == 0` query, the reverse-order unwind
//! protocol and the real-Windows acceptance test belong to sibling
//! task-af99cf146c9b4f4d99b49d8c00caed63.
//!
//! A GREEN SUITE PROVES LESS THAN IT LOOKS. Everything here runs through the
//! scripted call tables in tests/, so the suite proves the real windows-sys
//! implementations COMPILE — never that they work. Only that sibling's
//! real-Windows test can close that seam.
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
