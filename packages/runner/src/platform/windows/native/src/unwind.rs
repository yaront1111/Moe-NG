//! Reverse-order unwind of a partially constructed contained process.
//!
//! THERE ARE TWO REGIMES AND THE BOUNDARY BETWEEN THEM IS THE MEMBERSHIP PROOF,
//! not the `CreateProcessW` call. Collapsing them into one path is the defect
//! this module exists to prevent, so they are two functions that share no body:
//!
//! * BEFORE membership is proven, a child process exists that the Job may not
//!   contain. Terminating the Job would then be terminating something that does
//!   not hold the child, leaving it running with nothing left to name it. So the
//!   child is terminated and awaited DIRECTLY, through its own handle.
//! * AFTER membership is proven, the Job owns the child. Terminating the Job and
//!   waiting for `ActiveProcesses == 0` is correct AND sufficient -- and it
//!   covers any grandchild the child may already have spawned, which terminating
//!   the one process handle would not.
//!
//! NO CLEANUP OUTCOME IS LAUNDERED. Both steps of each regime are attempted even
//! when the first fails -- stopping early would leak the second -- and each
//! failure surfaces as an error carrying its own `NativeOp`. The FIRST error
//! wins, matching the discipline child 1 established in `handle.rs`. The caller
//! that triggered the unwind keeps the error that caused it: an unwind failure
//! must never replace the reason the run failed.

use crate::job::Job;
use crate::lifecycle::wait_until_job_is_empty;
use crate::win32::{NativeError, NativeOp, ProcessCalls, RawHandle, WaitOutcome, Win32Calls};

/// How long to wait for a directly terminated child to actually exit.
///
/// Bounded rather than `INFINITE`: a terminate that failed leaves a process that
/// may never exit, and an unbounded wait there would hang the caller instead of
/// reporting an uncertain cleanup.
const UNWIND_WAIT_TIMEOUT_MS: u32 = 5_000;

/// PRE-MEMBERSHIP REGIME: terminate the child and await it through its own
/// handle.
///
/// The Job is deliberately NOT touched. At this point nothing has proved the
/// child is inside it, so terminating the Job could return `Ok` while the child
/// keeps running -- an unwind that reports success and leaves a process behind.
pub fn unwind_before_membership<C: ProcessCalls>(
    calls: &C,
    process: RawHandle,
) -> Result<(), NativeError> {
    let terminated = calls.terminate_process(process);
    let awaited = await_exit(calls, process);
    terminated.and(awaited)
}

/// POST-MEMBERSHIP REGIME: terminate the Job and wait for it to empty.
///
/// Reuses child 1's `Job::terminate` and `Job::active_processes` unchanged. The
/// wait is a POLL, not a single sample: `TerminateJobObject` returns before its
/// processes are gone.
pub fn unwind_after_membership<C: Win32Calls>(job: &Job<'_, C>) -> Result<(), NativeError> {
    let terminated = job.terminate();
    let emptied = wait_until_job_is_empty(job);
    terminated.and(emptied)
}

/// Waits for a terminated child and refuses anything short of an observed exit.
///
/// A timeout or `WAIT_ABANDONED` here means the cleanup outcome is UNKNOWN: the
/// process may still be running. That stays uncertain and refuses as
/// [`NativeOp::WaitForProcess`] with code 0 -- child 1's convention for a
/// refusal that is ours rather than the operating system's -- instead of being
/// converted into a success nothing observed.
fn await_exit<C: ProcessCalls>(calls: &C, process: RawHandle) -> Result<(), NativeError> {
    match calls.wait_for_process(process, UNWIND_WAIT_TIMEOUT_MS)? {
        WaitOutcome::Signalled => Ok(()),
        WaitOutcome::TimedOut | WaitOutcome::Abandoned => {
            Err(NativeError::new(NativeOp::WaitForProcess, 0))
        }
    }
}
