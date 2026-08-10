//! The real Win32 boundary: `GetStartupInfoW`, `GetFileType`, `CloseHandle`.
//!
//! `unsafe` is confined to this file. No other module in the crate contains
//! any, which is the same discipline `win32.rs` keeps in the core crate.
//!
//! Nothing here decides anything. It reads what Windows says and hands the
//! numbers up; the refusal vocabulary and the ownership rules live in
//! `descriptors.rs` and `verify.rs`.

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_PIPE, FILE_TYPE_UNKNOWN};
use windows_sys::Win32::System::Threading::{GetStartupInfoW, STARTUPINFOW};

use crate::descriptors::DescriptorError;
use crate::verify::{acquire_from_block, Descriptors, HandleCalls, PIPE_FILE_TYPE};

/// Compile-time proof that the constant `verify.rs` compares against is the real
/// one. If windows-sys ever disagrees — or if someone reaches for
/// `FILE_TYPE_CHAR`, which is 2 — this fails the build instead of shipping a
/// broker that refuses every valid pipe.
const _: () = assert!(PIPE_FILE_TYPE == FILE_TYPE_PIPE);

/// The real boundary.
pub struct SystemHandles;

impl HandleCalls for SystemHandles {
    fn file_type(&self, raw: isize) -> Result<u32, u32> {
        // SAFETY: GetFileType has no precondition on its argument. It classifies
        // whatever the value refers to and answers FILE_TYPE_UNKNOWN for
        // anything it cannot, including a value that is not a handle at all.
        let kind = unsafe { GetFileType(raw as HANDLE) };
        if kind != FILE_TYPE_UNKNOWN {
            return Ok(kind);
        }
        // TWO RESULTS READ SEPARATELY. FILE_TYPE_UNKNOWN is both a legitimate
        // answer and the failure signal; only GetLastError separates them, and
        // it must be read before anything else runs.
        //
        // SAFETY: reads this thread's last-error value; no preconditions.
        let code = unsafe { GetLastError() };
        if code == 0 {
            return Ok(kind);
        }
        Err(code)
    }

    fn close_handle(&self, raw: isize) -> Result<(), u32> {
        // SAFETY: `raw` is a handle this process owns exactly one owner for, and
        // that owner marks itself spent before calling, so this runs once.
        let ok = unsafe { CloseHandle(raw as HANDLE) };
        if ok == 0 {
            // SAFETY: read immediately after the failed call.
            return Err(unsafe { GetLastError() });
        }
        Ok(())
    }
}

/// Copies this process's CRT `lpReserved2` block, with the size Windows declared
/// for it.
///
/// Returned as a COPY rather than a borrow: the block lives in the process
/// parameters, and handing out a `'static` slice into memory this crate does not
/// own would be a lifetime claim nothing here can honour. Copying at most
/// `u16::MAX` bytes once at startup costs nothing worth measuring.
///
/// A null pointer and a zero size both come back as an empty block, which
/// `parse_descriptor_block` refuses as `BlockAbsent`. The judgement is left
/// there rather than duplicated here.
pub fn startup_block() -> (Vec<u8>, u16) {
    let mut info = STARTUPINFOW::default();
    // SAFETY: `info` is a live, correctly typed out-parameter. GetStartupInfoW
    // fills it and cannot fail.
    unsafe { GetStartupInfoW(&mut info) };

    let declared = info.cbReserved2;
    if info.lpReserved2.is_null() || declared == 0 {
        return (Vec::new(), declared);
    }
    // SAFETY: the kernel populated lpReserved2 with exactly cbReserved2 bytes of
    // this process's own memory when the process was created, and nothing has
    // freed it — it lives in the process parameters for the process lifetime.
    // The two are read from the same STARTUPINFOW, so the length matches the
    // pointer it describes.
    let block =
        unsafe { core::slice::from_raw_parts(info.lpReserved2, usize::from(declared)) }.to_vec();
    (block, declared)
}

/// Acquires and verifies this process's six descriptors.
pub fn acquire<C: HandleCalls>(calls: &C) -> Result<Descriptors<'_, C>, DescriptorError> {
    let (block, declared) = startup_block();
    acquire_from_block(&block, declared, calls)
}
