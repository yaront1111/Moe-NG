//! Putting a process INSIDE the Job, proving it is there before it runs, and
//! unwinding correctly when any of that fails.
//!
//! SCOPE. Construction and its unwind. The value types that cross the FFI
//! boundary live in `spec.rs`; wait, exit query, terminate and the
//! `ActiveProcesses == 0` query live in `lifecycle.rs`; the two unwind regimes
//! live in `unwind.rs` and are invoked from here, because `create` is the only
//! place a partial-construction fault can be observed.

use crate::handle::OwnedHandle;
use crate::job::Job;
use crate::spec::{validate, CreatedProcess, ProcessSpec};
use crate::unwind::{unwind_after_membership, unwind_before_membership};
use crate::win32::{
    NativeError, NativeOp, ProcessCalls, RawHandle, Win32Calls, EXPECTED_PRIOR_SUSPEND_COUNT,
};

/// Attributes on the creation list: `JOB_LIST` and `HANDLE_LIST`, exactly two.
const ATTRIBUTE_COUNT: u32 = 2;

/// A process that is provably inside the Job and has been allowed to run.
///
/// The type cannot exist in an unproven state: [`ContainedProcess::create`] is
/// the only constructor and it refuses unless membership was confirmed BEFORE
/// the thread was resumed. So "contained" is an invariant rather than a step a
/// caller has to remember, exactly as "configured" is for [`Job`].
pub struct ContainedProcess<'c, C: Win32Calls + ProcessCalls> {
    process: OwnedHandle<'c, C>,
    thread: OwnedHandle<'c, C>,
    pid: u32,
    creation_time: u64,
}

impl<'c, C: Win32Calls + ProcessCalls> ContainedProcess<'c, C> {
    /// Creates a suspended process already inside `job`, proves it is there, and
    /// only then lets it run.
    ///
    /// TWO UNWIND REGIMES, SPLIT AT THE MEMBERSHIP PROOF. Which cleanup is
    /// correct depends entirely on whether the Job has been proved to contain
    /// the child, so the two are separate branches below and separate functions
    /// in `unwind.rs`. See [`contain`] and [`identify`] for where the line falls.
    ///
    /// Every handle acquired here is owned from the moment it is returned, so
    /// any refusal below closes both of them exactly once on the way out, and
    /// the first error is what the caller sees -- an unwind that fails cannot
    /// replace it.
    pub fn create(
        calls: &'c C,
        job: &Job<'c, C>,
        spec: &ProcessSpec<'_>,
    ) -> Result<Self, NativeError> {
        validate(spec)?;
        let created = create_suspended(calls, job.handle(), spec)?;
        let process = OwnedHandle::new(created.process, calls);
        let thread = OwnedHandle::new(created.thread, calls);

        // PRE-MEMBERSHIP REGIME. A child now exists that nothing has yet proved
        // the Job contains, so a fault here must terminate and await THAT
        // PROCESS directly. Terminating the Job instead could succeed while
        // leaving the child running with nothing left to name it.
        if let Err(first) = contain(calls, process.raw(), job.handle()) {
            // The unwind's own outcome is deliberately not allowed to replace
            // `first`: a cleanup failure must not hide the reason the run
            // failed. It is surfaced by `unwind_before_membership` itself,
            // which returns an error carrying its own NativeOp.
            let _ = unwind_before_membership(calls, process.raw());
            return Err(first);
        }

        // POST-MEMBERSHIP REGIME. The Job owns the child from here, so a fault
        // must terminate the JOB and wait for it to empty -- which also covers
        // any grandchild the child may already have spawned.
        match identify(calls, process.raw(), thread.raw()) {
            Ok((pid, creation_time)) => Ok(Self { process, thread, pid, creation_time }),
            Err(first) => {
                let _ = unwind_after_membership(job);
                Err(first)
            }
        }
    }

    /// The ORIGINAL process handle, for the lifecycle module.
    ///
    /// `pub(crate)` for the same reason `OwnedHandle::raw` is: handing the value
    /// out of the crate is what would let a second owner close it. A consumer
    /// outside the crate can only pass the `ContainedProcess` itself, so every
    /// lifecycle operation acts on the handle construction proved -- there is no
    /// path that reopens a process by PID, and a PID is reused by Windows.
    pub(crate) fn process_handle(&self) -> RawHandle {
        self.process.raw()
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn creation_time(&self) -> u64 {
        self.creation_time
    }

    /// Closes both handles and RETURNS the outcome, in reverse acquisition
    /// order. Both are attempted even if the first fails — skipping the second
    /// would leak it — and the FIRST error is what survives, so a later close
    /// cannot overwrite the reason the run failed.
    ///
    /// This is the RAII completion only. Terminate, wait and the exit query are
    /// in `lifecycle.rs`; the unwind protocol is in `unwind.rs`.
    pub fn close(self) -> Result<(), NativeError> {
        let thread = self.thread.close();
        let process = self.process.close();
        thread.and(process)
    }
}

/// Everything between `CreateProcessW` returning and membership being PROVEN.
///
/// Kept as one function so the pre-membership regime has exactly one boundary:
/// every failure it can produce belongs to that regime, and adding a step here
/// cannot silently move the boundary.
///
/// Membership is established TWICE on purpose. The attribute list made it atomic
/// with creation; this explicit `AssignProcessToJobObject` is what keeps
/// assignment failure a separately observable arm rather than an invisible
/// property of creation. Neither is trusted -- the PROOF is what gates resume.
fn contain<C: ProcessCalls>(
    calls: &C,
    process: RawHandle,
    job: RawHandle,
) -> Result<(), NativeError> {
    calls.assign_process_to_job(process, job)?;
    prove_membership(calls, process, job)
}

/// Everything after membership is proven: identity, then resume.
///
/// Identity is read from the LIVE handle, before anything can exit. A PID alone
/// is reused by Windows; a PID paired with the creation time of the process this
/// handle refers to is not.
fn identify<C: ProcessCalls>(
    calls: &C,
    process: RawHandle,
    thread: RawHandle,
) -> Result<(u32, u64), NativeError> {
    let pid = calls.process_id(process)?;
    let creation_time = calls.creation_time(process)?;
    resume(calls, thread)?;
    Ok((pid, creation_time))
}

/// Prepares the attribute list, creates the suspended process, and deletes the
/// list on EVERY path.
///
/// The deletion is unconditional and cannot overwrite `outcome`, because
/// `delete_attribute_list` returns nothing at all — there is no result for a
/// cleanup step to launder the first error into.
fn create_suspended<C: ProcessCalls>(
    calls: &C,
    job: RawHandle,
    spec: &ProcessSpec<'_>,
) -> Result<CreatedProcess, NativeError> {
    let mut list = calls.init_attribute_list(ATTRIBUTE_COUNT)?;
    let outcome = match prepare(calls, &mut list, job, spec) {
        Ok(()) => calls.create_process_suspended(spec, &list),
        Err(error) => Err(error),
    };
    calls.delete_attribute_list(list);
    outcome
}

/// Sets both attributes, JOB_LIST first.
///
/// LIFETIME NOTE FOR THE REAL IMPLEMENTATION: `UpdateProcThreadAttribute` stores
/// a POINTER to each value rather than copying it, so the job handle and the
/// handle array must be owned by the same value that owns the list and must not
/// move before `create_process_suspended` returns. That obligation lives with
/// `C::AttributeList`; nothing here can enforce it, which is why it is written
/// down at the seam as well.
fn prepare<C: ProcessCalls>(
    calls: &C,
    list: &mut C::AttributeList,
    job: RawHandle,
    spec: &ProcessSpec<'_>,
) -> Result<(), NativeError> {
    calls.set_job_list_attribute(list, job)?;
    calls.set_handle_list_attribute(list, spec.inherited)
}

/// Refuses unless the process is observably inside the Job.
///
/// TWO OUTCOMES, NOT ONE. If the query itself fails, `?` propagates the real
/// Win32 error. If it succeeds and answers "no", that is OUR refusal and
/// carries code 0 — child 1's convention at job.rs:78, where nothing failed at
/// the boundary but the thing we require is not true.
fn prove_membership<C: ProcessCalls>(
    calls: &C,
    process: RawHandle,
    job: RawHandle,
) -> Result<(), NativeError> {
    if calls.is_process_in_job(process, job)? {
        return Ok(());
    }
    Err(NativeError::new(NativeOp::IsProcessInJob, 0))
}

/// Resumes the initial thread, refusing any prior suspend count but one.
///
/// A process created with `CREATE_SUSPENDED` and untouched since has exactly
/// one outstanding suspend. Any other count means something else suspended or
/// resumed this thread in between, so the thread is not in the state this code
/// reasoned about and resuming it would be resuming something unknown. Same
/// two-outcome split as [`prove_membership`]: a failed CALL carries the real
/// Win32 error, a successful call reporting the wrong count carries code 0.
fn resume<C: ProcessCalls>(calls: &C, thread: RawHandle) -> Result<(), NativeError> {
    if calls.resume_thread(thread)? == EXPECTED_PRIOR_SUSPEND_COUNT {
        return Ok(());
    }
    Err(NativeError::new(NativeOp::ResumeThread, 0))
}
