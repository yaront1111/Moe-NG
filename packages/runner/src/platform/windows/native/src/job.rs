//! A configured Win32 Job object.
//!
//! SCOPE. This is containment configuration only: create, configure, verify,
//! terminate, count, close. Process creation, `PROC_THREAD_ATTRIBUTE_JOB_LIST`,
//! `AssignProcessToJobObject`, membership, identity and resume live in
//! `process.rs`; wait, exit query and the `ActiveProcesses == 0` poll live in
//! `lifecycle.rs`; the two unwind regimes live in `unwind.rs`. Those modules
//! build on this one and none of them belongs here.

use crate::handle::OwnedHandle;
use crate::win32::{NativeError, NativeOp, RawHandle, Win32Calls, REQUIRED_LIMIT_FLAGS};

/// A Job that has been created, configured, and verified by reading its
/// configuration back.
///
/// A `Job` value cannot exist in an unverified state: [`Job::create`] is the
/// only constructor and it returns `Err` unless the query-back matched. So
/// "configured" is an invariant of the type rather than a step a caller has to
/// remember.
pub struct Job<'c, C: Win32Calls> {
    handle: OwnedHandle<'c, C>,
    calls: &'c C,
}

impl<'c, C: Win32Calls> Job<'c, C> {
    /// Creates an unnamed Job, sets exactly `KILL_ON_JOB_CLOSE`, and refuses
    /// unless reading the flags back returns exactly that.
    ///
    /// If configuration or verification fails, the handle is closed on the way
    /// out by `OwnedHandle`'s drop guard and the FIRST error is what the caller
    /// sees — a cleanup failure must not replace the reason the run failed.
    pub fn create(calls: &'c C) -> Result<Self, NativeError> {
        let raw = calls.create_job_object()?;
        let handle = OwnedHandle::new(raw, calls);
        configure(calls, raw)?;
        Ok(Self { handle, calls })
    }

    /// The Job handle, for the sibling module that must name it: both the
    /// `PROC_THREAD_ATTRIBUTE_JOB_LIST` attribute and `AssignProcessToJobObject`
    /// take it.
    ///
    /// `pub(crate)` for exactly the reason `OwnedHandle::raw` is — handing the
    /// value out of the crate is what would let a second owner close it. A
    /// caller outside the crate can still only pass the `Job` itself, so the
    /// handle it carries is always one this crate verified.
    pub(crate) fn handle(&self) -> RawHandle {
        self.handle.raw()
    }

    /// Terminates every process currently in the Job.
    pub fn terminate(&self) -> Result<(), NativeError> {
        self.calls.terminate_job(self.handle.raw())
    }

    /// Number of processes currently in the Job.
    ///
    /// This is an observation, not a proof of tree death: it is only meaningful
    /// while this handle is open, and it says nothing about processes that have
    /// already left.
    pub fn active_processes(&self) -> Result<u32, NativeError> {
        self.calls.query_active_processes(self.handle.raw())
    }

    /// Closes the Job handle and returns the outcome.
    ///
    /// Closing the LAST handle to a Job configured with `KILL_ON_JOB_CLOSE` is
    /// what makes containment crash-safe. That is a safety net, not evidence:
    /// once the handle is gone there is nothing left to query, so no caller may
    /// read a successful close as proof that the contained processes died.
    pub fn close(self) -> Result<(), NativeError> {
        self.handle.close()
    }
}

/// Sets the limit flags and verifies them by reading them back.
///
/// THE COMPARISON IS EXACT EQUALITY, NEVER A BITWISE-CONTAINS. A contains test
/// (`observed & REQUIRED == REQUIRED`) would accept a Job that ALSO carries
/// `JOB_OBJECT_LIMIT_BREAKAWAY_OK` or `SILENT_BREAKAWAY_OK` — the exact
/// configuration that lets a child process leave the Job and survive it, which
/// defeats the whole primitive. Equality is the only form that can reject it.
fn configure<C: Win32Calls>(calls: &C, job: RawHandle) -> Result<(), NativeError> {
    calls.set_limit_flags(job, REQUIRED_LIMIT_FLAGS)?;
    let observed = calls.query_limit_flags(job)?;
    if observed != REQUIRED_LIMIT_FLAGS {
        // Code 0: this refusal is ours, not the operating system's. Nothing
        // failed at the Win32 boundary — the Job simply is not what we set, and
        // proceeding with it would hand out unverified containment.
        return Err(NativeError::new(NativeOp::QueryInformation, 0));
    }
    Ok(())
}
