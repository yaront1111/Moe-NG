//! Owned Win32 handle: closes exactly once, and never reports a close it did
//! not observe succeed.
//!
//! WHY THERE ARE TWO CLOSE PATHS. `Drop` cannot return a `Result`, so a
//! Drop-only RAII design has no way to report a failed close — it must discard
//! the outcome. Discarding it converts an UNKNOWN cleanup into an implicit
//! success, which is exactly what DoD item 6 forbids. So the supported path is
//! the explicit, consuming [`OwnedHandle::close`], which hands the error back to
//! the caller. `Drop` remains only as a leak guard for paths that never called
//! it.
//!
//! CLOSE-EXACTLY-ONCE IS BY CONSTRUCTION, NOT BY CONVENTION. `close` consumes
//! the value, so a second explicit close does not compile; the `closed` flag
//! then stops `Drop` from repeating the one that already ran. A double close is
//! unrepresentable rather than merely untested — the drop-counting table in the
//! sweep proves it holds on every path.

use crate::win32::{NativeError, RawHandle, Win32Calls};

/// A handle this crate acquired and is responsible for closing.
pub struct OwnedHandle<'c, C: Win32Calls> {
    raw: RawHandle,
    calls: &'c C,
    closed: bool,
}

impl<'c, C: Win32Calls> OwnedHandle<'c, C> {
    /// Takes ownership of a handle that `calls` produced.
    ///
    /// `pub(crate)`, and that is a containment decision rather than tidiness.
    /// "Closes exactly once" is a guarantee about ONE `OwnedHandle`, not about a
    /// raw handle value. If this were public, a consumer could take [`Self::raw`]
    /// from a live handle and build a SECOND owner over the same value — then
    /// both would close it, and the second close could land on a handle Windows
    /// has already reused for an unrelated object. Keeping construction inside
    /// the crate makes that unrepresentable from outside.
    pub(crate) fn new(raw: RawHandle, calls: &'c C) -> Self {
        Self { raw, calls, closed: false }
    }

    /// `pub(crate)` for the same reason as [`Self::new`]: handing the raw value
    /// out of the crate is what would make a duplicate owner constructible.
    pub(crate) fn raw(&self) -> RawHandle {
        self.raw
    }

    /// Closes the handle and RETURNS the outcome. This is the supported path.
    ///
    /// Consuming `self` is what makes a second explicit close a compile error.
    /// The value is dropped when this returns, but `Drop` finds the flag already
    /// set and does nothing.
    pub fn close(mut self) -> Result<(), NativeError> {
        self.close_once()
    }

    /// Marks the handle spent BEFORE calling, then closes.
    ///
    /// The ordering is the point. If the close fails, its outcome is unknown —
    /// the handle may or may not have been released. Retrying could close a
    /// handle the OS already freed and, worse, one whose value has since been
    /// reused. So the attempt is spent either way and the error is surfaced.
    fn close_once(&mut self) -> Result<(), NativeError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.calls.close_handle(self.raw)
    }
}

impl<C: Win32Calls> Drop for OwnedHandle<'_, C> {
    /// Leak guard only. It cannot report failure, which is precisely why it is
    /// not the supported path — see the module comment.
    fn drop(&mut self) {
        let _ = self.close_once();
    }
}
