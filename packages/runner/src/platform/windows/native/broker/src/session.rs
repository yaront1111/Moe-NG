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
use crate::control::{AcceptState, Accepted, LaunchRequest};
use crate::diagnostics::{Diagnostic, DiagnosticNote};
use crate::frames::{read_frame, ByteChannel, ChannelKind};
use crate::launch::LaunchPlan;
use crate::protocol::{ProtocolError, ProtocolReason};
use crate::refusal::Refused;
use crate::settle::settle;
use crate::status::{Started, Status};
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
        let mut accept = AcceptState::new();
        let request = match accept_launch(wiring, &mut accept) {
            Ok(Some(request)) => request,
            Ok(None) => return Outcome::NoInstruction,
            Err(refused) => return Outcome::NotLaunched(refused),
        };
        let plan = match LaunchPlan::from_request(&request, self.inherited) {
            Ok(plan) => plan,
            Err(error) => return Outcome::NotLaunched(refuse_native(wiring, error)),
        };

        // THE FIVE PROOF ARMS. Both constructors refuse unless every fact they
        // establish held, so reaching the line after them IS the proof.
        let job = match Job::create(self.calls) {
            Ok(job) => job,
            Err(error) => return Outcome::NotLaunched(refuse_native(wiring, error)),
        };
        let contained = match ContainedProcess::create(self.calls, &job, &plan.spec()) {
            Ok(contained) => contained,
            Err(error) => return Outcome::NotLaunched(refuse_native(wiring, error)),
        };

        self.announce_and_settle(wiring, shutdown, &job, &contained, &mut accept)
    }

    /// Everything after all five arms are proved: announce, watch, settle.
    fn announce_and_settle<B: ByteChannel, S: ShutdownSignal>(
        &self,
        wiring: &mut Wiring<B>,
        shutdown: &S,
        job: &Job<'c, C>,
        contained: &ContainedProcess<'_, C>,
        accept: &mut AcceptState,
    ) -> Outcome {
        let started = Started::new(contained.pid(), contained.creation_time());
        let _ = Status::Started(started).emit(&mut wiring.status);

        let (stopped, observed) =
            watch(self.calls, wiring, shutdown, contained, accept, self.timeout_ms);
        let completion = settle(self.calls, job, contained, stopped, observed);
        if let Completion::Completed(completed) = completion {
            let _ = Status::Completed(completed).emit(&mut wiring.status);
        }
        Outcome::Ran(stopped, completion)
    }
}

/// Reads fd0 for the one launch this session serves.
///
/// `Ok(None)` is fd0 ENDING BEFORE IT ASKED FOR ANYTHING, and it deliberately
/// writes no frame. A parent that says nothing has violated no rule, and there
/// is nobody left on fd1 to hear a refusal about it — the peer that would read
/// it is the peer that just closed. Every other failure IS a refusal and is
/// published.
fn accept_launch<B: ByteChannel>(
    wiring: &mut Wiring<B>,
    accept: &mut AcceptState,
) -> Result<Option<LaunchRequest>, Refused> {
    let frame = match read_frame(&mut wiring.control, ChannelKind::Control) {
        Ok(frame) => frame,
        Err(error) if error.reason() == ProtocolReason::FrameTruncated => {
            note(wiring, DiagnosticNote::ChannelEnded, error.code());
            return Ok(None);
        }
        Err(error) => return Err(refuse_protocol(wiring, error)),
    };
    match accept.accept(&frame) {
        Ok(Accepted::Launch(request)) => {
            note(wiring, DiagnosticNote::FrameAccepted, u32::from(frame.opcode()));
            Ok(Some(request))
        }
        // Unreachable: `AcceptState` refuses a CANCEL before any launch as
        // `FrameOutOfOrder`. Spelled out rather than `_` so a change to the
        // accept state machine has to be decided here too. There is nothing to
        // cancel and, critically, no Job to reap — none has been created.
        Ok(Accepted::Cancel) => Err(refuse_protocol(
            wiring,
            ProtocolError::refused(ProtocolReason::FrameOutOfOrder),
        )),
        Err(error) => Err(refuse_protocol(wiring, error)),
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
