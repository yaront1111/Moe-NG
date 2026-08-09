//! The real lifecycle boundary, over windows-sys.
//!
//! Split out of `system_process.rs` by RESPONSIBILITY: that file owns the
//! construction arms, this one owns wait, exit query, terminate and the image
//! query. Rust allows only one `impl ProcessCalls for SystemWin32`, so the trait
//! methods stay there and delegate here — the same shape `system_process_attrs`
//! already uses.
//!
//! Every `unsafe` block sits behind a SAFETY comment, and the `as_handle`,
//! `last_error` and `check` helpers are the ones `system_process.rs` already
//! declares rather than a second error-handling style.

use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_NAME_WIN32,
};

use super::system_process::{as_handle, check, last_error};
use super::{NativeError, NativeOp, RawHandle, WaitOutcome};

/// The exit code a terminated child is given.
///
/// Any nonzero value would do; it exists so a caller reading the exit code after
/// a terminate cannot mistake it for a clean exit 0.
const TERMINATED_EXIT_CODE: u32 = 1;

/// Buffer size, in WCHARs, for an image path: the Windows extended-length path
/// maximum. Sized once rather than grown on `ERROR_INSUFFICIENT_BUFFER`, because
/// no path can exceed it, so the retry branch would be unreachable and untested.
const IMAGE_NAME_CAPACITY: usize = 32_768;

/// Waits on a process handle and reports which of the four `WAIT_*` results it
/// got.
///
/// NOT A BOOL CHECK, AND NOT A `!= WAIT_OBJECT_0` CHECK. `WaitForSingleObject`
/// returns a `WAIT_EVENT`, and three of its values are legitimate observations:
/// a timeout means the process is still running, which is the only way to prove
/// a suspended thread never ran. Only `WAIT_FAILED` is a call failure.
pub(super) fn wait(process: RawHandle, timeout_ms: u32) -> Result<WaitOutcome, NativeError> {
    // SAFETY: `process` is an open process handle from this boundary.
    // WaitForSingleObject has no out-parameters and no other preconditions.
    let event = unsafe { WaitForSingleObject(as_handle(process), timeout_ms) };
    match event {
        WAIT_OBJECT_0 => Ok(WaitOutcome::Signalled),
        WAIT_TIMEOUT => Ok(WaitOutcome::TimedOut),
        WAIT_ABANDONED => Ok(WaitOutcome::Abandoned),
        WAIT_FAILED => Err(last_error(NativeOp::WaitForProcess)),
        // Fail closed. Any other WAIT_EVENT is a result this code has not
        // reasoned about, so it becomes our refusal (code 0) rather than being
        // guessed into one of the four cases above.
        _ => Err(NativeError::new(NativeOp::WaitForProcess, 0)),
    }
}

/// The raw `GetExitCodeProcess` value, with no interpretation.
///
/// 259 is returned both by a running process and by one that exited with 259.
/// This function does not and cannot tell them apart, and deliberately does not
/// try: the caller is only allowed to ask after a wait reported the process
/// signalled. See `lifecycle::query_exit_status`.
pub(super) fn exit_code(process: RawHandle) -> Result<u32, NativeError> {
    let mut code: u32 = 0;
    // SAFETY: `code` is a live, correctly typed out-parameter, and `process` is
    // an open process handle from this boundary.
    let ok = unsafe { GetExitCodeProcess(as_handle(process), &mut code) };
    check(NativeOp::QueryExitCode, ok)?;
    Ok(code)
}

/// Terminates the process.
///
/// `Ok` MEANS THE REQUEST WAS ACCEPTED, NOT THAT THE PROCESS IS GONE.
/// Termination is asynchronous; only a subsequent wait observes the end.
pub(super) fn terminate(process: RawHandle) -> Result<(), NativeError> {
    // SAFETY: `process` is an open process handle from this boundary.
    let ok = unsafe { TerminateProcess(as_handle(process), TERMINATED_EXIT_CODE) };
    check(NativeOp::TerminateProcess, ok)
}

/// The full path of the image this process is running.
///
/// THE SIZE IS IN WCHARS, NOT BYTES, and it is an IN/OUT parameter:
/// `QueryFullProcessImageNameW` overwrites it with the number of characters it
/// wrote, NOT counting the terminating NUL. Truncating to the buffer's capacity
/// instead of to that reported length would return tens of thousands of trailing
/// zeros. The returned vector is the path alone and is deliberately NOT
/// NUL-terminated: it is an output value, never a `PCWSTR` handed back to Win32.
pub(super) fn image_name(process: RawHandle) -> Result<Vec<u16>, NativeError> {
    let mut buffer = vec![0u16; IMAGE_NAME_CAPACITY];
    let mut size = buffer.len() as u32;
    // SAFETY: the buffer is live and owns `size` WCHARs, and `size` is a live
    // out-parameter. `process` is an open process handle from this boundary.
    let ok = unsafe {
        QueryFullProcessImageNameW(
            as_handle(process),
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut size,
        )
    };
    check(NativeOp::QueryImageName, ok)?;
    buffer.truncate(size as usize);
    Ok(buffer)
}
