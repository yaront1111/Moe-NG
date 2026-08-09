//! The process-construction seam and the constants it is configured with.
//!
//! Split out of `win32.rs` by RESPONSIBILITY, not by reformatting: that file
//! owns the error vocabulary and the Job seam, this one owns the construction
//! seam. Both are re-exported from `win32`, so every item still has exactly one
//! public path.

use super::{NativeError, RawHandle};
use crate::spec::{CreatedProcess, ProcessSpec};

/// `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
///
/// Carrying the Job on the creation attribute list is what makes membership
/// ATOMIC with creation: the child is already inside the Job before its first
/// instruction runs. `AssignProcessToJobObject` alone leaves a window in which
/// this process can die between create and assign, stranding an uncontained
/// child; that window is the whole reason this attribute exists.
pub const ATTRIBUTE_JOB_LIST: u32 = 131_085;

/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.
///
/// Without it, `bInheritHandles = TRUE` hands the child EVERY inheritable
/// handle this process holds. With it the child gets exactly the allowlist.
pub const ATTRIBUTE_HANDLE_LIST: u32 = 131_074;

/// Size of the inherited-handle allowlist: standard input, output and error.
///
/// A fixed-size array rather than a slice, so "exactly three, never more" is a
/// fact the type system carries rather than a runtime check someone can skip.
pub const INHERITED_HANDLE_COUNT: usize = 3;

/// The suspend count `ResumeThread` must report for a process created with
/// `CREATE_SUSPENDED` that nothing else has touched. Any other value means a
/// third party suspended or resumed the thread between creation and here, so
/// resuming would be resuming something we do not understand.
pub const EXPECTED_PRIOR_SUSPEND_COUNT: u32 = 1;

/// Same forcing function as the `REQUIRED_LIMIT_FLAGS` pin, for both attribute
/// identifiers. A wrong attribute value does not fail loudly at runtime — it
/// configures the WRONG attribute, so it must fail at build time instead.
#[cfg(windows)]
const _: () = assert!(
    ATTRIBUTE_JOB_LIST == windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_JOB_LIST
);

#[cfg(windows)]
const _: () = assert!(
    ATTRIBUTE_HANDLE_LIST
        == windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_HANDLE_LIST
);

/// What a wait on a process handle observed.
///
/// FOUR OUTCOMES, AND ONLY ONE OF THEM IS AN ERROR. `WaitForSingleObject`
/// returns a `WAIT_EVENT`, NOT a `BOOL`, so the shape
/// `if result != WAIT_OBJECT_0 { Err(..) }` is wrong:
///
/// * `WAIT_OBJECT_0` (0) — the process is signalled, i.e. it has exited.
/// * `WAIT_TIMEOUT` (258) — the wait expired with the process still running.
///   That is a legitimate observation and an `Ok` value; treating it as a
///   failure makes "prove the suspended thread never ran" unwritable, because
///   the timeout IS the proof.
/// * `WAIT_ABANDONED` (128) — kept as its own case rather than folded into
///   either neighbour: it is neither "it exited" nor "it is still running", and
///   collapsing it would let an unknown state be reported as one of them.
/// * `WAIT_FAILED` (`u32::MAX`) — the CALL failed. This one, and only this one,
///   becomes `Err` with the real `GetLastError` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    Signalled,
    TimedOut,
    Abandoned,
}

/// The injectable process-construction and lifecycle boundary.
///
/// Split from [`super::Win32Calls`] rather than folded into it so a Job can
/// still be created and verified without dragging process creation along, and
/// so the construction sweep can fail one arm without needing a live Job.
///
/// The lifecycle arms below are on THIS trait rather than a third one because
/// `ContainedProcess` is already bounded on `Win32Calls + ProcessCalls`; a
/// separate trait would change that bound and every implementation of it, for
/// no isolation the sweep does not already have.
pub trait ProcessCalls {
    /// The attribute list, owned by the implementation.
    ///
    /// Associated rather than concrete because `UpdateProcThreadAttribute`
    /// stores a POINTER to each attribute's value instead of copying it. The
    /// real implementation must therefore own the Job handle and the handle
    /// array in the same value that owns the buffer, and must not let them move
    /// before `create_process_suspended` returns. A scripted double owns nothing
    /// and uses `()`.
    type AttributeList;

    fn init_attribute_list(&self, attributes: u32) -> Result<Self::AttributeList, NativeError>;

    fn set_job_list_attribute(
        &self,
        list: &mut Self::AttributeList,
        job: RawHandle,
    ) -> Result<(), NativeError>;

    fn set_handle_list_attribute(
        &self,
        list: &mut Self::AttributeList,
        handles: [RawHandle; INHERITED_HANDLE_COUNT],
    ) -> Result<(), NativeError>;

    fn create_process_suspended(
        &self,
        spec: &ProcessSpec<'_>,
        list: &Self::AttributeList,
    ) -> Result<CreatedProcess, NativeError>;

    fn assign_process_to_job(&self, process: RawHandle, job: RawHandle) -> Result<(), NativeError>;

    /// TWO OUTCOMES THAT MUST NOT COLLAPSE. `Err` is the CALL failing;
    /// `Ok(false)` is the call succeeding while reporting that the process is
    /// not in the Job. The second is a refusal of ours, not a Win32 failure.
    fn is_process_in_job(&self, process: RawHandle, job: RawHandle) -> Result<bool, NativeError>;

    fn process_id(&self, process: RawHandle) -> Result<u32, NativeError>;

    /// Creation time as raw FILETIME ticks. Paired with the PID it identifies
    /// one process for as long as this handle is open — a PID alone is reused.
    fn creation_time(&self, process: RawHandle) -> Result<u64, NativeError>;

    /// Returns the PRIOR suspend count, exactly as `ResumeThread` does. Same
    /// non-collapse rule as [`Self::is_process_in_job`]: `Err` is the call
    /// failing, `Ok(n)` for `n != 1` is our refusal.
    fn resume_thread(&self, thread: RawHandle) -> Result<u32, NativeError>;

    /// Waits up to `timeout_ms` for the process handle to be signalled.
    ///
    /// See [`WaitOutcome`]: three of the four `WAIT_*` results are `Ok`, and
    /// only `WAIT_FAILED` is an `Err`. Pass `u32::MAX` (`INFINITE`) to wait
    /// without a bound.
    fn wait_for_process(
        &self,
        process: RawHandle,
        timeout_ms: u32,
    ) -> Result<WaitOutcome, NativeError>;

    /// The raw value `GetExitCodeProcess` reports, with no interpretation.
    ///
    /// IT IS NOT AUTHORITATIVE ON ITS OWN. `STILL_ACTIVE` (259) comes back both
    /// for a process that is still running and for one that genuinely exited
    /// with code 259, and nothing about this call can tell them apart. Deciding
    /// what the number means is the caller's job, and the caller is only
    /// allowed to decide it after a wait reported [`WaitOutcome::Signalled`].
    fn exit_code(&self, process: RawHandle) -> Result<u32, NativeError>;

    /// Terminates the process this handle refers to.
    ///
    /// RETURNING `Ok` IS NOT PROOF THE PROCESS IS GONE. Termination is
    /// asynchronous; the caller must wait on the same handle afterwards.
    fn terminate_process(&self, process: RawHandle) -> Result<(), NativeError>;

    /// The full path of the image this process is running, as UTF-16.
    ///
    /// Read from the LIVE handle rather than from anything the caller supplied,
    /// so it reports what the kernel actually loaded. The value is returned to
    /// the caller and never placed in a [`super::NativeError`] or a log.
    fn image_name(&self, process: RawHandle) -> Result<Vec<u16>, NativeError>;

    /// Infallible by construction: windows-sys declares
    /// `DeleteProcThreadAttributeList` with no return type, so there is nothing
    /// to check and no [`super::NativeOp`] it could ever report.
    fn delete_attribute_list(&self, list: Self::AttributeList);
}
