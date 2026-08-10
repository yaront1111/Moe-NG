//! The frozen wire contract: the protocol version, the closed refusal
//! vocabulary, and the refusal type every protocol layer returns.
//!
//! SCOPE. Three things and nothing else. No framing (that is `frames.rs`), no
//! control vocabulary (`control.rs`), no status vocabulary (`status.rs`).
//!
//! WHY THIS IS NOT AN EXTENSION OF `DescriptorReason`. Descriptor refusals and
//! protocol refusals are DIFFERENT LAYERS. One merged enum would make "which
//! layer refused" unassertable: a refusal migrating from the descriptor layer to
//! this one would keep both suites green, because both would be asserting
//! against the same vocabulary. Two closed enums make the migration a compile
//! error at the boundary instead.
//!
//! AND WHY THERE IS A SECOND, FINER SPLIT INSIDE THIS ONE. Two layers can refuse
//! WITHIN the protocol as well — the framing layer reading a header off the
//! wire, and the control layer interpreting a payload it has already been handed.
//! [`ProtocolReason::stage`] names which, so a test can pin the stage rather than
//! settle for "the protocol refused". Without it, moving the trailing-byte check
//! from control into framing would keep every reason-code assertion green.
//!
//! NO FREE-FORM TEXT LIVES HERE OR MAY EVER. See [`ProtocolError`].

/// The frozen protocol version, carried in the first byte of every frame on
/// every channel.
///
/// FROZEN MEANS FROZEN: a peer that speaks anything else is refused with
/// [`ProtocolReason::VersionMismatch`] before its opcode, its declared length or
/// its payload is looked at, so a future re-layout can never be mistaken for a
/// malformed frame of this version. `the_protocol_version_is_frozen_at_one` in
/// tests/frame_sweep.rs pins the value by exact equality; changing it is a
/// deliberate act with a failing test attached, not a drift.
pub const PROTOCOL_VERSION: u8 = 1;

/// Which layer inside the protocol refused.
///
/// Closed, with no catch-all: a third stage must be added here and at every
/// match site rather than silently joining one of these two.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProtocolStage {
    /// Reading a frame off the wire: version, declared length, and getting the
    /// declared bytes. Deals only in BYTES — it knows no opcode vocabulary and
    /// no frame meaning, which is what lets one codec serve all three channels.
    Framing,
    /// Interpreting a frame the framing layer already bounded: what its opcode
    /// means, what its payload decodes to, and whether it is legal NEXT. Never
    /// reads the channel.
    Control,
}

impl ProtocolStage {
    /// Every variant, in declaration order. The length is part of the type.
    pub const ALL: [ProtocolStage; 2] = [ProtocolStage::Framing, ProtocolStage::Control];
}

/// Why the protocol refused a frame. Closed, with no catch-all and no
/// `#[non_exhaustive]`.
///
/// Adding a variant must be a compile error at [`ProtocolReason::ALL`], whose
/// length is part of its type, and at [`ProtocolReason::stage`], whose match is
/// exhaustive — the same forcing function `DescriptorReason` and `NativeOp` use.
///
/// NO VARIANT CARRIES A HANDLE, A PATH, AN ARGUMENT, AN ENVIRONMENT VALUE OR A
/// MESSAGE, and none ever may. A refusal names a category; it does not describe
/// the input that caused it, because describing it is how the input gets echoed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProtocolReason {
    /// The frame's version byte is not [`PROTOCOL_VERSION`].
    VersionMismatch,
    /// The DECLARED payload length exceeds the channel's cap. Refused before
    /// anything is allocated: a declared length is attacker-chosen and is never
    /// an allocation hint.
    LengthOverLimit,
    /// The channel ended before the header, or before the declared payload was
    /// complete.
    FrameTruncated,
    /// The channel itself failed. The only reason whose `code` is a real
    /// operating-system error rather than 0.
    ChannelFailed,
    /// The opcode byte is not one this channel's closed vocabulary defines.
    /// A CONTROL-stage reason, not a framing one: the framing layer carries the
    /// byte without interpreting it, which is what lets one bounded codec serve
    /// fd0, fd1 and fd2 without knowing any of their vocabularies.
    UnknownOpcode,
    /// The payload does not decode as the shape its opcode names — a declared
    /// field length running past the payload, or a byte sequence that is not
    /// valid UTF-8.
    PayloadMalformed,
    /// The payload decoded, but bytes were left over inside it. Extra data
    /// inside a well-formed frame, not extra data after one.
    TrailingBytes,
    /// A second launch request on a channel that already accepted one.
    DuplicateLaunch,
    /// A frame that is legal in the protocol but not legal NEXT — a CANCEL
    /// before any launch has been accepted.
    FrameOutOfOrder,
    /// Any frame at all after the terminal one. Extra data AFTER a frame, as
    /// distinct from [`Self::TrailingBytes`] inside one.
    FrameAfterTerminal,
}

impl ProtocolReason {
    /// Every variant, in declaration order. The sweep compares the reasons it
    /// actually produced against this, so an unreached arm is a test failure.
    /// The array LENGTH is part of the type, so adding a variant without listing
    /// it here does not compile.
    pub const ALL: [ProtocolReason; 10] = [
        ProtocolReason::VersionMismatch,
        ProtocolReason::LengthOverLimit,
        ProtocolReason::FrameTruncated,
        ProtocolReason::ChannelFailed,
        ProtocolReason::UnknownOpcode,
        ProtocolReason::PayloadMalformed,
        ProtocolReason::TrailingBytes,
        ProtocolReason::DuplicateLaunch,
        ProtocolReason::FrameOutOfOrder,
        ProtocolReason::FrameAfterTerminal,
    ];

    /// Position in [`Self::ALL`], used as the stable numeric reason on the wire.
    pub fn ordinal(self) -> usize {
        Self::ALL.iter().position(|reason| *reason == self).unwrap_or(Self::ALL.len())
    }

    /// Which layer inside the protocol produces this reason.
    ///
    /// Exhaustive on purpose — no `_` arm — so a new reason cannot be added
    /// without deciding, in code, where it belongs.
    pub const fn stage(self) -> ProtocolStage {
        match self {
            Self::VersionMismatch
            | Self::LengthOverLimit
            | Self::FrameTruncated
            | Self::ChannelFailed => ProtocolStage::Framing,
            Self::UnknownOpcode
            | Self::PayloadMalformed
            | Self::TrailingBytes
            | Self::DuplicateLaunch
            | Self::FrameOutOfOrder
            | Self::FrameAfterTerminal => ProtocolStage::Control,
        }
    }
}

/// A protocol refusal: why, and the operating system's numeric code when one
/// exists.
///
/// THESE TWO FIELDS ARE THE WHOLE TYPE, BY RAIL, and a future field addition
/// must FAIL TO COMPILE rather than quietly leak. Three guards make that so,
/// and they are load-bearing rather than decorative:
///
/// 1. `Copy` is derived. Every forbidden payload — an executable path
///    (`String`/`PathBuf`), argv or environment (`Vec`), a free-form message
///    (`String`) — is NOT `Copy`, so adding one breaks the derive.
/// 2. `Debug` is derived, and the core's `RawHandle` deliberately has no `Debug`
///    impl, so adding a handle field breaks it too.
/// 3. The size assertion below pins the layout, so even a numeric field that
///    slipped past 1 and 2 fails the BUILD.
///
/// `code` is 0 when the refusal is OURS rather than Windows' — a frame that
/// declares a length over the cap is not a Win32 failure; nothing was called.
/// That is the same convention `DescriptorError` and `NativeError` use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    reason: ProtocolReason,
    code: u32,
}

/// See guard 3 on [`ProtocolError`]. `u32` plus a fieldless enum, padded: 8.
const _: () = assert!(size_of::<ProtocolError>() == 8);

impl ProtocolError {
    /// A refusal that is ours. `code` is 0 because no call was made.
    pub const fn refused(reason: ProtocolReason) -> Self {
        Self { reason, code: 0 }
    }

    /// A refusal caused by the channel failing, carrying its numeric code.
    pub const fn channel(code: u32) -> Self {
        Self { reason: ProtocolReason::ChannelFailed, code }
    }

    pub const fn reason(&self) -> ProtocolReason {
        self.reason
    }

    pub const fn code(&self) -> u32 {
        self.code
    }

    /// Which layer refused. Delegates rather than storing a second copy: a
    /// stored stage could disagree with its reason.
    pub const fn stage(&self) -> ProtocolStage {
        self.reason.stage()
    }
}

impl core::fmt::Display for ProtocolError {
    /// Hand-written, never derived from anything that could grow a path or a
    /// message field.
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "{:?} at {:?} with code {}", self.reason, self.stage(), self.code)
    }
}

impl std::error::Error for ProtocolError {}
