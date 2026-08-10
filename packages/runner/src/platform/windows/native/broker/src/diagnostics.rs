//! The bounded, NON-AUTHORITATIVE fd2 form.
//!
//! # Non-authoritative means what it says
//!
//! Nothing a reader learns here may change what it believes. Authority lives on
//! fd1 (`status.rs`); fd2 exists so an operator can see that something happened
//! without that observation becoming evidence. Two properties make that
//! structural rather than a promise:
//!
//! * A diagnostic can never become a command. The only value in this crate that
//!   can reach a process launch is a `LaunchRequest`, and its sole constructor
//!   takes a control frame — there is no path from here to one.
//! * A diagnostic carries NO TEXT. A closed note vocabulary and one numeric
//!   detail, so the fd2 channel cannot become the free-form error string the
//!   refusal rail forbids, which is exactly what a "just for humans" channel
//!   would otherwise drift into.
//!
//! fd2 has the TIGHTEST cap of the three channels, because a channel nobody may
//! rely on has no reason to carry volume.

use crate::frames::{write_frame, ByteChannel, ChannelKind};
use crate::protocol::ProtocolError;

/// A note byte and a `u32` detail.
const DIAGNOSTIC_PAYLOAD_BYTES: usize = 1 + 4;

/// The single diagnostics opcode. There is one frame shape on fd2 and there is
/// no reason for a second: a channel with no authority needs no vocabulary to
/// discriminate.
const DIAGNOSTIC_OPCODE: u8 = 1;

/// What happened. Closed, with no catch-all and no free-form alternative.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DiagnosticNote {
    /// A frame was refused. The detail is the refusing reason's ordinal.
    FrameRefused,
    /// A frame was accepted. The detail is its opcode.
    FrameAccepted,
    /// A channel ended. The detail is the operating system's numeric code, or 0
    /// for an ordinary end.
    ChannelEnded,
}

impl DiagnosticNote {
    /// Every variant, in declaration order. The length is part of the type.
    pub const ALL: [DiagnosticNote; 3] = [
        DiagnosticNote::FrameRefused,
        DiagnosticNote::FrameAccepted,
        DiagnosticNote::ChannelEnded,
    ];

    /// The frozen wire byte.
    pub const fn wire(self) -> u8 {
        match self {
            Self::FrameRefused => 1,
            Self::FrameAccepted => 2,
            Self::ChannelEnded => 3,
        }
    }
}

/// One diagnostics record: a note and one number whose meaning the note fixes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    note: DiagnosticNote,
    detail: u32,
}

/// A field addition of a path, an argv or a message would break `Copy` and this
/// assertion both — the same guard the refusal type carries.
const _: () = assert!(size_of::<Diagnostic>() == 8);

impl Diagnostic {
    pub const fn new(note: DiagnosticNote, detail: u32) -> Self {
        Self { note, detail }
    }

    pub const fn note(&self) -> DiagnosticNote {
        self.note
    }

    pub const fn detail(&self) -> u32 {
        self.detail
    }

    /// Writes this note to fd2 as one bounded frame.
    pub fn emit<C: ByteChannel>(&self, channel: &mut C) -> Result<(), ProtocolError> {
        let detail = self.detail.to_le_bytes();
        let payload: [u8; DIAGNOSTIC_PAYLOAD_BYTES] =
            [self.note.wire(), detail[0], detail[1], detail[2], detail[3]];
        write_frame(channel, ChannelKind::Diagnostic, DIAGNOSTIC_OPCODE, &payload)
    }
}

const _: () = assert!(DIAGNOSTIC_PAYLOAD_BYTES < ChannelKind::Diagnostic.max_payload());
