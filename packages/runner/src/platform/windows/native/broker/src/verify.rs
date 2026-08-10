//! Proving each descriptor is a pipe, and owning it so it closes exactly once.
//!
//! SCOPE. The seam to Win32 ([`HandleCalls`]), the ownership discipline, and the
//! composition of "parse the block, then verify what it named". The real
//! implementation of the seam and every `unsafe` block live in `boundary.rs`;
//! the block arithmetic lives in `descriptors.rs`.
//!
//! WHY A SEAM RATHER THAN CALLING WINDOWS DIRECTLY HERE. The same reason the
//! core crate has `Win32Calls`: a test has to be able to count closes per handle
//! without replacing the code that ships. `Counting` in tests/ is a pure
//! delegating decorator over the real boundary, so the pipe check under test is
//! the shipped one.
//!
//! WHY NOT REUSE THE CORE'S `OwnedHandle`. Its constructor is deliberately
//! `pub(crate)`, and the comment there explains why: handing a raw value out of
//! that crate would let a second owner close it. The broker needs an owner over
//! ITS OWN descriptors, so it has a small local one. That is RAII, not
//! duplicated Win32 authority — no Job or process syscall is restated anywhere
//! in this crate.

use crate::descriptors::{
    parse_descriptor_block, DescriptorError, DescriptorReason, REQUIRED_DESCRIPTOR_COUNT,
};

/// `FILE_TYPE_PIPE`.
///
/// THE SINGLE MOST DANGEROUS NUMBER IN THIS CRATE. `FILE_TYPE_CHAR` is 2 and
/// `FILE_TYPE_PIPE` is 3, so an off-by-one here refuses every valid descriptor
/// while looking exactly like a bug in the parent. It is not trusted as a
/// literal: `boundary.rs` carries a `const` assertion comparing it to the
/// windows-sys declaration, so a disagreement fails the BUILD rather than
/// shipping. That is the same guard the core crate puts on
/// `REQUIRED_LIMIT_FLAGS`, and it is stronger than an import — it also catches
/// importing the wrong constant by name.
pub const PIPE_FILE_TYPE: u32 = 3;

/// The Win32 calls descriptor verification needs. One method per failable
/// operation, each carrying the operating system's numeric code and nothing
/// else.
pub trait HandleCalls {
    /// `GetFileType`. `Err` carries `GetLastError` when the call could not
    /// classify the handle at all.
    fn file_type(&self, raw: isize) -> Result<u32, u32>;
    /// `CloseHandle`.
    fn close_handle(&self, raw: isize) -> Result<(), u32>;
}

/// One descriptor this process has verified and is responsible for closing.
///
/// CLOSE-EXACTLY-ONCE IS BY CONSTRUCTION. [`Self::close`] consumes the value, so
/// a second explicit close does not compile, and the `closed` flag stops `Drop`
/// from repeating one that already ran. `Drop` exists only as a leak guard: it
/// cannot return a `Result`, so it cannot report a failed close, which is
/// exactly why it is not the supported path.
pub struct OwnedDescriptor<'c, C: HandleCalls> {
    raw: isize,
    slot: u8,
    calls: &'c C,
    closed: bool,
}

impl<'c, C: HandleCalls> OwnedDescriptor<'c, C> {
    fn new(raw: isize, slot: u8, calls: &'c C) -> Self {
        Self { raw, slot, calls, closed: false }
    }

    /// Closes the descriptor and RETURNS the outcome.
    pub fn close(mut self) -> Result<(), DescriptorError> {
        self.close_once()
    }

    /// Marks the handle spent BEFORE calling, then closes.
    ///
    /// The ordering is the point. A failed close leaves an UNKNOWN outcome — the
    /// handle may or may not have been released — so retrying could close a
    /// value Windows has since reused for something else. The attempt is spent
    /// either way and the error is surfaced instead of being swallowed.
    fn close_once(&mut self) -> Result<(), DescriptorError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.calls
            .close_handle(self.raw)
            .map_err(|code| DescriptorError::at(DescriptorReason::CloseFailed, self.slot, code))
    }
}

impl<C: HandleCalls> Drop for OwnedDescriptor<'_, C> {
    /// Leak guard only — see [`OwnedDescriptor::close`].
    fn drop(&mut self) {
        let _ = self.close_once();
    }
}

/// The six descriptors, all verified as pipes, all owned.
///
/// The type cannot exist in an unverified state: [`acquire_from_block`] is the
/// only constructor and it refuses unless every one of the six was confirmed.
pub struct Descriptors<'c, C: HandleCalls> {
    slots: Vec<OwnedDescriptor<'c, C>>,
}

impl<C: HandleCalls> Descriptors<'_, C> {
    /// How many descriptors were verified. Always
    /// [`REQUIRED_DESCRIPTOR_COUNT`] for a value that exists, and reported
    /// rather than assumed so a caller cannot certify a count it never read.
    pub fn verified(&self) -> usize {
        self.slots.len()
    }

    /// Closes every descriptor and returns the FIRST failure.
    ///
    /// Every one is attempted even after a failure — skipping the rest would
    /// leak them — and a later success can never overwrite the first error.
    pub fn close(mut self) -> Result<(), DescriptorError> {
        let mut first = Ok(());
        for descriptor in self.slots.drain(..) {
            let outcome = descriptor.close();
            if first.is_ok() {
                first = outcome;
            }
        }
        first
    }
}

/// Parses a CRT block and verifies every descriptor it names is a pipe.
///
/// OWNERSHIP IS TAKEN INCREMENTALLY, AND ONLY OVER VERIFIED HANDLES. Each
/// descriptor is adopted the moment it passes, so a refusal at slot 4 drops the
/// four already adopted and closes each exactly once. The handle that FAILED is
/// never adopted: closing a handle whose identity could not be established is
/// the double-close hazard, not tidiness.
pub fn acquire_from_block<'c, C: HandleCalls>(
    block: &[u8],
    declared: u16,
    calls: &'c C,
) -> Result<Descriptors<'c, C>, DescriptorError> {
    let raw_handles = parse_descriptor_block(block, declared)?;
    let mut slots = Vec::with_capacity(REQUIRED_DESCRIPTOR_COUNT);

    for (index, raw) in raw_handles.into_iter().enumerate() {
        let slot = u8::try_from(index).unwrap_or(u8::MAX);
        let kind = calls
            .file_type(raw)
            .map_err(|code| DescriptorError::at(DescriptorReason::SlotNotPipe, slot, code))?;
        if kind != PIPE_FILE_TYPE {
            // Code 0: ours, not the operating system's. The call succeeded; the
            // handle simply is not a pipe.
            return Err(DescriptorError::at(DescriptorReason::SlotNotPipe, slot, 0));
        }
        slots.push(OwnedDescriptor::new(raw, slot, calls));
    }

    Ok(Descriptors { slots })
}
