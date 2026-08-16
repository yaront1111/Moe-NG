//! The three preconditions a terminal COMPLETED requires, checked in order.
//!
//! SCOPE. What is observed about a child's end. WHY the run ended is
//! `watch.rs`'s, and the launch that preceded it is `session.rs`'s.
//!
//! # All three, or UNKNOWN
//!
//! The Job reporting zero live processes, the retained root handle waited, and
//! the exit queried exactly — in that order, which is the order they are checked
//! below. The first that was not observed returns, naming itself, so a COMPLETED
//! frame is reachable from exactly one path: the one where every observation was
//! made.
//!
//! # THERE WAS A FOURTH. IT WAS DELETED, NOT WEAKENED — DO NOT RESTORE IT.
//!
//! A provider-EOF leg used to sit after the exit query: `drained()` read fd4 and
//! fd5 until `Ok(0)` and withheld COMPLETED unless both ended. It is gone
//! because THE OBSERVATION IS STRUCTURALLY IMPOSSIBLE FROM HERE, not because it
//! was inconvenient.
//!
//! fd4 and fd5 are DUPLEX handles, and they are the SAME handles the broker
//! hands the child as its stdout and stderr — `main.rs` puts `values[4]` and
//! `values[5]` into both `Wiring` and `inherited`. The child's writes therefore
//! travel toward the PARENT's end, and a read on this side faces the direction
//! only the parent ever writes. The parent never writes there, so the drain
//! could not end when the child exited; it ended when the PARENT tore its
//! endpoint down. Measured consequence: completion latency tracked the
//! configured timeout linearly (1000ms -> 1488ms, 2500ms -> 2996ms) against a
//! child that lived 150ms.
//!
//! THE DECISIVE EVIDENCE IS EMPIRICAL, not this handle reading. In the candidate
//! run the drain returned on its FIRST poll with ZERO bytes available while the
//! parent still captured byte-exact stdout AND stderr. `drained()` DISCARDED
//! what it read — had it faced the child's output direction, those bytes would
//! have been eaten and the capture would have come back empty.
//!
//! What carries termination instead is the Job-empty proof below, EXPLICITLY: a
//! process still holding a write end has not left the Job, so a provider that
//! never ends reaches `Unobserved::JobActive` by the leg that can actually see
//! it. That is why the deletion is not a fail-open — and why weakening
//! `wait_until_job_is_empty`, the reap ordering, or `query_exit_status` would
//! turn an honest simplification into one.
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
use crate::status::Completed;

/// How long the settling wait may block after the child has been told to stop.
const SETTLE_WAIT_MS: u32 = 5_000;

/// Settles one child's end, or reports which observation was missing.
///
/// TAKES NO CHANNEL, DELIBERATELY. Nothing a provider channel can report is
/// evidence about the child's end — see the module header — so this function has
/// no way to consult one even by accident.
pub(crate) fn settle<C>(
    calls: &C,
    job: &Job<'_, C>,
    contained: &ContainedProcess<'_, C>,
    stopped: Stopped,
    observed: Option<Waited>,
) -> Completion
where
    C: Win32Calls + ProcessCalls,
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

    // EVERY REMAINING OBSERVATION WAS MADE, so this is the one path COMPLETED is
    // reachable from. Nothing below this line may add a leg that cannot fail.
    Completion::Completed(Completed::Exited(code))
}
