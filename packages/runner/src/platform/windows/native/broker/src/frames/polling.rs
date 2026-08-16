//! Incremental decoding of the layout `frames.rs` freezes, for a caller that
//! must not wait.
//!
//! SCOPE: BYTES AND FRAME BOUNDARIES ONLY, exactly as its parent. It knows no
//! opcode vocabulary and decides nothing about what a frame means.
//!
//! # WHY READINESS ALONE IS NOT ENOUGH
//!
//! "Are there bytes?" is the wrong question. A peer may leave ONE header byte on
//! the channel, or a header and half a payload, and a decoder that treats
//! any-bytes-available as permission to run the BLOCKING decoder then waits for
//! the rest — the very block the caller polled to avoid. So readiness is spent
//! incrementally: take what is there, KEEP IT, and answer Pending until a whole
//! frame has arrived, across however many turns that takes.
//!
//! Losing the kept bytes is the failure worth naming, because it is silent: the
//! decoder would read a frame's tail as if it were a header and refuse a legal
//! CANCEL as a version mismatch.
//!
//! # PENDING IS NOT AN END OF STREAM
//!
//! `Poll::Ready(0)` — and nothing else — is the channel ending, and it keeps the
//! parent's `FrameTruncated` whether it lands before a header or inside a
//! payload. A silent open channel produces no refusal at all.
//!
//! # WHAT IS KEPT IS BOUNDED
//!
//! At most one whole frame of this channel: the header plus the channel's cap.
//! The read request is that bound MINUS what is already held, so a peer cannot
//! grow this buffer by writing faster than frames are taken.

use core::task::Poll;

use super::{validate_header, ByteChannel, ChannelKind, RawFrame, FRAME_HEADER_BYTES};
use crate::protocol::{ProtocolError, ProtocolReason};

/// One channel's frame decoder, carried ACROSS poll turns.
///
/// Held by its caller for a whole run rather than rebuilt per turn: a fresh one
/// each turn would drop the partial frame, which is the defect above.
pub(crate) struct PolledFrames {
    kind: ChannelKind,
    /// Bytes taken from the channel that no frame has claimed yet.
    held: Vec<u8>,
    /// The read buffer, sized ONCE from this channel's compile-time cap and
    /// never from anything a peer declared.
    scratch: Vec<u8>,
}

impl PolledFrames {
    pub(crate) fn on(kind: ChannelKind) -> Self {
        let capacity = FRAME_HEADER_BYTES + kind.max_payload();
        Self { kind, held: Vec::with_capacity(capacity), scratch: vec![0u8; capacity] }
    }

    /// Takes at most one frame, without waiting for one.
    ///
    /// `Poll::Pending` means the channel is open and no COMPLETE frame has
    /// arrived — including the turn where bytes were consumed but a frame was
    /// not finished by them.
    pub(crate) fn poll_frame<C: ByteChannel>(
        &mut self,
        channel: &mut C,
    ) -> Result<Poll<RawFrame>, ProtocolError> {
        // ASKED BEFORE THE CHANNEL IS TOUCHED: one turn can deliver more than one
        // frame's bytes, and reading again first would grow the buffer past a
        // frame that is already complete.
        if let Some(frame) = self.take_frame()? {
            return Ok(Poll::Ready(frame));
        }

        let want = self.scratch.len() - self.held.len();
        let taken = match channel.poll_read(&mut self.scratch[..want]) {
            Ok(Poll::Pending) => return Ok(Poll::Pending),
            Ok(Poll::Ready(0)) => {
                return Err(ProtocolError::refused(ProtocolReason::FrameTruncated))
            }
            Ok(Poll::Ready(taken)) => taken,
            Err(code) => return Err(ProtocolError::channel(code)),
        };
        // A channel claiming it placed more than it was offered is broken, not
        // hostile input — the same judgement, and the same refusal, the blocking
        // `fill` makes. Checked rather than trusted, because the slice below
        // would otherwise panic on a length the channel invented.
        if taken > want {
            return Err(ProtocolError::channel(0));
        }
        self.held.extend_from_slice(&self.scratch[..taken]);

        Ok(match self.take_frame()? {
            Some(frame) => Poll::Ready(frame),
            None => Poll::Pending,
        })
    }

    /// Removes one complete frame from what is held, or reports that there is
    /// not one yet.
    ///
    /// The parent's order, unchanged: header, VERSION, the bound check, then and
    /// only then a payload — and the payload is sliced from bytes ALREADY IN
    /// HAND, so a declared length sizes nothing here either.
    fn take_frame(&mut self) -> Result<Option<RawFrame>, ProtocolError> {
        if self.held.len() < FRAME_HEADER_BYTES {
            return Ok(None);
        }
        let mut head = [0u8; FRAME_HEADER_BYTES];
        head.copy_from_slice(&self.held[..FRAME_HEADER_BYTES]);
        let (opcode, declared) = validate_header(&head, self.kind)?;

        let total = FRAME_HEADER_BYTES + declared;
        if self.held.len() < total {
            return Ok(None);
        }
        // A zero-length payload is a legal frame, and this produces the empty one
        // rather than reading nothing from the channel to get it.
        let payload = self.held[FRAME_HEADER_BYTES..total].to_vec();
        self.held.drain(..total);
        // Buildable here because Rust privacy reaches DESCENDANTS: this module is
        // a child of `frames`, the only module that may construct a `RawFrame`.
        Ok(Some(RawFrame { opcode, payload }))
    }
}
