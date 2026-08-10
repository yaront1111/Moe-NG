//! Parsing the CRT `lpReserved2` descriptor block, and the refusal vocabulary.
//!
//! SCOPE. Bytes in, six handle VALUES out, or a refusal. Nothing here asks the
//! kernel anything: handle verification and ownership live in `verify.rs`, and
//! every Win32 call lives in `boundary.rs`. That split is what lets every
//! hostile block shape be reached by a unit test over bytes.
//!
//! THIS INPUT IS HOSTILE. From the broker's point of view the block is
//! attacker-shaped: a parent chooses its length, its declared count and every
//! handle value in it. So every read is bounds-checked before it happens, the
//! size arithmetic is checked rather than wrapping, and there is NO panicking
//! path — no indexing, no `unwrap`, no `expect`, and no slicing by range.
//!
//! NO `unsafe`, AND NO `read_unaligned` EITHER. The obvious implementation reads
//! the `u32` and the pointer-sized handles through raw pointers, which needs
//! `read_unaligned` because the handle array sits at offset `4 + count` and is
//! therefore misaligned whenever `count` is not a multiple of the pointer size.
//! Copying the bytes into a fixed-size array and calling `from_le_bytes` instead
//! removes the alignment question entirely and keeps this file free of `unsafe`,
//! which is a stronger guarantee than getting the unaligned read right. Windows
//! is little-endian on every target it supports, so the byte order is not a
//! portability assumption.

/// fd0..fd5. The broker requires all six; a block declaring fewer is refused
/// rather than partially accepted.
pub const REQUIRED_DESCRIPTOR_COUNT: usize = 6;

/// `INVALID_HANDLE_VALUE`, which Win32 defines as `(HANDLE)(-1)`.
///
/// Written as an integer here because this file deliberately does not depend on
/// windows-sys — a pointer constant cannot be compared in a `const` assertion
/// anyway. `the_invalid_handle_sentinel_matches_windows_sys` in
/// tests/descriptor_block.rs pins it against the real declaration at runtime.
pub const INVALID_HANDLE: isize = -1;

/// The `u32` count that opens the block.
const COUNT_FIELD_BYTES: usize = 4;

/// One flag byte and one pointer-sized handle per descriptor.
///
/// `size_of::<usize>()`, never a hardcoded 8: the handle array is
/// POINTER-sized, so the stride is 4 on a 32-bit target. Measured on this host
/// with a real Node v24 parent, `count = 6` gave `cbReserved2 = 58`, which is
/// exactly `4 + 6 * (1 + 8)`.
const PER_SLOT_BYTES: usize = 1 + size_of::<usize>();

/// Why descriptor acquisition refused. Closed, with no catch-all and no
/// `#[non_exhaustive]`.
///
/// Adding a variant must be a compile error at [`DescriptorReason::ALL`], whose
/// length is part of its type, and therefore at the coverage test that compares
/// against it — the same forcing function `NativeOp` uses in the core crate.
///
/// NO VARIANT CARRIES A HANDLE, A PATH, AN ARGUMENT OR AN ENVIRONMENT VALUE, and
/// none ever may: the slot INDEX is what identifies a bad descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DescriptorReason {
    /// `lpReserved2` was null, or `cbReserved2` was zero.
    BlockAbsent,
    /// Fewer than four bytes, so even the count is unreadable.
    BlockTooShortForCount,
    /// The size the count implies is larger than the block that was supplied.
    CountExceedsBlock,
    /// Internally consistent, but with fewer than six descriptors in it.
    CountBelowRequired,
    /// A slot carried zero or `INVALID_HANDLE_VALUE`.
    SlotHandleAbsent,
    /// A slot carried a real handle that is not a pipe.
    SlotNotPipe,
    /// A handle's close did not succeed, so its outcome is unknown.
    CloseFailed,
}

impl DescriptorReason {
    /// Every variant, in declaration order.
    pub const ALL: [DescriptorReason; 7] = [
        DescriptorReason::BlockAbsent,
        DescriptorReason::BlockTooShortForCount,
        DescriptorReason::CountExceedsBlock,
        DescriptorReason::CountBelowRequired,
        DescriptorReason::SlotHandleAbsent,
        DescriptorReason::SlotNotPipe,
        DescriptorReason::CloseFailed,
    ];

    /// Position in [`Self::ALL`], used to derive a stable process exit code.
    pub fn ordinal(self) -> usize {
        Self::ALL.iter().position(|reason| *reason == self).unwrap_or(Self::ALL.len())
    }
}

/// A refusal: why, which descriptor if the answer is one descriptor, and the
/// operating system's numeric code when one exists.
///
/// `code` is 0 when the refusal is OURS rather than Windows' — a block whose
/// declared count does not fit is not a Win32 failure, nothing was called.
/// That is the same convention the core crate uses for `NativeError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DescriptorError {
    reason: DescriptorReason,
    slot: Option<u8>,
    code: u32,
}

impl DescriptorError {
    /// A refusal about the block as a whole.
    pub(crate) const fn block(reason: DescriptorReason) -> Self {
        Self { reason, slot: None, code: 0 }
    }

    /// A refusal about one descriptor.
    pub(crate) const fn at(reason: DescriptorReason, slot: u8, code: u32) -> Self {
        Self { reason, slot: Some(slot), code }
    }

    pub const fn reason(&self) -> DescriptorReason {
        self.reason
    }

    pub const fn slot(&self) -> Option<u8> {
        self.slot
    }

    pub const fn code(&self) -> u32 {
        self.code
    }
}

impl core::fmt::Display for DescriptorError {
    /// Hand-written, never derived from anything that could grow a handle field.
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self.slot {
            Some(slot) => {
                write!(formatter, "{:?} at descriptor {} with code {}", self.reason, slot, self.code)
            }
            None => write!(formatter, "{:?} with code {}", self.reason, self.code),
        }
    }
}

impl std::error::Error for DescriptorError {}

/// Reads fd0..fd5 out of a CRT `lpReserved2` block.
///
/// `declared` is `cbReserved2`. It and `block.len()` are both bounds, and the
/// SMALLER ONE WINS: in this process they are equal by construction, but a
/// declaration larger than the bytes actually supplied would otherwise be a read
/// past the end of the parent's allocation. Trusting the declaration is exactly
/// the bug this signature exists to make untestable-by-omission.
pub fn parse_descriptor_block(
    block: &[u8],
    declared: u16,
) -> Result<[isize; REQUIRED_DESCRIPTOR_COUNT], DescriptorError> {
    let effective = core::cmp::min(usize::from(declared), block.len());
    if effective == 0 {
        return Err(DescriptorError::block(DescriptorReason::BlockAbsent));
    }

    let Some(count) = read_count(block, effective) else {
        return Err(DescriptorError::block(DescriptorReason::BlockTooShortForCount));
    };

    // CHECKED, not wrapping. A count of u32::MAX must refuse rather than
    // overflow into a small number that would then appear to fit.
    let fits = count
        .checked_mul(PER_SLOT_BYTES)
        .and_then(|size| size.checked_add(COUNT_FIELD_BYTES))
        .is_some_and(|required| required <= effective);
    if !fits {
        return Err(DescriptorError::block(DescriptorReason::CountExceedsBlock));
    }
    if count < REQUIRED_DESCRIPTOR_COUNT {
        return Err(DescriptorError::block(DescriptorReason::CountBelowRequired));
    }

    read_handles(block, count)
}

/// The leading `u32`, or `None` when there is not enough block to hold one.
fn read_count(block: &[u8], effective: usize) -> Option<usize> {
    let bytes = block.get(..COUNT_FIELD_BYTES)?;
    if effective < COUNT_FIELD_BYTES {
        return None;
    }
    Some(u32::from_le_bytes(<[u8; COUNT_FIELD_BYTES]>::try_from(bytes).ok()?) as usize)
}

/// The first six handles, which sit after the count and after `count` flag
/// bytes — one per descriptor the block declares, not one per descriptor we
/// want.
///
/// The caller has already proved the whole array fits, so every `get` below
/// succeeds; each is still written as a checked read because a bounds proof one
/// function away is not a bounds check.
fn read_handles(
    block: &[u8],
    count: usize,
) -> Result<[isize; REQUIRED_DESCRIPTOR_COUNT], DescriptorError> {
    let mut handles = [0isize; REQUIRED_DESCRIPTOR_COUNT];
    for (index, handle) in handles.iter_mut().enumerate() {
        let at = COUNT_FIELD_BYTES
            .checked_add(count)
            .and_then(|start| start.checked_add(index.checked_mul(size_of::<usize>())?));
        let raw = at
            .and_then(|start| start.checked_add(size_of::<usize>()).map(|end| (start, end)))
            .and_then(|(start, end)| block.get(start..end))
            .and_then(|bytes| <[u8; size_of::<usize>()]>::try_from(bytes).ok())
            .map(|bytes| usize::from_le_bytes(bytes) as isize);
        let Some(raw) = raw else {
            return Err(DescriptorError::block(DescriptorReason::CountExceedsBlock));
        };
        // Checked for EVERY slot before any handle is handed to the kernel. An
        // incomplete block is refused as a block, so a later type check can
        // never pre-empt the slot that is actually missing.
        if raw == 0 || raw == INVALID_HANDLE {
            let slot = u8::try_from(index).unwrap_or(u8::MAX);
            return Err(DescriptorError::at(DescriptorReason::SlotHandleAbsent, slot, 0));
        }
        *handle = raw;
    }
    Ok(handles)
}
