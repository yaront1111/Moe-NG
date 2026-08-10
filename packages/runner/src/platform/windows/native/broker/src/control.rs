//! The CLOSED inbound control vocabulary on fd0, and the minimal accept state
//! that makes sequence violations visible.
//!
//! EXACTLY TWO COMMANDS EXIST: one launch request shape and CANCEL. There is no
//! catch-all variant and no open string command space — a command is an opcode
//! byte that maps to [`Inbound`] or it maps to nothing at all.
//!
//! # Why a state at all, when this task creates no process
//!
//! REORDERED AND DUPLICATE ARE SEQUENCE PROPERTIES. A stateless decoder cannot
//! see either: both frames are individually perfect. [`AcceptState`] holds which
//! frame is legal NEXT and nothing else — NO Job, NO handle, NO process, NO
//! descriptor, NO timing. It is not sibling 3c's session and must not grow into
//! one; if a field here ever needs to be closed or waited on, it belongs there.
//!
//! # Why [`LaunchRequest`] may carry what [`ProtocolError`] may not
//!
//! These are not in tension, they are the whole design. The launch REQUEST is
//! the one payload whose purpose is to carry an executable, argv, a cwd and an
//! environment. The REFUSAL is forbidden from echoing any of them. Keeping them
//! in separate types is what makes the no-echo rail enforceable BY
//! CONSTRUCTION: there is no field on the refusal to put them in, so a leak is
//! a compile error rather than a review finding.

use crate::frames::RawFrame;
use crate::payload::Cursor;
use crate::protocol::{ProtocolError, ProtocolReason};

/// The complete inbound vocabulary. Closed, with no catch-all variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Inbound {
    /// Launch the described process. Legal exactly once.
    Launch,
    /// Stop what was launched. Terminal.
    Cancel,
}

impl Inbound {
    /// Every variant, in declaration order. The length is part of the type, so
    /// a new command cannot be added without listing it — and
    /// `the_inbound_vocabulary_is_exactly_launch_and_cancel` round-trips every
    /// entry through [`Self::opcode`] and [`Self::from_opcode`], so a command
    /// that is unreachable from the wire fails the suite.
    pub const ALL: [Inbound; 2] = [Inbound::Launch, Inbound::Cancel];

    /// The frozen wire byte for this command.
    pub const fn opcode(self) -> u8 {
        match self {
            Self::Launch => 1,
            Self::Cancel => 2,
        }
    }

    /// The command a wire byte names, if any.
    ///
    /// The `_` arm is over the 256 possible BYTES, not over the vocabulary: it
    /// is what makes the command space closed rather than open, since every
    /// byte outside the vocabulary maps to nothing.
    pub const fn from_opcode(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Launch),
            2 => Some(Self::Cancel),
            _ => None,
        }
    }
}

/// A decoded launch request.
///
/// THE ONE TYPE IN THE PROTOCOL THAT LEGITIMATELY CARRIES AN EXECUTABLE, ARGV, A
/// CWD AND AN ENVIRONMENT. Nothing else may, and nothing on the refusal path
/// can, because no refusal type has a field that could hold one.
#[derive(Clone, PartialEq, Eq)]
pub struct LaunchRequest {
    executable: String,
    argv: Vec<String>,
    cwd: String,
    environment: Vec<(String, String)>,
}

impl LaunchRequest {
    pub fn executable(&self) -> &str {
        &self.executable
    }

    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn environment(&self) -> &[(String, String)] {
        &self.environment
    }
}

impl core::fmt::Debug for LaunchRequest {
    /// Hand-written, and it prints NO CONTENT — only how many of each field
    /// there were. A derived `Debug` here would put an executable path and a
    /// whole environment into any log line, panic message or assertion failure
    /// that formatted an [`Accepted`], which is precisely the echo the rail
    /// forbids. Deriving it must stay impossible-by-hand-written-impl.
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            formatter,
            "LaunchRequest {{ argv: {}, environment: {} }}",
            self.argv.len(),
            self.environment.len()
        )
    }
}

/// A frame the control layer ACCEPTED.
///
/// THE AUTHORITY GATE. A [`LaunchRequest`] is the only value in this crate that
/// could ever reach a process launch, and [`AcceptState::accept`] is its only
/// constructor. So "no hostile frame reaches authority" is provable by the
/// ABSENCE OF THIS VALUE rather than by a call log: a refusal cannot have
/// produced one, because there is no other way to make one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Accepted {
    Launch(LaunchRequest),
    Cancel,
}

/// Which frame is legal next. Closed; holds no resource of any kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    ExpectingLaunch,
    Launched,
    Terminated,
}

/// The minimal sequence state: expecting-launch, launched, or terminated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AcceptState {
    phase: Phase,
}

impl Default for AcceptState {
    fn default() -> Self {
        Self::new()
    }
}

impl AcceptState {
    pub const fn new() -> Self {
        Self { phase: Phase::ExpectingLaunch }
    }

    /// Interprets one bounded frame, or refuses.
    ///
    /// A REFUSAL NEVER ADVANCES THE PHASE. A duplicate launch must not reset the
    /// channel to expecting-launch, or a peer could re-arm the state machine by
    /// sending exactly the frame that was rejected.
    ///
    /// Sequence is judged BEFORE the payload is decoded, so a frame that is not
    /// legal next is refused without its attacker-chosen bytes being parsed at
    /// all.
    pub fn accept(&mut self, frame: &RawFrame) -> Result<Accepted, ProtocolError> {
        let Some(command) = Inbound::from_opcode(frame.opcode()) else {
            return Err(ProtocolError::refused(ProtocolReason::UnknownOpcode));
        };

        match (self.phase, command) {
            // Spelled out rather than `_`, so adding a command forces a decision
            // here instead of silently inheriting this arm.
            (Phase::Terminated, Inbound::Launch | Inbound::Cancel) => {
                Err(ProtocolError::refused(ProtocolReason::FrameAfterTerminal))
            }
            (Phase::ExpectingLaunch, Inbound::Cancel) => {
                Err(ProtocolError::refused(ProtocolReason::FrameOutOfOrder))
            }
            (Phase::Launched, Inbound::Launch) => {
                Err(ProtocolError::refused(ProtocolReason::DuplicateLaunch))
            }
            (Phase::ExpectingLaunch, Inbound::Launch) => {
                let request = decode_launch(frame.payload())?;
                self.phase = Phase::Launched;
                Ok(Accepted::Launch(request))
            }
            (Phase::Launched, Inbound::Cancel) => {
                // CANCEL carries nothing. A payload on it is extra data inside a
                // well-formed frame, which is `TrailingBytes` by definition.
                Cursor::new(frame.payload()).finish()?;
                self.phase = Phase::Terminated;
                Ok(Accepted::Cancel)
            }
        }
    }
}

/// executable, argv, cwd, environment — in that order, consumed exactly.
fn decode_launch(payload: &[u8]) -> Result<LaunchRequest, ProtocolError> {
    let mut cursor = Cursor::new(payload);
    let executable = cursor.text()?;
    let argv = cursor.list()?;
    let cwd = cursor.text()?;
    let environment = cursor.pairs()?;
    cursor.finish()?;
    Ok(LaunchRequest { executable, argv, cwd, environment })
}
