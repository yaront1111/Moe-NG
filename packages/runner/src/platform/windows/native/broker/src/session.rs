//! One launch: hold the Job, drive the core, and never publish a status the
//! core has not proved.
//!
//! SCOPE. The session's vocabulary, the launch sequence, and the outbound
//! emission every layer shares. The run loop is in `watch.rs` and the three
//! completion preconditions are in `settle.rs` — split by responsibility, not by
//! reformatting, exactly as the core splits `process.rs` from `spec.rs`.
//!
//! # Nothing here is a Win32 call
//!
//! Every Job and process operation is `moe-windows-job-core`'s. This crate
//! decides ORDER and nothing else, which is why the no-restatement rail is
//! checkable by grep: no `CreateJobObject`, `AssignProcessToJobObject`,
//! `CreateProcessW`, `ResumeThread`, `TerminateProcess` or `WaitForSingleObject`
//! call site exists anywhere in it.
//!
//! # STARTED is earned
//!
//! Exact Job limit flags, explicit assignment, membership, retained-handle
//! identity and one successful resume are five separate facts, and all five are
//! established inside `Job::create` and `ContainedProcess::create` before either
//! returns. STARTED is written only where both have already succeeded — success
//! is never inferred from an error's absence, because there is no point in this
//! file where an error's absence is all that is known.
//!
//! # Closing the Job handle is CRASH SAFETY, not success evidence
//!
//! `KILL_ON_JOB_CLOSE` kills the contents when the last handle goes. That is a
//! net for a broker that crashes and it proves nothing: once the handle is gone
//! there is nothing left to query. So ordinary completion AND every termination
//! path observe `ActiveProcesses == 0` before the handles fall out of scope.

use moe_windows_job_core::{
    ContainedProcess, Job, NativeError, ProcessCalls, RawHandle, Win32Calls,
    INHERITED_HANDLE_COUNT,
};

use crate::completion::{Completion, Outcome};
use crate::approved_image::ApprovedImageGuard;
use crate::control::AcceptState;
use crate::diagnostics::{Diagnostic, DiagnosticNote};
use crate::frames::ByteChannel;
use crate::launch::LaunchPlan;
use crate::protocol::ProtocolError;
use crate::refusal::Refused;
use crate::session_accept::accept_launch;
use crate::settle::settle;
use crate::status::{Started, Status};
use crate::descriptors::DescriptorError;
use crate::store_lock::{
    StoreLockAuthority, StoreLockError, StoreLockedOutcome, UnavailableStoreLocks,
};
use crate::verify::{Descriptors, HandleCalls};
use crate::watch::watch;

/// Whether the helper has been asked to stop.
///
/// Polled once per turn rather than delivered, so the session never has to be
/// interrupted mid-wait: a stop arriving asynchronously could land between the
/// terminate and the reap, which is exactly the double teardown the hardening
/// sibling exists to rule out under concurrency.
pub trait ShutdownSignal {
    fn requested(&self) -> bool;
}

/// The channels one session speaks over.
///
/// fd3 is not here: it is handed to the child as its standard input and the
/// session never reads it. fd4 and fd5 ARE here, and the session never reads
/// them either — they are the child's stdout and stderr, they belong to the
/// parent, and `settle.rs` explains why nothing this side could read from them
/// is evidence about the child. They are named rather than dropped so the
/// session's view of the descriptor trio stays complete, and so the test that
/// proves a pathological provider channel cannot withhold COMPLETED has a
/// channel to make pathological.
///
/// There is no path from a provider channel to the control decoder, and now not
/// even a read.
pub struct Wiring<B: ByteChannel> {
    /// fd0, inbound control.
    pub control: B,
    /// fd1, outbound authoritative status.
    pub status: B,
    /// fd2, outbound non-authoritative diagnostics.
    pub diagnostics: B,
    /// fd4 as the session sees it: held, never consulted.
    pub provider_out: B,
    /// fd5, likewise.
    pub provider_err: B,
}

/// One launch, from the accepted request to the terminal status.
pub struct Session<'c, C: Win32Calls + ProcessCalls> {
    calls: &'c C,
    inherited: [RawHandle; INHERITED_HANDLE_COUNT],
    timeout_ms: u32,
}

impl<'c, C: Win32Calls + ProcessCalls> Session<'c, C> {
    pub const fn new(
        calls: &'c C,
        inherited: [RawHandle; INHERITED_HANDLE_COUNT],
        timeout_ms: u32,
    ) -> Self {
        Self { calls, inherited, timeout_ms }
    }

    /// Accepts one launch, runs it, and settles it.
    pub fn run<B: ByteChannel, S: ShutdownSignal>(
        &self,
        wiring: &mut Wiring<B>,
        shutdown: &S,
    ) -> Outcome {
        self.run_with_store_lock(wiring, shutdown, &UnavailableStoreLocks).outcome()
    }

    /// Runs with the authority required by opcode 3 and returns the guard with
    /// the outcome so the broker can retain it until its own final teardown.
    pub fn run_with_store_lock<B, S, L>(
        &self,
        wiring: &mut Wiring<B>,
        shutdown: &S,
        locks: &L,
    ) -> StoreLockedOutcome<L::Guard>
    where
        B: ByteChannel,
        S: ShutdownSignal,
        L: StoreLockAuthority,
    {
        let mut accept = AcceptState::new();
        let request = match accept_launch(wiring, &mut accept) {
            Ok(Some(request)) => request,
            Ok(None) => return StoreLockedOutcome::new(Outcome::NoInstruction, None),
            Err(refused) => return StoreLockedOutcome::new(Outcome::NotLaunched(refused), None),
        };
        let guard = match request.store_path() {
            Some(path) => match locks.acquire(path) {
                Ok(guard) => Some(guard),
                Err(error) => return StoreLockedOutcome::new(
                    Outcome::NotLaunched(refuse_store_lock(wiring, error)), None,
                ),
            },
            None => None,
        };
        let deadline_ms = request.store_path().is_none().then_some(self.timeout_ms);
        // Hold the image and all directory names through contained completion.
        // A refused hash/lock never reaches Job creation or CreateProcess.
        let _image_guard = match request.approved_image_sha256() {
            Some(digest) => match ApprovedImageGuard::acquire(request.executable(), digest) {
                Ok(guard) => Some(guard),
                Err(error) => return StoreLockedOutcome::new(
                    Outcome::NotLaunched(publish(wiring, Refused::approved_image(error))), guard,
                ),
            },
            None => None,
        };
        let plan = match LaunchPlan::from_request(&request, self.inherited) {
            Ok(plan) => plan,
            Err(error) => return StoreLockedOutcome::new(
                Outcome::NotLaunched(refuse_native(wiring, error)), guard,
            ),
        };

        // THE FIVE PROOF ARMS. Both constructors refuse unless every fact they
        // establish held, so reaching the line after them IS the proof.
        let job = match Job::create(self.calls) {
            Ok(job) => job,
            Err(error) => return StoreLockedOutcome::new(
                Outcome::NotLaunched(refuse_native(wiring, error)), guard,
            ),
        };
        let contained = match ContainedProcess::create(self.calls, &job, &plan.spec()) {
            Ok(contained) => contained,
            Err(error) => return StoreLockedOutcome::new(
                Outcome::NotLaunched(refuse_native(wiring, error)), guard,
            ),
        };

        StoreLockedOutcome::new(
            self.announce_and_settle(
                wiring, shutdown, &job, &contained, &mut accept, deadline_ms,
            ),
            guard,
        )
    }

    /// Everything after all five arms are proved: announce, watch, settle.
    fn announce_and_settle<B: ByteChannel, S: ShutdownSignal>(
        &self,
        wiring: &mut Wiring<B>,
        shutdown: &S,
        job: &Job<'c, C>,
        contained: &ContainedProcess<'_, C>,
        accept: &mut AcceptState,
        deadline_ms: Option<u32>,
    ) -> Outcome {
        let started = Started::new(contained.pid(), contained.creation_time());
        let _ = Status::Started(started).emit(&mut wiring.status);

        let (stopped, observed) =
            watch(self.calls, wiring, shutdown, contained, accept, deadline_ms);
        let completion = settle(self.calls, job, contained, stopped, observed);
        if let Completion::Completed(completed) = completion {
            let _ = Status::Completed(completed).emit(&mut wiring.status);
        }
        Outcome::Ran(stopped, completion)
    }
}

/// Emits a protocol refusal on fd1 and notes it on fd2.
pub(crate) fn refuse_protocol<B: ByteChannel>(
    wiring: &mut Wiring<B>,
    error: ProtocolError,
) -> Refused {
    publish(wiring, Refused::protocol(error))
}

/// Emits a native refusal on fd1 and notes it on fd2.
pub(crate) fn refuse_native<B: ByteChannel>(w: &mut Wiring<B>, error: NativeError) -> Refused {
    publish(w, Refused::native(error))
}

fn refuse_store_lock<B: ByteChannel>(w: &mut Wiring<B>, error: StoreLockError) -> Refused {
    publish(w, Refused::store_lock(error))
}

/// The one place a refusal reaches the wire.
///
/// [`Refused`] can hold a layer, a reason ordinal and a numeric code and nothing
/// else — that is enforced by its own `Copy` and `Debug` derives and a size
/// assertion — so routing every refusal through one function cannot leak, and
/// makes the no-echo rail a property of the type rather than of each call site.
fn publish<B: ByteChannel>(wiring: &mut Wiring<B>, refused: Refused) -> Refused {
    let _ = Status::Refused(refused).emit(&mut wiring.status);
    note(wiring, DiagnosticNote::FrameRefused, u32::from(refused.reason()));
    refused
}

/// One bounded, non-authoritative note on fd2.
///
/// A failed write is ignored on purpose: a channel nobody may rely on cannot
/// fail a run, and a diagnostic that could would be authority by the back door.
pub(crate) fn note<B: ByteChannel>(wiring: &mut Wiring<B>, note: DiagnosticNote, detail: u32) {
    let _ = Diagnostic::new(note, detail).emit(&mut wiring.diagnostics);
}

/// Closes the six descriptors, THEN releases the store guard.
///
/// THE ORDER IS THE EXCLUSIVITY CONTRACT, not tidiness. Releasing first would
/// free the store while six pipe handles into the dead child are still open,
/// letting a second broker acquire it and start a host against descriptors this
/// one has not finished closing. Sequencing it here keeps the two from drifting
/// apart at the call site. The close result is returned, never discarded: a
/// failed close leaves an unknown, and reporting success over it invents it.
pub fn close_then_release<C: HandleCalls, G>(
    descriptors: Descriptors<'_, C>,
    guard: G,
) -> Result<(), DescriptorError> {
    let closed = descriptors.close();
    drop(guard);
    closed
}
