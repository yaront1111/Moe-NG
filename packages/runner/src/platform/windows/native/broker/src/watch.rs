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
//! noticed between waits. Waiting for a whole finite provider timeout in one call
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
//! # FD0 IS OBSERVED, NEVER WAITED ON
//!
//! `ByteChannel::read` is synchronous: a real Win32 pipe with no data pending
//! BLOCKS in it until bytes arrive or the writer closes. A parent that sends
//! LAUNCH and then holds fd0 open and silent — which is what an ordinary
//! provider run looks like — would strand this loop there, and a child exiting
//! meanwhile would not be observed until the parent wrote or closed. The run
//! then died at its finite deadline with the child's real exit unseen.
//!
//! So this loop uses `poll_read` and NEVER `read`. Its three answers are kept
//! distinct here: `Pending` is a silent open fd0 and continues the loop with no
//! refusal of any kind, an end of stream stays `ControlEnded`, and a readiness
//! failure stays an exact protocol refusal.
//!
//! # THE ACCUMULATOR OUTLIVES THE SLICE
//!
//! One [`PolledFrames`] is built before the loop and reused by every turn,
//! because a frame can arrive in pieces: readiness says only that SOME bytes are
//! there, so a CANCEL split across turns is assembled across turns. Building it
//! inside the loop, or dropping it on `Pending`, would re-read a frame's tail as
//! a header and refuse a legal CANCEL as a version mismatch.

use moe_windows_job_core::{
    wait_for_process, ContainedProcess, ProcessCalls, Waited, Win32Calls,
};

use core::task::Poll;

use crate::control::{AcceptState, Accepted};
use crate::diagnostics::DiagnosticNote;
use crate::frames::{polling::PolledFrames, ByteChannel, ChannelKind};
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
    deadline_ms: Option<u32>,
) -> (Stopped, Option<Waited>)
where
    C: Win32Calls + ProcessCalls,
    B: ByteChannel,
    S: ShutdownSignal,
{
    // Project stacks pass no deadline: the same bounded wait slices keep
    // CANCEL, fd0 closure and helper shutdown responsive for their full life.
    let mut remaining = deadline_ms;
    // BUILT ONCE, OUTSIDE THE LOOP. See the module docs: a per-turn accumulator
    // would lose the half of a frame that arrived in the previous turn.
    let mut frames = PolledFrames::on(ChannelKind::Control);
    loop {
        // CHECKED FIRST, so a helper already asked to stop never starts another
        // wait it would have to be interrupted out of.
        if shutdown.requested() {
            return (Stopped::Shutdown, None);
        }

        let slice = remaining
            .map_or(CONTROL_POLL_SLICE_MS, |left| left.min(CONTROL_POLL_SLICE_MS));
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

        if let Some(left) = remaining.as_mut() {
            *left = left.saturating_sub(slice);
            if *left == 0 {
                return (Stopped::TimedOut, Some(waited));
            }
        }
        if let Some(stopped) = take_instruction(wiring, &mut frames, accept) {
            return (stopped, Some(waited));
        }
    }
}

/// Takes one frame from fd0 IF ONE IS THERE, and reports whether it ends the
/// run.
///
/// Returns `None` when fd0 produced nothing terminal — either no complete frame
/// yet (`Pending`), or, in a future protocol, a command that leaves the run
/// going. Today every legal frame after a launch is terminal; the shape is kept
/// so a non-terminal command has somewhere to land without restructuring the
/// loop.
fn take_instruction<B: ByteChannel>(
    wiring: &mut Wiring<B>,
    frames: &mut PolledFrames,
    accept: &mut AcceptState,
) -> Option<Stopped> {
    let frame = match frames.poll_frame(&mut wiring.control) {
        // NOT AN OUTCOME AND NOT A REFUSAL: fd0 is open and has said nothing, so
        // the run continues and the next slice waits on the child again.
        Ok(Poll::Pending) => return None,
        Ok(Poll::Ready(frame)) => frame,
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
