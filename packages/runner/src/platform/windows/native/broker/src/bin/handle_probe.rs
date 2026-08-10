//! A cooperating child that reports what IS and IS NOT in its own handle table.
//!
//! THIS IS A COMMITTED TEST FIXTURE, NOT SMOKE-TEST LEFTOVER. Cargo autobins
//! discovers `src/bin/*.rs` with no manifest entry and hands
//! `CARGO_BIN_EXE_handle_probe` to integration tests. It is source; its compiled
//! output lands in the ignored target tree like every other binary.
//!
//! WHY IT HAS TO EXIST. You cannot prove a handle is ABSENT from a child's table
//! by asserting what the parent did not pass — that is the assumption, not the
//! evidence. Only the child can observe its own table, so the observation has to
//! be made there and reported back.
//!
//! HOW IT LEARNS WHAT TO LOOK FOR, and why this is not the argv scheme the plan
//! described. The three ALLOWED handle values arrive on argv, because the parent
//! knows them before launch. The six FORBIDDEN values arrive on STDIN, because
//! two of them — the child's own process and thread handles — are created BY
//! `CreateProcessW` and therefore do not exist while its command line is being
//! built. There is no ordering in which they could be argv.
//!
//! It reports on fd1 and in its exit code, drives nothing, and calls no Job or
//! process API: `GetHandleInformation` and `GetFileType` are the whole surface.

use std::io::{BufRead, Write};

use moe_windows_job_broker::{parse_descriptor_block, startup_block, HandleCalls, SystemHandles};
use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE};

/// Three allowlisted handles in, six forbidden values expected on stdin.
const ALLOWED: usize = 3;
const FORBIDDEN: usize = 6;

fn main() {
    let calls = SystemHandles;
    let allowed: Vec<isize> = std::env::args().skip(1).filter_map(|text| parse(&text)).collect();
    let forbidden = read_forbidden();

    let allowed_report = join(&allowed, |raw| classify_allowed(&calls, raw));
    let forbidden_report = join(&forbidden, |raw| presence(raw));

    let mut out = std::io::stdout();
    let _ = writeln!(out, "crt={}", crt_report(&calls));
    let _ = writeln!(out, "allowed {allowed_report}");
    let _ = writeln!(out, "forbidden {forbidden_report}");
    let _ = out.flush();

    let complete = allowed.len() == ALLOWED && forbidden.len() == FORBIDDEN;
    let holds = allowed.iter().all(|raw| classify_allowed(&calls, *raw) == "pipe")
        && forbidden.iter().all(|raw| presence(*raw) == "absent");
    std::process::exit(i32::from(!(complete && holds)));
}

/// One whitespace-separated line of forbidden handle values.
///
/// The parent writes it AFTER `CreateProcessW` has returned, which is the whole
/// reason this arrives here rather than on argv.
fn read_forbidden() -> Vec<isize> {
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return Vec::new();
    }
    line.split_whitespace().filter_map(parse).collect()
}

fn parse(text: &str) -> Option<isize> {
    text.parse::<i64>().ok().map(|value| value as isize)
}

fn join(values: &[isize], describe: impl Fn(isize) -> &'static str) -> String {
    values
        .iter()
        .enumerate()
        .map(|(index, raw)| format!("{index}={}", describe(*raw)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether a value names anything at all in THIS process's handle table.
///
/// `GetHandleInformation` is the question "is this a handle I hold", asked
/// without touching whatever it might refer to. A value the parent holds but
/// never passed fails here, and that failure is the absence proof.
fn in_table(raw: isize) -> bool {
    let mut flags = 0u32;
    // SAFETY: `flags` is a live out-parameter. The handle value is arbitrary by
    // design — reporting failure for a value we do not hold is the entire point.
    unsafe { GetHandleInformation(raw as HANDLE, &mut flags) != 0 }
}

fn presence(raw: isize) -> &'static str {
    if in_table(raw) {
        "present"
    } else {
        "absent"
    }
}

/// An allowlisted handle must be BOTH in the table and usable as a pipe.
fn classify_allowed(calls: &SystemHandles, raw: isize) -> &'static str {
    if !in_table(raw) {
        return "absent";
    }
    match calls.file_type(raw) {
        Ok(moe_windows_job_broker::PIPE_FILE_TYPE) => "pipe",
        Ok(_) => "other",
        Err(_) => "unknown",
    }
}

/// Whether fd3/fd4/fd5 resolved from this process's OWN CRT block.
///
/// Read-only on purpose: `acquire` would ADOPT all six and close them on drop,
/// including the stdout this report is written to. Nothing is adopted here.
fn crt_report(calls: &SystemHandles) -> String {
    let (block, declared) = startup_block();
    match parse_descriptor_block(&block, declared) {
        Ok(handles) => {
            let pipes = handles[ALLOWED..]
                .iter()
                .filter(|raw| calls.file_type(**raw) == Ok(moe_windows_job_broker::PIPE_FILE_TYPE))
                .count();
            format!("resolved pipes={pipes}")
        }
        // The reason NAME only. It carries no handle value, no path and no
        // argument, which is what makes it safe to print.
        Err(error) => format!("{:?}", error.reason()),
    }
}
