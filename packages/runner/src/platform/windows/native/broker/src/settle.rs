//! The four preconditions a terminal COMPLETED requires, checked in order.
//!
//! SCOPE. What is observed about a child's end. WHY the run ended is
//! `watch.rs`'s, and the launch that preceded it is `session.rs`'s.
//!
//! # All four, or UNKNOWN
//!
//! The retained root handle waited, the exit queried exactly, both provider
//! channels at end of stream, and the Job reporting zero live processes. The
//! first that was not observed returns, naming itself — so a COMPLETED frame is
//! reachable from exactly one path, the one where every observation was made.
//!
//! # The reap comes first, and terminates only when we are ending it
//!
//! A child we have told to stop had not stopped when we last looked, so waiting
//! on it before the terminate would time out for a reason that says nothing. A
//! child that already exited must NOT be terminated — there is nothing to
//! terminate, and doing it anyway would be a second teardown of a dead tree.
//!
//! `unwind_after_membership` is the core's single terminate-and-reap. Calling
//! its two halves separately here is precisely what would produce a second reap
//! and break the exactly-once property, so it is called whole.

use moe_windows_job_core::{
    query_exit_status, unwind_after_membership, wait_for_process, wait_until_job_is_empty,
    ContainedProcess, ExitStatus, Job, ProcessCalls, Waited, Win32Calls,
};

use crate::completion::{Completion, Stopped, Unobserved};
use crate::frames::ByteChannel;
use crate::session::Wiring;
use crate::status::Completed;

/// How long the settling wait may block after the child has been told to stop.
const SETTLE_WAIT_MS: u32 = 5_000;

/// Provider drain buffer, and the read bound that stops a channel which never
/// ends from hanging the session.
const PROVIDER_CHUNK_BYTES: usize = 4_096;
const PROVIDER_READ_BOUND: usize = 4_096;

/// Settles one child's end, or reports which observation was missing.
pub(crate) fn settle<C, B>(
    calls: &C,
    wiring: &mut Wiring<B>,
    job: &Job<'_, C>,
    contained: &ContainedProcess<'_, C>,
    stopped: Stopped,
    observed: Option<Waited>,
) -> Completion
where
    C: Win32Calls + ProcessCalls,
    B: ByteChannel,
{
    let reaped = if stopped.is_termination() {
        unwind_after_membership(job)
    } else {
        // Ordinary completion still proves the Job is empty. Closing the handle
        // is crash safety, not evidence, so this query is not optional.
        wait_until_job_is_empty(job)
    };
    if reaped.is_err() {
        return Completion::Unknown(Unobserved::JobActive);
    }

    // A SIGNALLED OBSERVATION IS REUSED, NEVER RE-MADE. The core's proof is
    // bound to this handle and is not `Clone`; discarding it to wait again would
    // trade a proof we hold for an answer that could legitimately differ.
    // Anything else is re-observed, because it was made before the terminate.
    let observed = match observed {
        Some(waited) if matches!(waited, Waited::Signalled(_)) => Some(waited),
        _ => wait_for_process(calls, contained, SETTLE_WAIT_MS).ok(),
    };

    // THE CORE DECIDES, NOT THIS FILE. `query_exit_status` is handed the
    // observation actually made and answers with a code only when a signalled
    // wait on THIS handle authorises one. There is no branch here that reads a
    // raw exit code, which is what makes an invented number unrepresentable
    // rather than merely absent.
    let code = match query_exit_status(calls, contained, observed.as_ref()) {
        Err(_) => return Completion::Unknown(Unobserved::ExitQuery),
        Ok(ExitStatus::Unknown(reason)) => {
            return Completion::Unknown(Unobserved::RootWait(reason))
        }
        Ok(ExitStatus::Exited(code)) => code.value(),
    };

    // DRAINED INTO SEPARATE VALUES, SO NEITHER READ IS CONDITIONAL ON THE OTHER.
    // Written inline as `!drained(out) || !drained(err)` the second call is
    // skipped whenever the FIRST channel had not ended — so whether fd5 is ever
    // read would depend on fd4's outcome, and a real pipe would be left holding
    // bytes nobody consumed. Binding both first makes the reads unconditional
    // and the verdict independent of evaluation order.
    let out_ended = drained(&mut wiring.provider_out);
    let err_ended = drained(&mut wiring.provider_err);
    if !out_ended || !err_ended {
        return Completion::Unknown(Unobserved::ProviderEof);
    }

    Completion::Completed(Completed::Exited(code))
}

/// Whether a provider channel reached end of stream within its read bound.
///
/// BOUNDED RATHER THAN UNBOUNDED: a channel that never ends would otherwise hang
/// the session forever. Running out of reads returns `false`, so the result
/// stays UNKNOWN rather than being upgraded to an end nothing observed — the
/// fail-closed direction.
///
/// The bytes are discarded. This is the session OBSERVING that a provider ended,
/// not forwarding it: provider content is never parsed, never re-emitted, and
/// never reaches the control decoder.
fn drained<B: ByteChannel>(channel: &mut B) -> bool {
    let mut scratch = [0u8; PROVIDER_CHUNK_BYTES];
    for _ in 0..PROVIDER_READ_BOUND {
        match channel.read(&mut scratch) {
            Ok(0) => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
    false
}
