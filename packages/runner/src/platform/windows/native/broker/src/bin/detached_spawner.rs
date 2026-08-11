//! A cooperating provider that puts a DELIBERATELY DETACHED grandchild inside
//! the broker's Job, reports both identities, and then parks until it is killed.
//!
//! THIS IS A COMMITTED TEST FIXTURE, NOT SMOKE-TEST LEFTOVER, on the same footing
//! as `handle_probe.rs`: cargo autobins discovers `src/bin/*.rs` with no manifest
//! entry and hands `CARGO_BIN_EXE_detached_spawner` to integration tests. It is
//! source; only its compiled output lands in the ignored target tree.
//!
//! # WHAT "DETACHED" MEANS HERE, AND WHY THAT IS THE WHOLE POINT
//!
//! The grandchild is detached from every mechanism a naive teardown would use,
//! and from exactly one it cannot be:
//!
//! ```text
//! DETACHED_PROCESS           no console, so a console control event misses it
//! CREATE_NEW_PROCESS_GROUP   its own group, so a group signal misses it
//! CREATE_NO_WINDOW           no window, so a window message misses it
//! Stdio::null() on all three no inherited handle ties it to this process
//! (not breakaway)            it is STILL IN THE JOB, and that is the evidence
//! ```
//!
//! A parent that terminated only the process it created would leave this one
//! running. The containment guarantee is that closing the last Job handle kills
//! it anyway, and the grandchild exists to make the difference between those two
//! observable. `CREATE_BREAKAWAY_FROM_JOB` is deliberately NOT set: with it the
//! grandchild would genuinely escape and the test would be asserting a different,
//! false property. The core's `REQUIRED_LIMIT_FLAGS` does not permit breakaway
//! either, so the kernel would refuse it regardless.
//!
//! # `Stdio::null()` IS LOAD-BEARING, NOT TIDINESS
//!
//! The broker hands fd3/fd4/fd5 to its provider as standard input, output and
//! error. If the grandchild inherited fd4 or fd5 it would hold their write ends
//! open, `settle`'s provider drain would never observe end of stream, and the
//! session would stall in a way that reads as a broker defect. Nulling all three
//! is what keeps the detachment about process lifetime rather than about pipes.
//!
//! # IT RESTATES NO SYSCALL (taskRail 5)
//!
//! Both creation times come from the core's `ProcessCalls::creation_time`, the
//! same implementation the broker's own identity reporting uses. The PIDs come
//! from `std`. This file opens no process, creates no Job and waits on nothing:
//! spawning a plain child is not broker Job authority.

use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

use moe_windows_job_core::{ProcessCalls, RawHandle, SystemWin32};

/// The argv marker that makes this binary the PARKED GRANDCHILD rather than the
/// spawner. One binary in two roles keeps the fixture to a single source file
/// and guarantees the grandchild is an image the test already trusts.
const PARK: &str = "--park";

/// `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`.
///
/// Spelled as literals because `std`'s `creation_flags` takes a raw `u32` and
/// the crate deliberately does not depend on windows-sys for process creation.
const DETACHED_FLAGS: u32 = 0x0000_0008 | 0x0000_0200 | 0x0800_0000;

/// `GetCurrentProcess()` — the pseudo handle every process holds for itself.
///
/// Used rather than opening a real handle to this process, because the core has
/// no open-by-PID on purpose (a PID is reused, so reopening one could act on an
/// unrelated process) and a pseudo handle needs no such lookup.
const CURRENT_PROCESS: isize = -1;

/// How long a parked process waits before giving up and exiting.
///
/// A BOUND, NOT A TIMER THE PROOF DEPENDS ON. If containment works, both
/// processes die within milliseconds of the kill and nothing here is reached; if
/// it fails, this stops a leaked grandchild living forever on the host. It
/// cannot manufacture a passing death proof, because the test asserts both
/// processes are ALIVE before the kill and dead seconds after it — orders of
/// magnitude inside this bound.
const PARK_BOUND: Duration = Duration::from_secs(120);

/// No report path was given, so nothing downstream could ever read an identity.
const EXIT_NO_REPORT_PATH: i32 = 2;
/// This process could not name its own image, so no grandchild could be spawned.
const EXIT_NO_IMAGE: i32 = 3;
/// The grandchild could not be created.
const EXIT_SPAWN_FAILED: i32 = 4;
/// An identity could not be queried. Reporting a PID without its creation time
/// would hand the test exactly the PID-only evidence rail 1 forbids.
const EXIT_IDENTITY_FAILED: i32 = 5;
/// The report could not be published, so an unobservable success is not one.
const EXIT_REPORT_FAILED: i32 = 6;

fn main() {
    let mut arguments = std::env::args().skip(1);
    let Some(first) = arguments.next() else {
        std::process::exit(EXIT_NO_REPORT_PATH);
    };
    if first == PARK {
        park();
        return;
    }
    std::process::exit(spawn_and_report(&first));
}

/// Blocks until something kills this process, or the bound expires.
fn park() {
    std::thread::sleep(PARK_BOUND);
}

/// Spawns the detached grandchild, publishes both identities, then parks.
///
/// The child handle is held for the whole function because the creation-time
/// query needs it. It is never waited on and never killed here: this process
/// dying must NOT take the grandchild with it, or the containment proof would be
/// measuring ordinary parent-child cleanup instead of the Job.
fn spawn_and_report(report: &str) -> i32 {
    let Ok(image) = std::env::current_exe() else {
        return EXIT_NO_IMAGE;
    };
    let Ok(mut grandchild) = Command::new(image)
        .arg(PARK)
        .creation_flags(DETACHED_FLAGS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return EXIT_SPAWN_FAILED;
    };

    let calls = SystemWin32;
    let handle = RawHandle::new(grandchild.as_raw_handle() as isize);
    let (Ok(mine), Ok(theirs)) =
        (calls.creation_time(RawHandle::new(CURRENT_PROCESS)), calls.creation_time(handle))
    else {
        return orphaned(&mut grandchild, EXIT_IDENTITY_FAILED);
    };

    let lines = format!(
        "parent {} {}\ngrandchild {} {}\n",
        std::process::id(),
        mine,
        grandchild.id(),
        theirs
    );
    if publish(report, &lines).is_err() {
        return orphaned(&mut grandchild, EXIT_REPORT_FAILED);
    }

    park();
    0
}

/// Kills a grandchild whose identity will never be published, and reports why.
///
/// AN UNPUBLISHABLE GRANDCHILD IS UNREAPABLE. The test terminates processes by
/// `(pid, creation_time)` read from the report, so a grandchild that never
/// reaches the report cannot be named by anything afterwards and would sit out
/// its whole park. Killing it here is the only point at which it is still
/// identified. This is the ONE path on which this binary kills what it spawned:
/// on every successful path the grandchild must outlive its parent, or the
/// containment proof would be measuring ordinary parent-child cleanup.
fn orphaned(grandchild: &mut std::process::Child, code: i32) -> i32 {
    let _ = grandchild.kill();
    let _ = grandchild.wait();
    code
}

/// Writes the report beside its final name, then renames it into place.
///
/// PUBLISHED ATOMICALLY BECAUSE THE READER IS POLLING. The test waits for this
/// file to appear; a reader that caught a partially written one would parse
/// half an identity and fail for a reason that has nothing to do with
/// containment. A rename makes the file's existence and its completeness the
/// same event.
fn publish(report: &str, lines: &str) -> std::io::Result<()> {
    let staged = format!("{report}.partial");
    {
        let mut file = std::fs::File::create(&staged)?;
        file.write_all(lines.as_bytes())?;
        file.flush()?;
        file.sync_all()?;
    }
    std::fs::rename(&staged, report)
}
