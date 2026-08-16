//! The real Win32 boundary: `GetStartupInfoW`, `GetFileType`, `CloseHandle`.
//!
//! `unsafe` is confined to this file. No other module in the crate contains
//! any, which is the same discipline `win32.rs` keeps in the core crate.
//!
//! Nothing here decides anything. It reads what Windows says and hands the
//! numbers up; the refusal vocabulary and the ownership rules live in
//! `descriptors.rs` and `verify.rs`.

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_BROKEN_PIPE, ERROR_NO_DATA, HANDLE,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileType, ReadFile, WriteFile, FILE_TYPE_PIPE, FILE_TYPE_UNKNOWN,
};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::{GetStartupInfoW, STARTUPINFOW};

use crate::descriptors::DescriptorError;
use crate::frames::ByteChannel;
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

/// A [`ByteChannel`] over one of this process's descriptor handles.
///
/// BORROWS, OWNS NOTHING, HAS NO `Drop`. `Descriptors` is the sole owner of
/// every handle and closes each exactly once; a channel that also closed one
/// would be precisely the double close this crate is built to make
/// unrepresentable — and the second close could land on a value Windows has
/// since reused. So this holds the raw value and nothing else, the same shape
/// [`HandleCalls`] uses.
pub struct PipeChannel {
    raw: isize,
}

impl PipeChannel {
    pub const fn over(raw: isize) -> Self {
        Self { raw }
    }
}

impl ByteChannel for PipeChannel {
    /// A read of zero means the channel ended.
    ///
    /// A CLOSED PEER IS AN END OF STREAM, NOT A FAILURE, and Windows does not
    /// say so directly: once the writer closes its end, `ReadFile` FAILS with
    /// `ERROR_BROKEN_PIPE` rather than returning zero bytes. Reporting that as
    /// an error would make an ordinary parent disconnect indistinguishable from
    /// a broken pipe, and would make "fd0 reached end of stream" unreachable in
    /// production even though every test can reach it.
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, u32> {
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        let mut taken: u32 = 0;
        // SAFETY: `buffer` is a live slice of exactly `capacity` bytes, `taken`
        // is a live out-parameter, and the handle is one this process verified
        // as a pipe. A null overlapped pointer selects the synchronous form,
        // which is what a handle opened without FILE_FLAG_OVERLAPPED requires.
        let ok = unsafe {
            ReadFile(self.raw as HANDLE, buffer.as_mut_ptr(), capacity, &mut taken, core::ptr::null_mut())
        };
        if ok == 0 {
            // SAFETY: read immediately after the failed call, before anything
            // else on this thread can overwrite it.
            let code = unsafe { GetLastError() };
            if code == ERROR_BROKEN_PIPE {
                return Ok(0);
            }
            return Err(code);
        }
        Ok(taken as usize)
    }

    /// Asks the pipe what it HAS, and takes no more than that.
    ///
    /// TWO CALLS, AND THE FIRST ONE IS THE WHOLE POINT. `PeekNamedPipe` reports
    /// how many bytes are readable and RETURNS IMMEDIATELY — Microsoft documents
    /// it as non-blocking, and it supports anonymous pipes, which is what these
    /// six descriptors are. `ReadFile` is then asked for at most that many, so it
    /// cannot wait for bytes the peer has not written. Peeking without reading
    /// would be useless (the bytes stay), and reading without peeking is exactly
    /// the block this method exists to avoid.
    ///
    /// SAFE ONLY BECAUSE THIS PROCESS HAS ONE READER. The broker is
    /// single-threaded and nothing else reads fd0, so bytes counted by the peek
    /// cannot be taken by anyone before the read. A second reader would make the
    /// count stale and the read able to block; if one is ever added, this method
    /// has to change with it.
    ///
    /// A count of zero is `Pending`, NOT an end of stream: the writer is simply
    /// silent, and answering `Ready(0)` would fabricate an EOF that ends a run
    /// the parent never ended. Only `ERROR_BROKEN_PIPE` — the writer's end
    /// actually closed, the same signal `read` folds to zero — is the end.
    fn poll_read(&mut self, buffer: &mut [u8]) -> Result<core::task::Poll<usize>, u32> {
        let mut available: u32 = 0;
        // SAFETY: the handle is one this process verified as a pipe, `available`
        // is a live out-parameter, and every other parameter is null because this
        // call is asked ONLY for the byte count: no buffer to fill, no bytes-read
        // count, and no bytes-left-this-message, which is documented as zero for
        // a byte-mode pipe and would say nothing here anyway.
        let ok = unsafe {
            PeekNamedPipe(
                self.raw as HANDLE,
                core::ptr::null_mut(),
                0,
                core::ptr::null_mut(),
                &mut available,
                core::ptr::null_mut(),
            )
        };
        if ok == 0 {
            // SAFETY: read immediately after the failed call, before anything
            // else on this thread can overwrite it.
            let code = unsafe { GetLastError() };
            if code == ERROR_BROKEN_PIPE {
                return Ok(core::task::Poll::Ready(0));
            }
            return Err(code);
        }
        if available == 0 {
            return Ok(core::task::Poll::Pending);
        }

        // BOUNDED BY WHAT IS ALREADY THERE, then by what the caller offered.
        // Either bound alone would be wrong: the first without the second
        // overruns the buffer, the second without the first waits.
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX).min(available);
        let mut taken: u32 = 0;
        // SAFETY: same contract as `read` above, with a capacity no larger than
        // the buffer and no larger than the bytes the peek just counted.
        let ok = unsafe {
            ReadFile(self.raw as HANDLE, buffer.as_mut_ptr(), capacity, &mut taken, core::ptr::null_mut())
        };
        if ok == 0 {
            // SAFETY: read immediately after the failed call.
            let code = unsafe { GetLastError() };
            if code == ERROR_BROKEN_PIPE {
                return Ok(core::task::Poll::Ready(0));
            }
            return Err(code);
        }
        Ok(core::task::Poll::Ready(taken as usize))
    }

    /// Writes what the pipe accepts, which may be less than it was offered.
    ///
    /// `ERROR_NO_DATA` is the write-side twin of `ERROR_BROKEN_PIPE`: the reader
    /// has gone. Reported as zero accepted rather than as an error, so the
    /// framing layer refuses the write as a channel that stopped taking bytes
    /// instead of retrying forever against a peer that is never coming back.
    fn write(&mut self, bytes: &[u8]) -> Result<usize, u32> {
        let offered = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
        let mut taken: u32 = 0;
        // SAFETY: same contract as the read above, with an immutable source.
        let ok = unsafe {
            WriteFile(self.raw as HANDLE, bytes.as_ptr(), offered, &mut taken, core::ptr::null_mut())
        };
        if ok == 0 {
            // SAFETY: read immediately after the failed call.
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_DATA || code == ERROR_BROKEN_PIPE {
                return Ok(0);
            }
            return Err(code);
        }
        Ok(taken as usize)
    }
}
