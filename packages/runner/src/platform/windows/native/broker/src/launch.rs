//! Turning an accepted launch request into the core's [`ProcessSpec`].
//!
//! SCOPE. Encoding and ownership of the four UTF-16 buffers `CreateProcessW`
//! reads through, and nothing else. No Job, no process, no syscall — this file
//! calls nothing at all. The session sequences; the core acts.
//!
//! # Why a type owns the buffers
//!
//! [`ProcessSpec`]'s fields are borrowed slices handed straight to `unsafe` FFI,
//! and `UpdateProcThreadAttribute` stores POINTERS rather than copying. So the
//! buffers must outlive the spec and must not move while the call is in flight.
//! [`LaunchPlan`] owns them and lends a spec, which makes that a lifetime the
//! compiler checks rather than a comment.
//!
//! # An embedded NUL is refused here, not discovered by Windows
//!
//! A Win32 string function reads until it finds a NUL. A Rust `String` may
//! legally contain one, and a peer chooses every byte of the launch request — so
//! `C:\evil.exe\0C:\real.exe` would silently become `C:\evil.exe` at the
//! boundary, and the environment block would be truncated at the first embedded
//! NUL. The core's `validate` cannot catch it: the slice IS terminated, just not
//! where the sender meant.
//!
//! Refused as [`NativeOp::CreateProcess`] with code 0 — the core's own
//! convention for "the create arm is what is being refused, and this refusal is
//! ours rather than the operating system's" (spec.rs). The vocabulary is
//! consumed, never restated.

use moe_windows_job_core::{
    NativeError, NativeOp, ProcessSpec, RawHandle, INHERITED_HANDLE_COUNT,
};

use crate::control::LaunchRequest;

/// The four buffers a spec borrows, owned together so none can move or outlive
/// the call that reads it.
pub(crate) struct LaunchPlan {
    application: Vec<u16>,
    command_line: Vec<u16>,
    current_directory: Vec<u16>,
    environment: Vec<u16>,
    inherited: [RawHandle; INHERITED_HANDLE_COUNT],
}

impl LaunchPlan {
    /// Encodes a request, or refuses one that cannot cross the FFI boundary
    /// without changing meaning.
    pub(crate) fn from_request(
        request: &LaunchRequest,
        inherited: [RawHandle; INHERITED_HANDLE_COUNT],
    ) -> Result<Self, NativeError> {
        let refusal = NativeError::new(NativeOp::CreateProcess, 0);
        let mut every: Vec<&str> = vec![request.executable(), request.cwd()];
        every.extend(request.argv().iter().map(String::as_str));
        for (key, value) in request.environment() {
            every.push(key);
            every.push(value);
        }
        if every.iter().any(|text| text.contains('\0')) {
            return Err(refusal);
        }

        Ok(Self {
            application: wide(request.executable()),
            command_line: wide(&command_line(request)),
            current_directory: wide(request.cwd()),
            environment: environment_block(request.environment()),
            inherited,
        })
    }

    /// Lends a spec over the buffers this value owns.
    pub(crate) fn spec(&self) -> ProcessSpec<'_> {
        ProcessSpec {
            application: &self.application,
            command_line: &self.command_line,
            current_directory: &self.current_directory,
            environment: &self.environment,
            inherited: self.inherited,
        }
    }
}

/// NUL-terminated UTF-16, which is what every `PCWSTR` field requires.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// `argv[0]` followed by the arguments, each quoted the way the CRT parses.
///
/// The executable is repeated as `argv[0]` because `lpCommandLine` is what the
/// child's own argument parser reads; `lpApplicationName` only tells the kernel
/// which image to load. Omitting it would silently shift every argument by one.
fn command_line(request: &LaunchRequest) -> String {
    let mut line = String::new();
    push_quoted(&mut line, request.executable());
    for argument in request.argv() {
        line.push(' ');
        push_quoted(&mut line, argument);
    }
    line
}

/// Appends one argument using the CRT's quoting rules.
///
/// A BACKSLASH IS ONLY SPECIAL BEFORE A QUOTE. Runs of backslashes are doubled
/// when a quote follows them and left alone otherwise, which is why the count is
/// carried rather than each character being escaped independently. Getting this
/// wrong does not fail loudly — it hands the child a DIFFERENT argument list
/// than the one that was sent.
fn push_quoted(line: &mut String, argument: &str) {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        line.push_str(argument);
        return;
    }

    line.push('"');
    let mut backslashes = 0usize;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                // 2n + 1: the run is doubled so it survives literally, and one
                // more escapes the quote itself.
                push_repeated(line, '\\', backslashes * 2 + 1);
                backslashes = 0;
                line.push('"');
            }
            _ => {
                push_repeated(line, '\\', backslashes);
                backslashes = 0;
                line.push(character);
            }
        }
    }
    // A trailing run sits immediately before the closing quote, so it is doubled
    // for the same reason.
    push_repeated(line, '\\', backslashes * 2);
    line.push('"');
}

fn push_repeated(line: &mut String, character: char, count: usize) {
    for _ in 0..count {
        line.push(character);
    }
}

/// A `CREATE_UNICODE_ENVIRONMENT` block: `KEY=VALUE`, a NUL after each entry,
/// and one more NUL closing the block.
///
/// An EMPTY environment is `[0, 0]`, not `[0]`. The core's `validate` requires
/// the last two units to be zero, and an explicit empty block is what stops the
/// child inheriting this process's environment by accident.
fn environment_block(entries: &[(String, String)]) -> Vec<u16> {
    let mut block: Vec<u16> = Vec::new();
    for (key, value) in entries {
        block.extend(key.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    if block.len() < 2 {
        block.push(0);
    }
    block
}
