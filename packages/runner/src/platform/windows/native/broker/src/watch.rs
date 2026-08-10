//! The run loop: wait on the child, and take one control instruction between
//! waits.
//!
//! SCOPE. Deciding WHY a run ended. What is then observed about the child's end
//! lives in `settle.rs`, and the launch that precedes this lives in
//! `session.rs`.
//!
//! # Why the wait is sliced
//!
//! The session is single-threaded by construction, so a CANCEL can only be
//! noticed between waits. Waiting for the whole instructed timeout in one call
//! would make four of the five termination paths unreachable; polling fd0 in a
//! tight loop would burn a core. A bounded slice is the honest middle: it caps
//! how long an instruction waits to be seen without turning the wait into a spin.
//!
//! # A truncated frame IS a channel that ended
//!
//! `read_frame` reports `FrameTruncated` both for a clean end of stream and for
//! a parent that died mid-frame. The honest reading of the two is identical — no
//! further instruction can be trusted from fd0 — so they share one outcome
//! rather than the second being dressed up as a protocol violation.
//!
//! # KNOWN LIMITATION: [`take_instruction`] BLOCKS ON A REAL PIPE
//!
//! `ByteChannel::read` is synchronous, and a real Win32 pipe with no data
//! pending BLOCKS until bytes arrive or the writer closes. So on a real parent
//! that sends LAUNCH and then holds fd0 open and silent, this loop reaches
//! `take_instruction` after the first slice and stays there — and a child that
//! exits meanwhile is not observed until the parent writes or closes.
//!
//! NO TEST CAN SEE THIS, which is why it is written down rather than left to be
//! rediscovered: the scripted channel returns from every read immediately, so
//! the suite exercises the intended interleaving and a real pipe does not
//! produce it. The shipped binary is unaffected TODAY only because the sole
//! real-parent path in the crate (tests/node_loadability.rs) sends nothing at
//! all and takes `Outcome::NoInstruction` without entering this loop.
//!
//! The fix is an I/O-model change, not a reordering: fd0 must be read through
//! overlapped I/O, or by a reader thread, or gated on `PeekNamedPipe`. Each adds
//! a Win32 surface and concurrency this task deliberately does not own. Reversing
//! the order here does not help — waiting the full timeout before reading fd0
//! makes CANCEL cost a whole timeout instead, which is the same defect wearing
//! the other hat.

use moe_windows_job_core::{
    wait_for_process, ContainedProcess, ProcessCalls, Waited, Win32Calls,
};

use crate::control::{AcceptState, Accepted};
use crate::diagnostics::DiagnosticNote;
use crate::frames::{read_frame, ByteChannel, ChannelKind};
use crate::protocol::{ProtocolError, ProtocolReason};
use crate::completion::Stopped;
use crate::session::{note, refuse_protocol, ShutdownSignal, Wiring};

/// How long one wait on the child may block before the session looks at fd0.
const CONTROL_POLL_SLICE_MS: u32 = 50;

/// Waits on the child until something ends the run, and reports the last
/// observation made.
///
/// The observation is handed back rather than dropped because a signalled wait
/// carries the core's `SignalledProof`, which is bound to this handle and is not
/// reproducible: discarding it would force a second wait whose answer could
/// legitimately differ.
pub(crate) fn watch<C, B, S>(
    calls: &C,
    wiring: &mut Wiring<B>,
    shutdown: &S,
    contained: &ContainedProcess<'_, C>,
    accept: &mut AcceptState,
    timeout_ms: u32,
) -> (Stopped, Option<Waited>)
where
    C: Win32Calls + ProcessCalls,
    B: ByteChannel,
    S: ShutdownSignal,
{
    let mut remaining = timeout_ms;
    loop {
        // CHECKED FIRST, so a helper already asked to stop never starts another
        // wait it would have to be interrupted out of.
        if shutdown.requested() {
            return (Stopped::Shutdown, None);
        }

        let slice = remaining.min(CONTROL_POLL_SLICE_MS);
        let Ok(waited) = wait_for_process(calls, contained, slice) else {
            return (Stopped::WaitFailed, None);
        };
        if matches!(waited, Waited::Signalled(_)) {
            return (Stopped::Natural, Some(waited));
        }
        // WAIT_ABANDONED is neither "it exited" nor "it is still running".
        // Folding it into either neighbour would report a state nothing saw.
        if matches!(waited, Waited::Abandoned) {
            return (Stopped::WaitFailed, Some(waited));
        }

        remaining = remaining.saturating_sub(slice);
        if remaining == 0 {
            return (Stopped::TimedOut, Some(waited));
        }
        if let Some(stopped) = take_instruction(wiring, accept) {
            return (stopped, Some(waited));
        }
    }
}

/// Reads one frame from fd0 and reports whether it ends the run.
///
/// Returns `None` only when fd0 produced something that leaves the run going,
/// which today is nothing at all — every legal frame after a launch is terminal.
/// The shape is kept so a future non-terminal command has somewhere to land
/// without restructuring the loop.
fn take_instruction<B: ByteChannel>(
    wiring: &mut Wiring<B>,
    accept: &mut AcceptState,
) -> Option<Stopped> {
    let frame = match read_frame(&mut wiring.control, ChannelKind::Control) {
        Ok(frame) => frame,
        Err(error) if error.reason() == ProtocolReason::FrameTruncated => {
            note(wiring, DiagnosticNote::ChannelEnded, error.code());
            return Some(Stopped::ControlEnded);
        }
        Err(error) => {
            refuse_protocol(wiring, error);
            return Some(Stopped::ControlRefused);
        }
    };

    match accept.accept(&frame) {
        Ok(Accepted::Cancel) => Some(Stopped::Cancelled),
        // Unreachable: `AcceptState` refuses a second launch as
        // `DuplicateLaunch`. Spelled out rather than `_` so a change to the
        // accept state machine has to be decided here too, and refused with the
        // reason that state machine would itself have produced rather than one
        // invented at this call site.
        Ok(Accepted::Launch(_)) => {
            refuse_protocol(wiring, ProtocolError::refused(ProtocolReason::DuplicateLaunch));
            Some(Stopped::ControlRefused)
        }
        Err(error) => {
            refuse_protocol(wiring, error);
            Some(Stopped::ControlRefused)
        }
    }
}
