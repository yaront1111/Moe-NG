//! The process-construction seam and the constants it is configured with.
//!
//! Split out of `win32.rs` by RESPONSIBILITY, not by reformatting: that file
//! owns the error vocabulary and the Job seam, this one owns the construction
//! seam. Both are re-exported from `win32`, so every item still has exactly one
//! public path.

use super::{NativeError, RawHandle};
use crate::process::{CreatedProcess, ProcessSpec};

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

/// The injectable process-construction boundary.
///
/// Split from [`super::Win32Calls`] rather than folded into it so a Job can
/// still be created and verified without dragging process creation along, and
/// so the construction sweep can fail one arm without needing a live Job.
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

    /// Infallible by construction: windows-sys declares
    /// `DeleteProcThreadAttributeList` with no return type, so there is nothing
    /// to check and no [`super::NativeOp`] it could ever report.
    fn delete_attribute_list(&self, list: Self::AttributeList);
}
