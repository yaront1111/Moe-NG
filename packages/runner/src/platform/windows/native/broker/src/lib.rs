//! The Windows job broker: the six stdio descriptors a Node parent handed this
//! process, and the frozen wire protocol spoken over them.
//!
//! # What is here
//!
//! DESCRIPTORS. Find the six descriptors in the CRT `lpReserved2` block, prove
//! every one is a real pipe, own each so it closes exactly once —
//! `descriptors.rs`, `verify.rs`, `boundary.rs`.
//!
//! THE PROTOCOL. A frozen version, closed vocabularies, and bounded binary
//! framing on all three channels: fd0 inbound control, fd1 outbound status, fd2
//! outbound non-authoritative diagnostics.
//!
//! ```text
//! protocol.rs     PROTOCOL_VERSION, the closed refusal vocabulary, ProtocolError
//! frames.rs       ByteChannel, the three channel caps, the bounded codec
//! payload.rs      the checked cursor over one frame's payload (crate-internal)
//! control.rs      fd0: Launch and Cancel, and the accept state
//! status.rs       fd1: Started, Completed, Refused
//! refusal.rs      the REFUSED payload and the layer discriminant
//! diagnostics.rs  fd2: the bounded, non-authoritative note form
//! ```
//!
//! # What deliberately is NOT here
//!
//! No Job creation, no process launch, no lifecycle delegation, no STARTED
//! emission timing, no completion semantics, no idempotence and no kill proofs.
//! Those belong to the sibling tasks that build on this one — the session (3c)
//! and the hardening pass (3d) — and a placeholder for any of them here would be
//! a second implementation for their owners to collide with rather than a head
//! start. `status.rs` DEFINES and ENCODES a Started and a Completed; nothing in
//! this crate decides when either is true.
//!
//! Anything Win32-Job- or process-shaped comes from `moe-windows-job-core`. This
//! crate restates no Job or process syscall and no operation vocabulary; the
//! only Win32 it calls itself is `GetStartupInfoW`, `GetFileType` and
//! `CloseHandle`, all in `boundary.rs`.
//!
//! # Everything a peer chooses is hostile input
//!
//! That is one rule applied twice. In the descriptor block a parent chooses the
//! length, the declared count and every handle value; on the wire a peer chooses
//! the version, the opcode, the declared frame length and every field length
//! inside the payload. In both places a DECLARED LENGTH IS NEVER AN ALLOCATION
//! HINT: it is bounds-checked first, and only then used. Both refuse with stable
//! reason codes — never a panic, never an out-of-bounds read, never a silent
//! fallback to whatever happened to parse.
//!
//! The two refusal vocabularies are deliberately SEPARATE (`DescriptorReason`
//! and `ProtocolReason`) so a test can pin which layer refused; merging them
//! would let a refusal migrate between layers with both suites still green.
//!
//! # Why the block is treated as hostile
//!
//! `lpReserved2` is chosen by the parent: its length, its declared count and
//! every handle value in it. A block that is absent, truncated, internally
//! inconsistent, or carrying something that is not a pipe is REFUSED with a
//! stable reason code — never a panic, never an out-of-bounds read, and never a
//! silent fallback to however many descriptors happened to parse.
//!
//! # Layout, measured rather than assumed
//!
//! `u32` count, then one flag byte per declared descriptor, then one
//! POINTER-SIZED handle each: `4 + count * (1 + size_of::<usize>())`. Measured
//! on this host against a real Node v24.16.0 parent with six pipes, that is
//! `cbReserved2 == 58` for `count == 6`, and `GetFileType` answered 3
//! (`FILE_TYPE_PIPE`) for all six.

// Modules are private: every item has exactly one public path, re-exported
// below, which is how the core crate is arranged too.
mod completion;
mod control;
mod descriptors;
mod diagnostics;
mod frames;
mod launch;
mod payload;
mod protocol;
mod refusal;
mod session;
mod settle;
mod status;
mod store_lock;
mod verify;
mod watch;

#[cfg(windows)]
mod boundary;

pub use completion::{Completion, Outcome, Precondition, Stopped, Unobserved};
pub use control::{AcceptState, Accepted, Inbound, LaunchRequest};
pub use descriptors::{
    parse_descriptor_block, DescriptorError, DescriptorReason, INVALID_HANDLE,
    REQUIRED_DESCRIPTOR_COUNT,
};
pub use diagnostics::{Diagnostic, DiagnosticNote};
pub use frames::{
    read_frame, write_frame, ByteChannel, ChannelKind, RawFrame, FRAME_HEADER_BYTES,
    MAX_CONTROL_PAYLOAD, MAX_DIAGNOSTIC_PAYLOAD, MAX_STATUS_PAYLOAD,
};
pub use protocol::{
    ProtocolError, ProtocolReason, ProtocolStage, PROTOCOL_VERSION,
};
pub use refusal::{RefusalLayer, Refused, REFUSED_PAYLOAD_BYTES};
pub use session::{Session, ShutdownSignal, Wiring};
pub use status::{Completed, Outbound, Started, Status};
pub use store_lock::{
    validate_store_path, StoreLockAuthority, StoreLockError, StoreLockedOutcome, StoreLockReason,
};
#[cfg(windows)]
pub use store_lock::{SystemStoreLock, SystemStoreLocks};
pub use verify::{
    acquire_from_block, Descriptors, HandleCalls, OwnedDescriptor, PIPE_FILE_TYPE,
};

#[cfg(windows)]
pub use boundary::{acquire, startup_block, PipeChannel, SystemHandles};
