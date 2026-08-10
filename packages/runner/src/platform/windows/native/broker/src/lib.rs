//! Descriptor acquisition for the Windows job broker: find the six stdio
//! descriptors a Node parent handed this process, prove every one of them is a
//! real pipe, and own each so it closes exactly once.
//!
//! # Scope, and what deliberately is not here
//!
//! This crate is PLUMBING. It holds no protocol and no policy. There is no frame
//! codec, no control or status vocabulary, no CANCEL, no Job creation, no
//! process launch, no lifecycle delegation and no completion semantics — those
//! belong to the sibling tasks that build on this one, and a placeholder for any
//! of them here would be a second implementation for their owners to collide
//! with rather than a head start.
//!
//! Anything Win32-Job- or process-shaped comes from `moe-windows-job-core`. This
//! crate restates no Job or process syscall; the only Win32 it calls itself is
//! `GetStartupInfoW`, `GetFileType` and `CloseHandle`, all in `boundary.rs`.
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
mod descriptors;
mod protocol;
mod verify;

#[cfg(windows)]
mod boundary;

pub use descriptors::{
    parse_descriptor_block, DescriptorError, DescriptorReason, INVALID_HANDLE,
    REQUIRED_DESCRIPTOR_COUNT,
};
pub use protocol::{
    ProtocolError, ProtocolReason, ProtocolStage, PROTOCOL_VERSION,
};
pub use verify::{
    acquire_from_block, Descriptors, HandleCalls, OwnedDescriptor, PIPE_FILE_TYPE,
};

#[cfg(windows)]
pub use boundary::{acquire, startup_block, SystemHandles};
