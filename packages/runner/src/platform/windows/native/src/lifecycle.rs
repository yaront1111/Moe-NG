//! Waiting on a contained process, reading what it exited with, terminating it,
//! and asking the Job whether anything is still alive inside it.
//!
//! SCOPE. Queries and single operations only. The reverse-order unwind of a
//! partially constructed process lives in `unwind.rs`, which builds on this.
//!
//! EVERY OPERATION TAKES THE RETAINED HANDLE. Each entry point here takes the
//! [`ContainedProcess`] or the [`Job`] the caller already holds, so the handle
//! it acts on is the one construction produced and proved. There is deliberately
//! no way to name a process by PID: a PID is reused by Windows the moment the
//! process it named is reaped, so an operation that reopened one could act on an
//! unrelated process. The absence is enforced by the closed [`NativeOp`] --
//! there is no open-by-PID variant, and its `ALL` array has a fixed length that
//! the sweeps assert -- rather than by this comment.

use crate::job::Job;
use crate::process::ContainedProcess;
use crate::win32::{NativeError, NativeOp, ProcessCalls, RawHandle, WaitOutcome, Win32Calls};

/// How long to sleep between `ActiveProcesses` samples while waiting for a Job
/// to empty, and how many samples to take before giving up.
///
/// `TerminateJobObject` returns BEFORE its processes are gone, so a single
/// sample can legitimately still be nonzero. Polling is what converts that into
/// an observation; the bound is what stops a Job that never empties from
/// hanging the caller forever.
const EMPTY_POLL_INTERVAL_MS: u64 = 10;
const EMPTY_POLL_ATTEMPTS: u32 = 500;

/// Evidence that a wait on a process handle observed `WAIT_OBJECT_0`.
///
/// The field is private and nothing outside this module constructs one, so a
/// value of this type cannot exist unless [`wait_for_process`] produced it from
/// a real signalled wait. That is what makes [`ExitStatus::Exited`] unreachable
/// without the wait: not a runtime check a caller can skip, but a value they
/// cannot fabricate.
///
/// IT CARRIES THE HANDLE IT IS ABOUT. A bare token would say only "some process
/// was seen to exit", so a caller holding one for process A could use it to read
/// an exit code for process B — the proof would be real and would authorise the
/// wrong question. The handle is what binds it to one process, and
/// [`query_exit_status`] refuses a proof that does not match.
///
/// DELIBERATELY NOT `Clone`. A clonable proof could be kept past the wait it
/// came from and reused for a different question.
pub struct SignalledProof(RawHandle);

/// What a wait observed, with the [`SignalledProof`] attached to the one
/// outcome that carries authority.
///
/// The `WaitOutcome` this is built from is the raw Win32 answer; this is the
/// production-side observation. They are separate types on purpose: the call
/// table must be scriptable by a test double, and a double that could mint a
/// [`SignalledProof`] would defeat the whole point of having one.
pub enum Waited {
    Signalled(SignalledProof),
    TimedOut,
    Abandoned,
}

/// A process exit code, readable only through [`Self::value`].
///
/// The field is private so this type cannot be constructed outside the crate,
/// which is what stops `ExitStatus::Exited` from being assembled by a caller
/// who never waited.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExitCode(u32);

impl ExitCode {
    pub const fn value(&self) -> u32 {
        self.0
    }
}

/// Why an exit code is not knowable. These are stable reason codes, not
/// decoration: a caller that cannot tell "never waited" from "still running"
/// cannot tell an un-run query from a live process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownExit {
    /// No wait has observed this process signalled.
    NotWaited,
    /// A wait expired with the process still running.
    StillRunning,
    /// A wait returned `WAIT_ABANDONED`: neither exited nor known to be running.
    WaitAbandoned,
    /// The proof offered was produced by a wait on a DIFFERENT process. It is a
    /// real observation of some process exiting, and it says nothing at all
    /// about this one.
    ProofFromAnotherProcess,
}

/// What is known about how a process ended.
///
/// THE WHOLE REASON THIS IS NOT A `u32`. `GetExitCodeProcess` answers
/// `STILL_ACTIVE` (259) for a process that is still running AND for one that
/// genuinely exited with code 259, and no property of the call distinguishes
/// them. The distinguishing fact is a prior wait that reported the process
/// signalled -- so it is carried in the type rather than checked against the
/// value. Blacklisting 259 would be the same defect wearing a different hat: it
/// would report a real exit code as unknown forever.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitStatus {
    Exited(ExitCode),
    Unknown(UnknownExit),
}

/// PID, creation time and the image the kernel actually loaded.
///
/// DELIBERATELY NOT `Debug`, exactly like `ProcessSpec`: `image` is a full
/// executable path, and a derived `Debug` on a struct holding one is how the
/// rail against echoing executable paths gets broken. Without the impl, that
/// derive fails to compile.
pub struct Identity {
    /// The PID, as queried from the live handle at construction time.
    pub pid: u32,
    /// Creation time in raw FILETIME ticks. Paired with the PID it identifies
    /// one process; a PID alone is reused.
    pub creation_time: u64,
    /// The full image path, UTF-16, read from the live handle.
    pub image: Vec<u16>,
}

/// Waits up to `timeout_ms` for the contained process to exit.
///
/// A timeout is an OBSERVATION, not a failure: `Ok(Waited::TimedOut)` means the
/// process was still running when the wait expired, which is exactly how a
/// suspended process is proved never to have run.
pub fn wait_for_process<C: Win32Calls + ProcessCalls>(
    calls: &C,
    contained: &ContainedProcess<'_, C>,
    timeout_ms: u32,
) -> Result<Waited, NativeError> {
    let process = contained.process_handle();
    Ok(match calls.wait_for_process(process, timeout_ms)? {
        WaitOutcome::Signalled => Waited::Signalled(SignalledProof(process)),
        WaitOutcome::TimedOut => Waited::TimedOut,
        WaitOutcome::Abandoned => Waited::Abandoned,
    })
}

/// Reports the exit status, and refuses to invent one.
///
/// `observed` is whatever [`wait_for_process`] last returned for THIS process,
/// or `None` if no wait has been made. Only the signalled case reaches the
/// boundary at all: for every other input the answer is already known to be
/// unknowable, and querying anyway would mean reading a number that cannot be
/// interpreted -- which is how an ambiguous 259 turns into a false exit code.
pub fn query_exit_status<C: Win32Calls + ProcessCalls>(
    calls: &C,
    contained: &ContainedProcess<'_, C>,
    observed: Option<&Waited>,
) -> Result<ExitStatus, NativeError> {
    match observed {
        Some(Waited::Signalled(proof)) if proof.0 == contained.process_handle() => {
            let code = calls.exit_code(contained.process_handle())?;
            Ok(ExitStatus::Exited(ExitCode(code)))
        }
        // A genuine proof, about somebody else. It authorises nothing here.
        Some(Waited::Signalled(_)) => {
            Ok(ExitStatus::Unknown(UnknownExit::ProofFromAnotherProcess))
        }
        Some(Waited::TimedOut) => Ok(ExitStatus::Unknown(UnknownExit::StillRunning)),
        Some(Waited::Abandoned) => Ok(ExitStatus::Unknown(UnknownExit::WaitAbandoned)),
        None => Ok(ExitStatus::Unknown(UnknownExit::NotWaited)),
    }
}

/// Terminates the contained process through its retained handle.
///
/// RETURNING `Ok` IS NOT PROOF THE PROCESS IS GONE. Termination is
/// asynchronous; only a subsequent [`wait_for_process`] reporting
/// [`Waited::Signalled`] observes the end.
pub fn terminate_process<C: Win32Calls + ProcessCalls>(
    calls: &C,
    contained: &ContainedProcess<'_, C>,
) -> Result<(), NativeError> {
    calls.terminate_process(contained.process_handle())
}

/// PID, creation time and the final image path.
///
/// The PID and the creation time are the ones construction read from the live
/// handle before anything could exit; they are DELEGATED rather than re-queried,
/// because re-reading them later would answer about whatever the handle refers
/// to now rather than about the process that was proved into the Job.
pub fn query_identity<C: Win32Calls + ProcessCalls>(
    calls: &C,
    contained: &ContainedProcess<'_, C>,
) -> Result<Identity, NativeError> {
    let image = calls.image_name(contained.process_handle())?;
    Ok(Identity { pid: contained.pid(), creation_time: contained.creation_time(), image })
}

/// Waits until the Job reports zero live processes.
///
/// POLLS, NEVER SAMPLES ONCE. `TerminateJobObject` returns before the processes
/// it signalled have gone, so a single read can legitimately still be nonzero.
/// If the count never reaches zero within the bound, the outcome is UNKNOWN and
/// stays unknown: it refuses as [`NativeOp::QueryAccounting`] with code 0 --
/// child 1's convention for a refusal that is ours rather than the operating
/// system's -- instead of reporting an emptiness it never observed.
///
/// A zero count is an observation about a live Job handle, not proof of tree
/// death: it says nothing about processes that already left the Job.
pub fn wait_until_job_is_empty<C: Win32Calls>(job: &Job<'_, C>) -> Result<(), NativeError> {
    for _ in 0..EMPTY_POLL_ATTEMPTS {
        if job.active_processes()? == 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(EMPTY_POLL_INTERVAL_MS));
    }
    Err(NativeError::new(NativeOp::QueryAccounting, 0))
}
