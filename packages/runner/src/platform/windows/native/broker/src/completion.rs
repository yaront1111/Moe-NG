//! What a session settled on, and which completion precondition stopped it.
//!
//! # COMPLETED and UNKNOWN are ALTERNATIVES, not degrees of the same answer
//!
//! Three things must ALL hold before a terminal COMPLETED may be emitted: the
//! retained root handle was waited, the exit was queried exactly, and the Job
//! reported zero live processes. When any one of them could not be observed the
//! result stays [`Unknown`], and nothing may upgrade it later — an unobserved
//! leg is not a pessimistic reading of a known outcome, it is the absence of
//! one.
//!
//! [`Unknown`]: Completion::Unknown
//!
//! # There was a fourth, and it was DELETED rather than weakened
//!
//! A provider-channel end-of-stream leg used to sit between the exit query and
//! the Job. It is gone because the session cannot make that observation at all:
//! fd4 and fd5 are DUPLEX handles and are the SAME handles the child receives as
//! its stdout and stderr, so a read on the session's side faces the direction
//! only the parent ever writes. An observation nothing can make is not an
//! advisory check, it is a decorative one, and it withheld COMPLETED until the
//! PARENT tore its end down.
//!
//! Termination is now carried EXPLICITLY by the Job-empty leg, which is the
//! stronger statement anyway: a process still holding a write end has not left
//! the Job. `settle.rs` carries the measurement. Do not restore the fourth.
//!
//! # Why this vocabulary is new rather than borrowed
//!
//! The core's `UnknownExit` already says why an EXIT is not knowable, and it is
//! reused verbatim below rather than paraphrased. But it has nothing to say
//! about a Job that still holds processes, because that is not a reason an exit
//! is unknowable — it is a different observation failing. Naming it with an
//! `UnknownExit` variant would be a lie the type system would not catch, so the
//! vocabulary for the session's own preconditions belongs here.

use moe_windows_job_core::UnknownExit;

use crate::refusal::Refused;
use crate::status::Completed;

/// The three things a terminal COMPLETED requires. Closed, with no catch-all.
///
/// Adding a fourth must be a compile error at [`Self::ALL`], whose length is
/// part of its type, and at [`Unobserved::precondition`], whose match is
/// exhaustive. That is the same forcing function `NativeOp`, `ProtocolReason`
/// and `DescriptorReason` use, and it is what stops a new precondition from
/// being added without a test that can fail it. It is also what forced this
/// enum's consumers to be updated when the provider-EOF leg was deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Precondition {
    /// The retained root handle was waited and the wait observed the process.
    RootWait,
    /// The exit was queried exactly, through the core's proof.
    ExitQuery,
    /// The Job reported `ActiveProcesses == 0`.
    JobEmpty,
}

impl Precondition {
    /// Every variant, in declaration order. The length is part of the type.
    pub const ALL: [Precondition; 3] =
        [Precondition::RootWait, Precondition::ExitQuery, Precondition::JobEmpty];
}

/// Which precondition was not observed, and the core's reason where it has one.
///
/// NO VARIANT CARRIES A HANDLE, A PATH, AN ARGUMENT OR AN ENVIRONMENT VALUE, and
/// none ever may — the same rail `Refused` and `ProtocolError` are held to.
/// `Copy` is derived and every forbidden payload is not `Copy`, so adding one
/// breaks the derive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unobserved {
    /// No wait observed the process signalled, so there is no exit to read.
    ///
    /// CARRIES THE CORE'S REASON, NEVER ONE INVENTED HERE. Whether the wait was
    /// never made, expired with the process alive, or came back abandoned is
    /// decided by `query_exit_status` from the observation it was handed.
    RootWait(UnknownExit),
    /// A wait DID observe the process, but reading the code failed at the Win32
    /// boundary. Distinct from [`Self::RootWait`]: there the answer is unknowable,
    /// here the question could not be asked.
    ExitQuery,
    /// The Job did not report zero live processes.
    ///
    /// THIS IS ALSO WHERE A PROVIDER THAT NEVER ENDS LANDS. A process still
    /// holding a write end has not left the Job, so the emptiness proof refuses
    /// for it — by name, and without claiming an observation of the channel
    /// itself that the session could not make.
    JobActive,
}

impl Unobserved {
    /// Which precondition this names.
    ///
    /// Exhaustive on purpose — no `_` arm — so a new reason cannot be added
    /// without deciding, in code, which precondition it belongs to.
    pub const fn precondition(&self) -> Precondition {
        match self {
            Self::RootWait(_) => Precondition::RootWait,
            Self::ExitQuery => Precondition::ExitQuery,
            Self::JobActive => Precondition::JobEmpty,
        }
    }
}

/// How a launched child's end was settled. Closed, with no catch-all.
///
/// There is deliberately no third variant meaning "probably finished". A result
/// is either fully observed or it is not, and the second case must carry which
/// observation was missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
    /// All three preconditions held. The exit is the core's, proved by a
    /// signalled wait it made itself.
    Completed(Completed),
    /// A precondition was not observed. Never upgraded.
    Unknown(Unobserved),
}

/// Why the run loop ended. Closed, with no catch-all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Stopped {
    /// The child exited on its own and a wait observed it.
    Natural,
    /// CANCEL arrived on fd0.
    Cancelled,
    /// The instructed timeout expired.
    TimedOut,
    /// fd0 ended before another complete frame arrived.
    ControlEnded,
    /// A frame arrived on fd0 that was not legal next.
    ControlRefused,
    /// The helper was asked to stop.
    Shutdown,
    /// The wait failed or came back abandoned, so the child's state is
    /// unobservable. Kept apart from [`Self::Natural`] deliberately: folding it
    /// there would report an end that nothing saw.
    WaitFailed,
}

impl Stopped {
    /// Every variant, in declaration order. The length is part of the type.
    pub const ALL: [Stopped; 7] = [
        Stopped::Natural,
        Stopped::Cancelled,
        Stopped::TimedOut,
        Stopped::ControlEnded,
        Stopped::ControlRefused,
        Stopped::Shutdown,
        Stopped::WaitFailed,
    ];

    /// Whether the session is ending the child rather than observing it end.
    pub(crate) const fn is_termination(self) -> bool {
        !matches!(self, Self::Natural)
    }
}

/// What one run produced. Closed, with no catch-all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// fd0 ended before any launch arrived.
    ///
    /// NOTHING WAS LAUNCHED AND NOTHING WAS REFUSED, and those are genuinely
    /// different. A parent that says nothing has violated no rule, so there is
    /// no refusal to make — and, decisively, nobody left to tell: writing a
    /// REFUSED frame to fd1 because fd0 closed means answering a peer that has
    /// already gone. Keeping this apart from [`Self::NotLaunched`] is what lets
    /// the binary stay silent on fd1 when it was never asked to do anything.
    NoInstruction,
    /// A launch was refused, so no process was ever created and there is no Job
    /// to reap.
    NotLaunched(Refused),
    /// A child ran: why the loop ended, and what was observed about its end.
    Ran(Stopped, Completion),
}
