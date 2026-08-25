//! The broker entry point: acquire this process's six descriptors, prove every
//! one is a pipe, then serve one launch over the frozen protocol.
//!
//! # The sequence
//!
//! acquire -> accept -> run -> teardown. The state machine is in `session.rs`;
//! this file only wires the six verified descriptors to it and turns what came
//! back into a stable exit code.
//!
//! # fd1 CARRIES FRAMES, OR IT CARRIES THE INVENTORY — NEVER BOTH
//!
//! Descriptor acquisition has to be observable, or a broker that exits 0 without
//! checking anything passes for a working one. That is why one line of plain
//! ASCII is written on fd1. But fd1 is also the authoritative status channel,
//! and mixing an ASCII line into a binary frame stream would corrupt it for any
//! parent that actually speaks the protocol.
//!
//! Both hold because the two are mutually exclusive IN PRACTICE, not by
//! convention: the line is written only on [`Outcome::NoInstruction`], the one
//! path where fd0 ended before asking for anything and the session therefore
//! wrote NO frame at all. A parent that speaks the protocol sends a frame, never
//! reaches that path, and never sees the line. A parent that says nothing gets
//! the inventory and a clean exit.
//!
//! # What is deliberately NOT here
//!
//! Concurrent-termination idempotence and the forcible-kill grandchild proof
//! belong to the hardening sibling. No placeholder for either appears: a
//! placeholder is a second implementation for its owner to collide with, not a
//! head start.

use std::io::Write;

use moe_windows_job_broker::{
    acquire_from_block, parse_descriptor_block, startup_block, Completion, DescriptorError,
    Outcome, PipeChannel, Session, ShutdownSignal, SystemHandles, SystemStoreLocks, Wiring,
    REQUIRED_DESCRIPTOR_COUNT,
};
use moe_windows_job_core::{RawHandle, SystemWin32};

/// How long a launched child may run before the session terminates it.
const PROVIDER_LAUNCH_TIMEOUT_MS: u32 = 30 * 60 * 1_000;

/// The run finished and everything it claimed was observed.
const EXIT_READY: i32 = 0;

/// Fewer than six descriptors were verified.
///
/// UNREACHABLE BY CONSTRUCTION — `Descriptors` cannot exist unless all six
/// passed — and it keeps its own code precisely because it is unreachable.
/// Folding an impossible state into a neighbour would make the stable-code
/// contract lie on the day the invariant breaks.
const EXIT_INCOMPLETE: i32 = 8;

/// The inventory could not be written, so nothing downstream can know what was
/// verified. An unreportable success is not a success.
const EXIT_REPORT_FAILED: i32 = 9;

/// Refusal codes start above the report failure and are derived from the closed
/// reason vocabulary's declaration order, so each reason has one stable code.
const REFUSAL_BASE: i32 = 10;

/// A launch was refused. The REFUSED frame on fd1 carries which layer and why;
/// this code says only that nothing ran.
const EXIT_LAUNCH_REFUSED: i32 = 20;

/// A child ran but its end could not be fully observed. Distinct from
/// [`EXIT_READY`] because an unobserved end must never read as a clean one.
const EXIT_UNOBSERVED: i32 = 21;

/// This helper is never asked to stop from outside today.
///
/// A real signal source is the hardening sibling's, and a stub that pretended to
/// have one would be untested authority. Returning `false` is honest: nothing
/// asks.
struct NeverAsked;

impl ShutdownSignal for NeverAsked {
    fn requested(&self) -> bool {
        false
    }
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let handles = SystemHandles;
    let (block, declared) = startup_block();

    // PARSED FOR VALUES, ACQUIRED FOR OWNERSHIP. `parse_descriptor_block` is
    // pure — it asks the kernel nothing and takes ownership of nothing — so
    // reading the handle values from it and the ownership from
    // `acquire_from_block` cannot disagree and cannot double-own. It is the only
    // way to reach the values at all: `Descriptors` publishes none, by design.
    let values = match parse_descriptor_block(&block, declared) {
        Ok(values) => values,
        Err(refusal) => return code_for(refusal),
    };
    let descriptors = match acquire_from_block(&block, declared, &handles) {
        Ok(descriptors) => descriptors,
        Err(refusal) => return code_for(refusal),
    };
    let verified = descriptors.verified();

    let mut wiring = Wiring {
        control: PipeChannel::over(values[0]),
        status: PipeChannel::over(values[1]),
        diagnostics: PipeChannel::over(values[2]),
        provider_out: PipeChannel::over(values[4]),
        provider_err: PipeChannel::over(values[5]),
    };
    // fd3, fd4 and fd5 become the child's standard input, output and error. The
    // array's fixed size is what carries "exactly three, never more" — fd0, fd1
    // and fd2 are structurally unable to reach it.
    let inherited =
        [RawHandle::new(values[3]), RawHandle::new(values[4]), RawHandle::new(values[5])];

    let calls = SystemWin32;
    let locks = SystemStoreLocks;
    let locked = Session::new(&calls, inherited, PROVIDER_LAUNCH_TIMEOUT_MS)
        .run_with_store_lock(&mut wiring, &NeverAsked, &locks);
    let outcome = locked.outcome();

    let code = match outcome {
        // The only path that wrote no frame, so fd1 is still free for the line.
        Outcome::NoInstruction => match report(verified) {
            Ok(()) if verified == REQUIRED_DESCRIPTOR_COUNT => EXIT_READY,
            Ok(()) => EXIT_INCOMPLETE,
            Err(_) => EXIT_REPORT_FAILED,
        },
        Outcome::NotLaunched(_) => EXIT_LAUNCH_REFUSED,
        Outcome::Ran(_, Completion::Completed(_)) => EXIT_READY,
        Outcome::Ran(_, Completion::Unknown(_)) => EXIT_UNOBSERVED,
    };

    // Closed LAST, and its outcome is not discarded: a close that failed leaves
    // an unknown, and reporting success over it would be inventing evidence.
    let descriptors_closed = descriptors.close();
    // Store ownership extends through final broker descriptor teardown. The
    // guard then closes normally; a crash or kill lets the kernel close it.
    drop(locked);
    match descriptors_closed {
        Ok(()) => code,
        Err(refusal) if code == EXIT_READY => code_for(refusal),
        Err(_) => code,
    }
}

fn report(verified: usize) -> std::io::Result<()> {
    let mut out = std::io::stdout();
    writeln!(out, "descriptors ready {verified} of {REQUIRED_DESCRIPTOR_COUNT}")?;
    out.flush()
}

/// One stable exit code per refusal reason.
fn code_for(refusal: DescriptorError) -> i32 {
    REFUSAL_BASE + i32::try_from(refusal.reason().ordinal()).unwrap_or(i32::MAX - REFUSAL_BASE)
}
