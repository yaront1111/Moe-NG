//! The broker entry point: acquire this process's six descriptors, prove every
//! one is a pipe, report what was verified, and exit with a stable code.
//!
//! # What is deliberately NOT here
//!
//! No frame codec, no control or status vocabulary, no CANCEL, no Job creation,
//! no process launch, no lifecycle delegation, no completion semantics and no
//! idempotence. Those belong to SPIDR siblings 3b (protocol), 3c (session) and
//! 3d (hardening). Not even a placeholder for one appears here: a placeholder is
//! a second implementation for their owner to collide with in a shared working
//! directory, not a head start.
//!
//! # Why the report goes to fd1 and looks nothing like a frame
//!
//! The DoD requires the child's descriptor INVENTORY to be observable, so a
//! broker that exits 0 without checking anything cannot pass for a working one.
//! One line of plain ASCII on fd1 is that report. fd3/fd4/fd5 are the protocol
//! channels and this binary writes NOTHING to them.
//!
//! The line carries no handle value, no path, no argument and no environment
//! entry — the same rail the refusal codes are held to.

use std::io::Write;

use moe_windows_job_broker::{
    acquire, DescriptorError, SystemHandles, REQUIRED_DESCRIPTOR_COUNT,
};

/// All six descriptors acquired, verified as pipes, and closed cleanly.
const EXIT_READY: i32 = 0;

/// Fewer than six descriptors were verified.
///
/// UNREACHABLE BY CONSTRUCTION — `Descriptors` cannot exist unless all six
/// passed — and it has its own code precisely because it is unreachable. Folding
/// an impossible state into either "ready" or "report failed" would make the
/// stable-code contract lie about which thing went wrong on the day the
/// invariant breaks.
const EXIT_INCOMPLETE: i32 = 8;

/// The inventory could not be written, so nothing downstream can know what was
/// verified. An unreportable success is not a success.
const EXIT_REPORT_FAILED: i32 = 9;

/// Refusal codes start above the report failure and are derived from the closed
/// reason vocabulary's declaration order, so each reason has one stable code.
const REFUSAL_BASE: i32 = 10;

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let calls = SystemHandles;
    let descriptors = match acquire(&calls) {
        Ok(descriptors) => descriptors,
        Err(refusal) => return code_for(refusal),
    };

    // Reported BEFORE the close, because closing fd1 is what makes the report
    // unwritable. The flush is not optional for the same reason: process::exit
    // runs no destructors, so a buffered line would be lost.
    let verified = descriptors.verified();
    if report(verified).is_err() {
        // The descriptors still close on the way out via their drop guard.
        return EXIT_REPORT_FAILED;
    }

    match descriptors.close() {
        Ok(()) if verified == REQUIRED_DESCRIPTOR_COUNT => EXIT_READY,
        Ok(()) => EXIT_INCOMPLETE,
        Err(refusal) => code_for(refusal),
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
