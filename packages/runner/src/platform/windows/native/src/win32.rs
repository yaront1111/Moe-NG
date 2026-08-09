//! The Win32 seam and the error vocabulary.
//!
//! Every Win32 call this crate makes goes through [`Win32Calls`]. That is what
//! lets the sweep fail each arm independently without a real Job, while the
//! code under test stays the code that ships — a `#[cfg(test)]` shim would test
//! something the release build never runs.
//!
//! `unsafe` is confined to this file. No other module in the crate contains it.

use core::fmt;

/// The closed set of native operations that can fail.
///
/// There is deliberately NO catch-all or `Other(u32)` variant and the enum is
/// not `#[non_exhaustive]`. Adding an operation must be a compile error at
/// every match site rather than a silent fallthrough; child 2 adds variants
/// here, and that is exactly when the compiler should force a review of every
/// site that classifies an outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NativeOp {
    CreateJobObject,
    SetInformation,
    QueryInformation,
    TerminateJob,
    QueryAccounting,
    CloseHandle,
}

impl NativeOp {
    /// Every variant, in declaration order. The sweep compares the operations it
    /// actually produced against this, so an unreached arm is a test failure.
    pub const ALL: [NativeOp; 6] = [
        NativeOp::CreateJobObject,
        NativeOp::SetInformation,
        NativeOp::QueryInformation,
        NativeOp::TerminateJob,
        NativeOp::QueryAccounting,
        NativeOp::CloseHandle,
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
mod system {
    use super::{NativeError, NativeOp, RawHandle, SystemWin32, Win32Calls};

    use core::ffi::c_void;
    use core::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectBasicLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    };

    /// Exit code handed to `TerminateJobObject`. Arbitrary and never surfaced;
    /// authority over run outcomes lives above this crate.
    const TERMINATE_EXIT_CODE: u32 = 1;

    fn as_handle(handle: RawHandle) -> HANDLE {
        handle.value() as HANDLE
    }

    /// Reads `GetLastError` immediately after a failed call. Must not be called
    /// after anything else runs, or it reports an unrelated error.
    fn last_error(op: NativeOp) -> NativeError {
        // SAFETY: GetLastError reads this thread's last-error value and has no
        // preconditions.
        NativeError::new(op, unsafe { GetLastError() })
    }

    fn check(op: NativeOp, ok: windows_sys::core::BOOL) -> Result<(), NativeError> {
        if ok == 0 {
            return Err(last_error(op));
        }
        Ok(())
    }

    impl Win32Calls for SystemWin32 {
        fn create_job_object(&self) -> Result<RawHandle, NativeError> {
            // A NULL name is required: a NAMED Job could be opened by an
            // unrelated process via OpenJobObject, which would put a foreign
            // process in a position to alter or terminate our containment.
            // SAFETY: both arguments are null, which the API documents as
            // "default security attributes" and "unnamed".
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(last_error(NativeOp::CreateJobObject));
            }
            Ok(RawHandle::new(handle as isize))
        }

        fn set_limit_flags(&self, job: RawHandle, flags: u32) -> Result<(), NativeError> {
            let mut limits = JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: flags,
                ..JOBOBJECT_BASIC_LIMIT_INFORMATION::default()
            };
            let size = size_of::<JOBOBJECT_BASIC_LIMIT_INFORMATION>() as u32;
            // SAFETY: the pointer refers to a live, correctly typed value whose
            // size matches the class being set.
            let ok = unsafe {
                SetInformationJobObject(
                    as_handle(job),
                    JobObjectBasicLimitInformation,
                    &mut limits as *mut _ as *const c_void,
                    size,
                )
            };
            check(NativeOp::SetInformation, ok)
        }

        fn query_limit_flags(&self, job: RawHandle) -> Result<u32, NativeError> {
            let mut limits = JOBOBJECT_BASIC_LIMIT_INFORMATION::default();
            let size = size_of::<JOBOBJECT_BASIC_LIMIT_INFORMATION>() as u32;
            // SAFETY: as above; the return-length pointer is optional and null.
            let ok = unsafe {
                QueryInformationJobObject(
                    as_handle(job),
                    JobObjectBasicLimitInformation,
                    &mut limits as *mut _ as *mut c_void,
                    size,
                    ptr::null_mut(),
                )
            };
            check(NativeOp::QueryInformation, ok)?;
            Ok(limits.LimitFlags)
        }

        fn terminate_job(&self, job: RawHandle) -> Result<(), NativeError> {
            // SAFETY: `job` is a Job handle this crate created and has not closed.
            let ok = unsafe { TerminateJobObject(as_handle(job), TERMINATE_EXIT_CODE) };
            check(NativeOp::TerminateJob, ok)
        }

        fn query_active_processes(&self, job: RawHandle) -> Result<u32, NativeError> {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let size = size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32;
            // SAFETY: as in query_limit_flags, with the accounting class and its
            // matching struct.
            let ok = unsafe {
                QueryInformationJobObject(
                    as_handle(job),
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut c_void,
                    size,
                    ptr::null_mut(),
                )
            };
            check(NativeOp::QueryAccounting, ok)?;
            Ok(accounting.ActiveProcesses)
        }

        fn close_handle(&self, handle: RawHandle) -> Result<(), NativeError> {
            // SAFETY: `handle` was produced by this boundary and the owning type
            // guarantees this runs at most once for it.
            let ok = unsafe { CloseHandle(as_handle(handle)) };
            check(NativeOp::CloseHandle, ok)
        }
    }
}
