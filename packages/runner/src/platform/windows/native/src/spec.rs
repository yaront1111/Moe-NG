//! What `CreateProcessW` is given, what it hands back, and the soundness check
//! on the inputs.
//!
//! Split out of `process.rs` by RESPONSIBILITY, not by reformatting: that file
//! owns the contained-process type and the order its construction runs in, this
//! one owns the value types that cross the FFI boundary and the validation that
//! makes crossing it sound. Both are re-exported from the crate root, so every
//! item still has exactly one public path.

use crate::win32::{NativeError, NativeOp, RawHandle, INHERITED_HANDLE_COUNT};

/// Everything `CreateProcessW` needs, and nothing it does not.
///
/// DELIBERATELY NOT `Debug`, for the same reason [`RawHandle`] is not: every
/// field here is either a raw handle or exactly the executable / command line /
/// working directory / environment that must never reach an error or a log. A
/// derived `Debug` is how that rail gets broken, so it must not compile.
pub struct ProcessSpec<'a> {
    /// `lpApplicationName`, NUL-terminated UTF-16, and NEVER null.
    ///
    /// Letting `CreateProcessW` parse the image out of the command line is the
    /// classic unquoted-path hijack: `C:\Program Files\app.exe` also tries
    /// `C:\Program.exe` first. An explicit application name has no such search.
    pub application: &'a [u16],
    /// `lpCommandLine`, NUL-terminated UTF-16.
    pub command_line: &'a [u16],
    /// `lpCurrentDirectory`, NUL-terminated UTF-16.
    pub current_directory: &'a [u16],
    /// `lpEnvironment`: a DOUBLE-NUL-terminated UTF-16 block, passed with
    /// `CREATE_UNICODE_ENVIRONMENT`. Explicit rather than inherited, so the
    /// child cannot silently pick up this process's environment.
    pub environment: &'a [u16],
    /// The ONLY handles the child may inherit: standard input, output, error.
    ///
    /// Fixed-size, so "exactly three" is carried by the type. This is what the
    /// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` allowlist is built from.
    pub inherited: [RawHandle; INHERITED_HANDLE_COUNT],
}

/// The two handles `CreateProcessW` hands back.
///
/// Not `Debug`, same reason as [`ProcessSpec`]. Both handles are raw here for
/// exactly as long as it takes the caller to wrap them in owners.
pub struct CreatedProcess {
    pub process: RawHandle,
    pub thread: RawHandle,
}

/// Refuses a spec whose strings are not terminated the way `CreateProcessW`
/// requires.
///
/// THIS IS A SOUNDNESS CHECK, NOT A POLICY ONE. [`ProcessSpec`]'s fields are
/// `pub` slices that are handed straight to `unsafe` FFI as `PCWSTR`, and a
/// Win32 string function reads until it finds a NUL. An empty or unterminated
/// slice therefore makes the OS read past the end of the caller's allocation —
/// undefined behaviour that no scripted test can catch, because the double
/// dereferences nothing. Refusing here converts that into a stable refusal.
///
/// Reported as [`NativeOp::CreateProcess`] with code 0: the create arm is what
/// is being refused, and 0 is child 1's convention for "ours, not the operating
/// system's". No call has reached the boundary at this point, so there is no
/// Win32 error to carry, and the refusal is observable as the ABSENCE of every
/// boundary call rather than only as an `Err`.
pub(crate) fn validate(spec: &ProcessSpec<'_>) -> Result<(), NativeError> {
    let refusal = NativeError::new(NativeOp::CreateProcess, 0);
    for string in [spec.application, spec.command_line, spec.current_directory] {
        if string.last() != Some(&0) {
            return Err(refusal);
        }
    }
    // The environment is a BLOCK: every entry is NUL-terminated and the block
    // itself ends with one more NUL, so the last two units are always zero --
    // including for an empty environment, which is exactly `[0, 0]`.
    if spec.environment.len() < 2 || spec.environment[spec.environment.len() - 2..] != [0, 0] {
        return Err(refusal);
    }
    Ok(())
}
