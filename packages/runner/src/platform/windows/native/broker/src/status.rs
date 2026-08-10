//! The CLOSED outbound status vocabulary on fd1: STARTED, terminal COMPLETED,
//! and REFUSED.
//!
//! SCOPE. This task DEFINES and ENCODES these. WHEN a STARTED is emitted, what
//! makes a COMPLETED true, and who decides a process ended are the session
//! sibling's, and nothing here reads a Job, a handle or a process.
//!
//! # STARTED carries an identity pair, and deliberately not the image
//!
//! The core's `Identity` is `{ pid, creation_time, image }`, where `image` is a
//! full executable path. A PID alone is reused, so the pair is what actually
//! identifies one process — and the image adds nothing to identity while adding
//! an executable path to the wire. [`Started`] takes the pair and drops the
//! image on purpose.
//!
//! # COMPLETED can say "not knowable", because the core can
//!
//! `GetExitCodeProcess` answers `STILL_ACTIVE` for a live process AND for one
//! that genuinely exited with 259, which is why the core models an exit as
//! `Exited` or `Unknown(UnknownExit)` rather than a `u32`. If this frame could
//! only carry a number, its emitter would be forced to INVENT one for an
//! unknowable exit — evidence gaining authority it does not have. So the
//! unknown case is representable here, and `UnknownExit` is imported from the
//! core rather than restated.

use moe_windows_job_core::UnknownExit;

use crate::frames::{write_frame, ByteChannel, ChannelKind};
use crate::protocol::ProtocolError;
use crate::refusal::{Refused, REFUSED_PAYLOAD_BYTES};

/// pid, then creation time.
const STARTED_PAYLOAD_BYTES: usize = 4 + 8;

/// A discriminant byte, then a `u32` whose meaning that byte fixes.
const COMPLETED_PAYLOAD_BYTES: usize = 1 + 4;

/// The complete outbound vocabulary. Closed, with no catch-all variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Outbound {
    Started,
    Completed,
    Refused,
}

impl Outbound {
    /// Every variant, in declaration order. The length is part of the type.
    pub const ALL: [Outbound; 3] = [Outbound::Started, Outbound::Completed, Outbound::Refused];

    /// The frozen wire byte.
    pub const fn opcode(self) -> u8 {
        match self {
            Self::Started => 1,
            Self::Completed => 2,
            Self::Refused => 3,
        }
    }

    /// The status a wire byte names, if any. The `_` arm is over the 256 BYTES,
    /// not over the vocabulary.
    pub const fn from_opcode(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Started),
            2 => Some(Self::Completed),
            3 => Some(Self::Refused),
            _ => None,
        }
    }
}

/// The identity of the process that started: PID paired with creation time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Started {
    pid: u32,
    creation_time: u64,
}

const _: () = assert!(size_of::<Started>() == 16);

impl Started {
    pub const fn new(pid: u32, creation_time: u64) -> Self {
        Self { pid, creation_time }
    }

    pub const fn pid(&self) -> u32 {
        self.pid
    }

    pub const fn creation_time(&self) -> u64 {
        self.creation_time
    }

    fn payload(&self) -> [u8; STARTED_PAYLOAD_BYTES] {
        let pid = self.pid.to_le_bytes();
        let time = self.creation_time.to_le_bytes();
        [
            pid[0], pid[1], pid[2], pid[3], time[0], time[1], time[2], time[3], time[4], time[5],
            time[6], time[7],
        ]
    }
}

/// How the process ended, or why that is not knowable. Closed, no catch-all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completed {
    Exited(u32),
    Unknown(UnknownExit),
}

const _: () = assert!(size_of::<Completed>() == 8);

impl Completed {
    fn payload(&self) -> [u8; COMPLETED_PAYLOAD_BYTES] {
        let (kind, value) = match self {
            Self::Exited(code) => (1u8, *code),
            Self::Unknown(reason) => (2u8, u32::from(unknown_wire(*reason))),
        };
        let value = value.to_le_bytes();
        [kind, value[0], value[1], value[2], value[3]]
    }
}

/// The frozen wire byte for each way an exit can be unknowable.
///
/// EXHAUSTIVE ON PURPOSE, with no `_` arm. `UnknownExit` belongs to the core; if
/// it grows a variant, this must FAIL TO COMPILE so the new reason gets a wire
/// code, rather than silently collapsing into an existing one and telling a
/// reader something false.
const fn unknown_wire(reason: UnknownExit) -> u8 {
    match reason {
        UnknownExit::NotWaited => 1,
        UnknownExit::StillRunning => 2,
        UnknownExit::WaitAbandoned => 3,
        UnknownExit::ProofFromAnotherProcess => 4,
    }
}

/// One outbound status. Closed, with no catch-all variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Started(Started),
    Completed(Completed),
    Refused(Refused),
}

impl Status {
    /// Which member of the vocabulary this is.
    pub const fn kind(&self) -> Outbound {
        match self {
            Self::Started(_) => Outbound::Started,
            Self::Completed(_) => Outbound::Completed,
            Self::Refused(_) => Outbound::Refused,
        }
    }

    /// Writes this status to fd1 as one bounded frame.
    ///
    /// Every payload here is a FIXED-WIDTH array, so no status can ever exceed
    /// the channel cap; `write_frame` still checks, because a bound that is only
    /// true by inspection is not a bound.
    pub fn emit<C: ByteChannel>(&self, channel: &mut C) -> Result<(), ProtocolError> {
        let opcode = self.kind().opcode();
        match self {
            Self::Started(started) => {
                write_frame(channel, ChannelKind::Status, opcode, &started.payload())
            }
            Self::Completed(completed) => {
                write_frame(channel, ChannelKind::Status, opcode, &completed.payload())
            }
            Self::Refused(refused) => {
                write_frame(channel, ChannelKind::Status, opcode, &refused.payload())
            }
        }
    }
}

/// The widest status payload, kept well inside fd1's cap.
const _: () = assert!(
    STARTED_PAYLOAD_BYTES < ChannelKind::Status.max_payload()
        && COMPLETED_PAYLOAD_BYTES < ChannelKind::Status.max_payload()
        && REFUSED_PAYLOAD_BYTES < ChannelKind::Status.max_payload()
);
