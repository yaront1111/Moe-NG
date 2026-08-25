//! The REFUSED payload: which layer refused, its layer-local reason ordinal,
//! and the numeric Win32 code.
//!
//! # Why the layer has to be ON THE WIRE
//!
//! FOUR LAYERS CAN REFUSE. Descriptor acquisition (`descriptors.rs`), the
//! protocol (`protocol.rs`), the native core, and exclusive store ownership.
//! Each numbers its own reasons from zero, so
//! `DescriptorReason::BlockAbsent` and `ProtocolReason::VersionMismatch` are
//! BOTH ordinal 0. A refusal frame carrying only a number is therefore
//! ambiguous, and a reader could not tell a hostile parent's bad descriptor
//! block from a hostile parent's bad frame. The layer byte is what makes "which
//! layer refused" assertable on the wire and not merely in Rust types.
//!
//! # What this type may never hold
//!
//! No executable path, no argv, no cwd, no environment, no handle value, no
//! free-form string. Not "absent from current call sites" — UNREPRESENTABLE.
//! Three guards, each of which turns a future field addition into a BUILD
//! failure rather than a leak:
//!
//! 1. `Copy` is derived, and every forbidden payload (`String`, `PathBuf`,
//!    `Vec<_>`) is not `Copy`.
//! 2. `Debug` is derived, and the core's `RawHandle` deliberately has no
//!    `Debug`, so a handle field breaks it.
//! 3. [`REFUSED_PAYLOAD_BYTES`] and the size assertion pin the layout, so even a
//!    numeric field that slipped past the first two fails to compile.

use moe_windows_job_core::{NativeError, NativeOp};

use crate::descriptors::DescriptorError;
use crate::protocol::ProtocolError;
use crate::store_lock::StoreLockError;

/// layer, reason ordinal, numeric code.
pub const REFUSED_PAYLOAD_BYTES: usize = 1 + 2 + 4;

/// Which of the broker's four refusing layers spoke. Closed, no catch-all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RefusalLayer {
    /// Descriptor acquisition refused: the parent's `lpReserved2` block.
    Descriptor,
    /// The protocol refused: framing or control.
    Protocol,
    /// A Win32 call in the native core failed.
    Native,
    /// The curated project store could not be owned exclusively.
    StoreLock,
}

impl RefusalLayer {
    /// Every variant, in declaration order. The length is part of the type.
    pub const ALL: [RefusalLayer; 4] = [
        RefusalLayer::Descriptor,
        RefusalLayer::Protocol,
        RefusalLayer::Native,
        RefusalLayer::StoreLock,
    ];

    /// The frozen wire byte. Deliberately 1-based: a zero byte is then an
    /// unrecognised layer rather than an accidentally-valid one.
    pub const fn wire(self) -> u8 {
        match self {
            Self::Descriptor => 1,
            Self::Protocol => 2,
            Self::Native => 3,
            Self::StoreLock => 4,
        }
    }

    /// The layer a wire byte names, if any. The `_` arm is over the 256 BYTES,
    /// not over the vocabulary.
    pub const fn from_wire(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Descriptor),
            2 => Some(Self::Protocol),
            3 => Some(Self::Native),
            4 => Some(Self::StoreLock),
            _ => None,
        }
    }
}

/// A refusal, as it appears on fd1. See the module docs for what it may never
/// carry and why that is enforced by the compiler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refused {
    layer: RefusalLayer,
    reason: u16,
    code: u32,
}

/// See guard 3 in the module docs. `u32` + `u16` + a fieldless enum, padded: 8.
const _: () = assert!(size_of::<Refused>() == 8);

impl Refused {
    /// A descriptor-layer refusal.
    ///
    /// The slot index is deliberately NOT carried: it is not needed to identify
    /// the reason, and every field this type does not have is a field a future
    /// change cannot widen into something that echoes a handle.
    pub fn descriptor(error: DescriptorError) -> Self {
        Self { layer: RefusalLayer::Descriptor, reason: ordinal(error.reason().ordinal()), code: error.code() }
    }

    /// A protocol-layer refusal.
    pub fn protocol(error: ProtocolError) -> Self {
        Self { layer: RefusalLayer::Protocol, reason: ordinal(error.reason().ordinal()), code: error.code() }
    }

    /// A native-layer refusal.
    ///
    /// Carries the CORE's operation and the operating system's code, per the
    /// rail against restating its authority: the reason is the position of the
    /// operation in `NativeOp::ALL`, not a vocabulary invented here.
    pub fn native(error: NativeError) -> Self {
        let op = error.op();
        let position = NativeOp::ALL.iter().position(|candidate| *candidate == op);
        Self {
            layer: RefusalLayer::Native,
            reason: ordinal(position.unwrap_or(NativeOp::ALL.len())),
            code: error.code(),
        }
    }

    /// A project store-lock refusal, with no path-bearing field available.
    pub fn store_lock(error: StoreLockError) -> Self {
        Self {
            layer: RefusalLayer::StoreLock,
            reason: ordinal(error.reason().ordinal()),
            code: error.code(),
        }
    }

    pub const fn layer(&self) -> RefusalLayer {
        self.layer
    }

    /// The reason's position within ITS OWN layer's vocabulary. Meaningless
    /// without [`Self::layer`], which is the point.
    pub const fn reason(&self) -> u16 {
        self.reason
    }

    pub const fn code(&self) -> u32 {
        self.code
    }

    /// `layer`, then the reason, then the code — all little-endian.
    pub fn payload(&self) -> [u8; REFUSED_PAYLOAD_BYTES] {
        let reason = self.reason.to_le_bytes();
        let code = self.code.to_le_bytes();
        [self.layer.wire(), reason[0], reason[1], code[0], code[1], code[2], code[3]]
    }
}

/// Narrows a vocabulary position to the wire's width.
///
/// `u16::MAX` is unreachable by construction — every vocabulary here is well
/// under 65535 entries — and is a saturating sentinel rather than a panic
/// because a refusal path must never itself fail.
fn ordinal(position: usize) -> u16 {
    u16::try_from(position).unwrap_or(u16::MAX)
}
