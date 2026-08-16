//! Bounded binary framing for fd0 (inbound control), fd1 (outbound status) and
//! fd2 (outbound, non-authoritative diagnostics).
//!
//! SCOPE: BYTES ONLY. This layer knows the version, the declared length and the
//! channel's cap. It does NOT know what an opcode means, and that is deliberate
//! — it is what lets one codec serve all three channels without embedding three
//! vocabularies, and it puts every vocabulary decision at the CONTROL stage
//! where a test can pin it separately (see `protocol::ProtocolStage`).
//!
//! # The wire layout, frozen
//!
//! ```text
//! offset 0   1 byte   version, must equal PROTOCOL_VERSION
//! offset 1   1 byte   opcode, carried uninterpreted
//! offset 2   4 bytes  declared payload length, little-endian u32
//! offset 6   N bytes  payload, exactly the declared length
//! ```
//!
//! Little-endian because Windows is little-endian on every target it supports,
//! which is the same reasoning `descriptors.rs` records for the CRT block.
//!
//! # THE DECLARED LENGTH IS ATTACKER INPUT
//!
//! A peer chooses it, so it is compared against the channel's cap BEFORE any
//! buffer is sized from it and before one payload byte is requested. The bug
//! this file exists to make impossible is `Vec::with_capacity(declared)` ahead
//! of that comparison: a four-byte header would commit four gigabytes. Neither
//! decoder allocates before [`validate_header`] answers, and
//! `a_declared_length_near_u32_max_is_refused_before_the_payload_is_read` pins it.
//!
//! # WHY A NEW SEAM RATHER THAN `HandleCalls`
//!
//! `HandleCalls` has exactly two methods, `file_type` and `close_handle`. It has
//! no read and no write, so framing cannot go through it; contorting bytes
//! through a handle-verification call table would be a worse duplication than a
//! second, narrow trait. [`ByteChannel`] is that trait and nothing more.
//!
//! # WHY THERE ARE TWO DECODERS
//!
//! [`read_frame`] BLOCKS until its bytes arrive: right for a phase something
//! else already bounds — the launch handshake — wrong for a loop that must also
//! keep watching a child. `polling` serves that caller incrementally, through
//! the same [`validate_header`], so neither can drift on what a header means.

use crate::protocol::{ProtocolError, ProtocolReason, PROTOCOL_VERSION};

pub(crate) mod polling;

/// Version, opcode, and the little-endian `u32` length.
pub const FRAME_HEADER_BYTES: usize = 6;

/// fd0. The launch request carries an executable, argv, a cwd and an
/// environment, so it needs the largest budget of the three.
pub const MAX_CONTROL_PAYLOAD: usize = 64 * 1024;

/// fd1. Status payloads are a handful of fixed-width numbers; the headroom is
/// for growth, not for content.
pub const MAX_STATUS_PAYLOAD: usize = 4 * 1024;

/// fd2. Diagnostics are non-authoritative and carry no content that could grow,
/// so this is the tightest cap of the three.
pub const MAX_DIAGNOSTIC_PAYLOAD: usize = 512;

/// Which of the broker's three protocol channels a frame belongs to.
///
/// Closed, with no catch-all. The cap is a property of the CHANNEL rather than
/// one global number, so an oversized diagnostics frame is refused at 513 bytes
/// even though the same bytes would be legal control.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ChannelKind {
    /// fd0, inbound. The only channel that can ever produce an accepted
    /// command.
    Control,
    /// fd1, outbound. Authoritative status.
    Status,
    /// fd2, outbound. NON-AUTHORITATIVE. Bounded like the others, and never
    /// parsed as control: nothing in this crate feeds a diagnostics frame to the
    /// control decoder, and a diagnostics payload cannot decode to an accepted
    /// command because the accept path takes a control frame by construction.
    Diagnostic,
}

impl ChannelKind {
    /// Every variant, in declaration order. The length is part of the type.
    pub const ALL: [ChannelKind; 3] =
        [ChannelKind::Control, ChannelKind::Status, ChannelKind::Diagnostic];

    /// The largest payload this channel will read or write.
    pub const fn max_payload(self) -> usize {
        match self {
            Self::Control => MAX_CONTROL_PAYLOAD,
            Self::Status => MAX_STATUS_PAYLOAD,
            Self::Diagnostic => MAX_DIAGNOSTIC_PAYLOAD,
        }
    }
}

/// The byte seam: two ways to read, one to write, each on a CALLER-OWNED buffer
/// so nothing here can be handed an allocation sized by a peer.
///
/// All three may do less than asked — short reads and partial writes are what a
/// real pipe does, not errors — and all three report the operating system's
/// numeric code and nothing else on failure.
pub trait ByteChannel {
    /// Reads into `buffer`, returning how many bytes were placed. `Ok(0)` is the
    /// channel ending. MAY BLOCK until bytes or an end arrive.
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, u32>;

    /// Reads what is ALREADY THERE, without waiting. `Pending` is nothing
    /// readable on a channel that is STILL OPEN — not an end of stream and not a
    /// refusal; `Ready(0)` is the channel really ending; `Ready(n)` is exactly
    /// `n` bytes consumed, never more than `buffer.len()`. REQUIRED WITH NO
    /// DEFAULT: `Ready` would let a future channel silently block a caller that
    /// promised not to wait, `Pending` would silently disable every instruction.
    fn poll_read(&mut self, buffer: &mut [u8]) -> Result<core::task::Poll<usize>, u32>;

    /// Writes from `bytes`, returning how many were accepted.
    fn write(&mut self, bytes: &[u8]) -> Result<usize, u32>;
}

/// One frame, bounded, with its opcode still uninterpreted.
///
/// A `RawFrame` is not a command and cannot become one by itself: only the
/// control decoder can turn one into an accepted request, and only from fd0.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawFrame {
    opcode: u8,
    payload: Vec<u8>,
}

impl RawFrame {
    pub const fn opcode(&self) -> u8 {
        self.opcode
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }
}

/// Judges six header bytes: version FIRST, then the declared length against the
/// channel's cap. The length comes back a `usize` only because this function has
/// PROVED it inside a compile-time cap.
///
/// THE ONE PLACE EITHER DECODER MAY DECIDE WHAT A HEADER MEANS. A second copy of
/// that order would let them drift, with both suites green.
pub(crate) fn validate_header(
    head: &[u8; FRAME_HEADER_BYTES],
    kind: ChannelKind,
) -> Result<(u8, usize), ProtocolError> {
    if head[0] != PROTOCOL_VERSION {
        return Err(ProtocolError::refused(ProtocolReason::VersionMismatch));
    }

    let declared = u32::from_le_bytes([head[2], head[3], head[4], head[5]]);
    // Widened to u64 so the comparison is identical on a 32-bit target, where
    // `declared as usize` could otherwise be the very truncation being guarded.
    if u64::from(declared) > kind.max_payload() as u64 {
        return Err(ProtocolError::refused(ProtocolReason::LengthOverLimit));
    }
    Ok((head[1], declared as usize))
}

/// Reads exactly one frame, or refuses. BLOCKS until the bytes arrive; the
/// header is judged by [`validate_header`] before a payload byte is requested.
pub fn read_frame<C: ByteChannel>(
    channel: &mut C,
    kind: ChannelKind,
) -> Result<RawFrame, ProtocolError> {
    let mut head = [0u8; FRAME_HEADER_BYTES];
    fill(channel, &mut head)?;
    let (opcode, declared) = validate_header(&head, kind)?;

    // FIRST ALLOCATION IN THIS FUNCTION, and it is reached only once `declared`
    // has been proved no larger than a compile-time constant.
    let mut payload = vec![0u8; declared];
    fill(channel, &mut payload)?;

    Ok(RawFrame { opcode, payload })
}

/// Writes one frame, or refuses without emitting a byte.
///
/// The cap is enforced on this side too. An over-cap payload is OUR bug rather
/// than a peer's, and refusing it here means a peer never has to defend against
/// a frame we should not have sent.
pub fn write_frame<C: ByteChannel>(
    channel: &mut C,
    kind: ChannelKind,
    opcode: u8,
    payload: &[u8],
) -> Result<(), ProtocolError> {
    let Ok(declared) = u32::try_from(payload.len()) else {
        return Err(ProtocolError::refused(ProtocolReason::LengthOverLimit));
    };
    if payload.len() > kind.max_payload() {
        return Err(ProtocolError::refused(ProtocolReason::LengthOverLimit));
    }

    // Sized from OUR OWN slice, already bounded above — never from a declaration
    // someone else chose.
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.push(PROTOCOL_VERSION);
    frame.push(opcode);
    frame.extend_from_slice(&declared.to_le_bytes());
    frame.extend_from_slice(payload);
    push(channel, &frame)
}

/// Fills `buffer` completely, tolerating short reads.
///
/// An empty buffer completes without touching the channel, so a zero-length
/// payload is a legal frame rather than a read of nothing.
fn fill<C: ByteChannel>(channel: &mut C, buffer: &mut [u8]) -> Result<(), ProtocolError> {
    let mut filled = 0;
    while filled < buffer.len() {
        let remaining = buffer.len() - filled;
        let got = channel.read(&mut buffer[filled..]).map_err(ProtocolError::channel)?;
        if got == 0 {
            return Err(ProtocolError::refused(ProtocolReason::FrameTruncated));
        }
        // A channel claiming it wrote more than it was given is broken, not
        // hostile input. Refused rather than clamped, because clamping would
        // silently drop bytes, and checked rather than trusted, because
        // `filled + got` would otherwise index past the buffer and panic.
        // `polling` judges the same claim the same way.
        if got > remaining {
            return Err(ProtocolError::channel(0));
        }
        filled += got;
    }
    Ok(())
}

/// Writes every byte of `bytes`, tolerating partial writes.
fn push<C: ByteChannel>(channel: &mut C, bytes: &[u8]) -> Result<(), ProtocolError> {
    let mut sent = 0;
    while sent < bytes.len() {
        let remaining = bytes.len() - sent;
        let took = channel.write(&bytes[sent..]).map_err(ProtocolError::channel)?;
        // Zero accepted forever is an infinite loop, and more accepted than
        // offered is a broken channel. Both are refusals, not retries.
        if took == 0 || took > remaining {
            return Err(ProtocolError::channel(0));
        }
        sent += took;
    }
    Ok(())
}
