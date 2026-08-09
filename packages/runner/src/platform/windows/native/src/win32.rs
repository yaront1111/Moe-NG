//! The Win32 seam and the error vocabulary.
//!
//! Every Win32 call this crate makes goes through [`Win32Calls`]. That is what
//! lets the sweep fail each arm independently without a real Job, while the
//! code under test stays the code that ships — a `#[cfg(test)]` shim would test
//! something the release build never runs.
//!
//! `unsafe` is confined to this file. No other module in the crate contains it.

use core::fmt;

// The construction seam lives in its own file by responsibility, but keeps its
// public path here: `win32::ProcessCalls`, exactly like `win32::Win32Calls`.
mod process_calls;

pub use process_calls::{
    ProcessCalls, ATTRIBUTE_HANDLE_LIST, ATTRIBUTE_JOB_LIST, EXPECTED_PRIOR_SUSPEND_COUNT,
    INHERITED_HANDLE_COUNT,
};

/// The closed set of native operations that can fail.
///
/// There is deliberately NO catch-all or `Other(u32)` variant and the enum is
/// not `#[non_exhaustive]`. Adding an operation must be a compile error at
/// every match site rather than a silent fallthrough; the process-side variants
/// below arrived that way, and that is exactly when the compiler should force a
/// review of every site that classifies an outcome.
///
/// There is deliberately NO variant for `DeleteProcThreadAttributeList`:
/// windows-sys declares it with no return type at all, so it cannot fail and a
/// variant for it could never be produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NativeOp {
    CreateJobObject,
    SetInformation,
    QueryInformation,
    TerminateJob,
    QueryAccounting,
    CloseHandle,
    InitAttributeList,
    SetJobListAttribute,
    SetHandleListAttribute,
    CreateProcess,
    AssignProcessToJob,
    IsProcessInJob,
    QueryProcessId,
    QueryCreationTime,
    ResumeThread,
}

impl NativeOp {
    /// Every variant, in declaration order. The sweeps compare the operations
    /// they actually produced against this, so an unreached arm is a test
    /// failure. The array LENGTH is part of the type, so adding a variant
    /// without listing it here does not compile.
    pub const ALL: [NativeOp; 15] = [
        NativeOp::CreateJobObject,
        NativeOp::SetInformation,
        NativeOp::QueryInformation,
        NativeOp::TerminateJob,
        NativeOp::QueryAccounting,
        NativeOp::CloseHandle,
        NativeOp::InitAttributeList,
        NativeOp::SetJobListAttribute,
        NativeOp::SetHandleListAttribute,
        NativeOp::CreateProcess,
        NativeOp::AssignProcessToJob,
        NativeOp::IsProcessInJob,
        NativeOp::QueryProcessId,
        NativeOp::QueryCreationTime,
        NativeOp::ResumeThread,
    ];
}

/// A native failure: which operation, and the numeric Win32 error.
///
/// These two fields are the WHOLE type, by rail. The way "never echo executable,
/// argv, cwd, environment or raw handle values" gets broken in Rust is not a log
/// statement — it is a derived `Debug` on a struct that happens to hold a handle
/// or a path. So no such field may exist here at all, and `Display` below is
/// written by hand rather than derived from anything that could carry one.
///
/// `code` is 0 when the refusal is ours rather than the operating system's — a
/// queried-back configuration that does not match what we set is a refusal, not
/// a Win32 failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeError {
    op: NativeOp,
    code: u32,
}

impl NativeError {
    pub const fn new(op: NativeOp, code: u32) -> Self {
        Self { op, code }
    }

    pub const fn op(&self) -> NativeOp {
        self.op
    }

    pub const fn code(&self) -> u32 {
        self.code
    }
}

impl fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?} failed with Win32 error {}", self.op, self.code)
    }
}

impl std::error::Error for NativeError {}

/// An opaque Win32 handle.
///
/// A newtype rather than a bare `isize` so a handle cannot be passed where an
/// exit code, flag word or PID is expected. It is never carried inside
/// [`NativeError`].
///
/// DELIBERATELY NOT `Debug`. The rail against echoing raw handle values is not
/// broken by a log statement — it is broken by someone adding
/// `#[derive(Debug)]` to a future struct that happens to hold one. Without a
/// `Debug` impl here, that derive fails to COMPILE instead of quietly printing
/// a handle. Same forcing function as the closed [`NativeOp`].
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RawHandle(isize);

impl RawHandle {
    pub const fn new(value: isize) -> Self {
        Self(value)
    }

    pub const fn value(&self) -> isize {
        self.0
    }
}

/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and nothing else.
///
/// Neither `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (0x0800) nor
/// `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` (0x1000) may ever be set: either one
/// lets a child leave the Job, which defeats the entire primitive.
pub const REQUIRED_LIMIT_FLAGS: u32 = 0x0000_2000;

/// Compile-time proof that the literal above is the real Win32 constant. If
/// windows-sys ever disagrees, this fails the build instead of shipping a Job
/// configured with the wrong bit.
#[cfg(windows)]
const _: () = assert!(
    REQUIRED_LIMIT_FLAGS
        == windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
);

/// The injectable Win32 boundary. One method per failable operation.
pub trait Win32Calls {
    fn create_job_object(&self) -> Result<RawHandle, NativeError>;
    fn set_limit_flags(&self, job: RawHandle, flags: u32) -> Result<(), NativeError>;
    fn query_limit_flags(&self, job: RawHandle) -> Result<u32, NativeError>;
    fn terminate_job(&self, job: RawHandle) -> Result<(), NativeError>;
    fn query_active_processes(&self, job: RawHandle) -> Result<u32, NativeError>;
    fn close_handle(&self, handle: RawHandle) -> Result<(), NativeError>;
}

/// The real boundary, over windows-sys.
pub struct SystemWin32;

#[cfg(windows)]
mod system_job;

#[cfg(windows)]
mod system_process;

#[cfg(windows)]
mod system_process_attrs;
