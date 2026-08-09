//! Putting a process INSIDE the Job, and proving it is there before it runs.
//!
//! SCOPE. Construction only: attribute list, suspended creation, assignment,
//! membership proof, live-handle identity proof, resume. Wait, exit query,
//! terminate, the `ActiveProcesses == 0` query and the reverse-order unwind of
//! an already-created child are deliberately ABSENT — they belong to sibling 2b
//! (task-af99cf146c9b4f4d99b49d8c00caed63).

use crate::handle::OwnedHandle;
use crate::job::Job;
use crate::win32::{
    NativeError, NativeOp, ProcessCalls, RawHandle, Win32Calls, EXPECTED_PRIOR_SUSPEND_COUNT,
    INHERITED_HANDLE_COUNT,
};

/// Attributes on the creation list: `JOB_LIST` and `HANDLE_LIST`, exactly two.
const ATTRIBUTE_COUNT: u32 = 2;

/// Everything `CreateProcessW` needs, and nothing it does not.
///
/// DELIBERATELY NOT `Debug`, for the same reason [`RawHandle`] is not: every
/// field here is either a raw handle or exactly the executable / command line /
/// working directory / environment that must never reach an error or a log. A
/// derived `Debug` is how that rail gets broken, so it must not compile.
pub struct ProcessSpec<'a> {
    /// `lpApplicationName`, NUL-terminated UTF-16, and NEVER null.
    ///
    /// Letting `CreateProcessW` parse the image out of the command line is the
    /// classic unquoted-path hijack: `C:\Program Files\app.exe` also tries
    /// `C:\Program.exe` first. An explicit application name has no such search.
    pub application: &'a [u16],
    /// `lpCommandLine`, NUL-terminated UTF-16.
    pub command_line: &'a [u16],
    /// `lpCurrentDirectory`, NUL-terminated UTF-16.
    pub current_directory: &'a [u16],
    /// `lpEnvironment`: a DOUBLE-NUL-terminated UTF-16 block, passed with
    /// `CREATE_UNICODE_ENVIRONMENT`. Explicit rather than inherited, so the
    /// child cannot silently pick up this process's environment.
    pub environment: &'a [u16],
    /// The ONLY handles the child may inherit: standard input, output, error.
    ///
    /// Fixed-size, so "exactly three" is carried by the type. This is what the
    /// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` allowlist is built from.
    pub inherited: [RawHandle; INHERITED_HANDLE_COUNT],
}

/// The two handles `CreateProcessW` hands back.
///
/// Not `Debug`, same reason as [`ProcessSpec`]. Both handles are raw here for
/// exactly as long as it takes the caller to wrap them in owners.
pub struct CreatedProcess {
    pub process: RawHandle,
    pub thread: RawHandle,
}

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
    /// Membership is established TWICE on purpose. The attribute list makes it
    /// atomic with creation, closing the window in which this process could die
    /// between create and assign and strand an uncontained child. The explicit
    /// `AssignProcessToJobObject` that follows is what keeps assignment failure
    /// a separately observable arm rather than an invisible property of
    /// creation. Neither is trusted: the membership PROOF is what gates resume.
    ///
    /// Every handle acquired here is owned from the moment it is returned, so
    /// any refusal below closes both of them exactly once on the way out, and
    /// the first error is what the caller sees.
    pub fn create(
        calls: &'c C,
        job: &Job<'c, C>,
        spec: &ProcessSpec<'_>,
    ) -> Result<Self, NativeError> {
        validate(spec)?;
        let created = create_suspended(calls, job.handle(), spec)?;
        let process = OwnedHandle::new(created.process, calls);
        let thread = OwnedHandle::new(created.thread, calls);

        calls.assign_process_to_job(process.raw(), job.handle())?;
        prove_membership(calls, process.raw(), job.handle())?;

        // Identity is read from the LIVE handle, before anything can exit. A
        // PID alone is reused by Windows; a PID paired with the creation time
        // of the process this handle refers to is not.
        let pid = calls.process_id(process.raw())?;
        let creation_time = calls.creation_time(process.raw())?;

        resume(calls, thread.raw())?;

        Ok(Self { process, thread, pid, creation_time })
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
    /// This is the RAII completion only. Terminate, wait, exit query and the
    /// reverse-order unwind protocol belong to sibling 2b.
    pub fn close(self) -> Result<(), NativeError> {
        let thread = self.thread.close();
        let process = self.process.close();
        thread.and(process)
    }
}

/// Refuses a spec whose strings are not terminated the way `CreateProcessW`
/// requires.
///
/// THIS IS A SOUNDNESS CHECK, NOT A POLICY ONE. [`ProcessSpec`]'s fields are
/// `pub` slices that are handed straight to `unsafe` FFI as `PCWSTR`, and a
/// Win32 string function reads until it finds a NUL. An empty or unterminated
/// slice therefore makes the OS read past the end of the caller's allocation —
/// undefined behaviour that no scripted test can catch, because the double
/// dereferences nothing. Refusing here converts that into a stable refusal.
///
/// Reported as [`NativeOp::CreateProcess`] with code 0: the create arm is what
/// is being refused, and 0 is child 1's convention for "ours, not the operating
/// system's". No call has reached the boundary at this point, so there is no
/// Win32 error to carry, and the refusal is observable as the ABSENCE of every
/// boundary call rather than only as an `Err`.
fn validate(spec: &ProcessSpec<'_>) -> Result<(), NativeError> {
    let refusal = NativeError::new(NativeOp::CreateProcess, 0);
    for string in [spec.application, spec.command_line, spec.current_directory] {
        if string.last() != Some(&0) {
            return Err(refusal);
        }
    }
    // The environment is a BLOCK: every entry is NUL-terminated and the block
    // itself ends with one more NUL, so the last two units are always zero --
    // including for an empty environment, which is exactly `[0, 0]`.
    if spec.environment.len() < 2 || spec.environment[spec.environment.len() - 2..] != [0, 0] {
        return Err(refusal);
    }
    Ok(())
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
