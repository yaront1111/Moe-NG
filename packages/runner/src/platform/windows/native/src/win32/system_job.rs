use super::{NativeError, NativeOp, RawHandle, SystemWin32, Win32Calls};

use core::ffi::c_void;
use core::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
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
        // THE EXTENDED CLASS IS REQUIRED, NOT PREFERRED. The basic class rejects
        // `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` outright: measured on Windows 11
        // 26200 x64, SetInformationJobObject with JobObjectBasicLimitInformation
        // and exactly this flag returns FALSE with ERROR_INVALID_PARAMETER (87),
        // while the same flag through JobObjectExtendedLimitInformation returns
        // TRUE. No scripted test can see this — the double never reaches the
        // kernel — which is why tests/real_windows.rs exists.
        //
        // The extended struct's extra fields are all zero and every one of them
        // is ignored unless its own limit flag is set, so this widens nothing:
        // the configuration is still KILL_ON_JOB_CLOSE and nothing else, and the
        // query-back below still compares for exact equality.
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = flags;
        let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        // SAFETY: the pointer refers to a live, correctly typed value whose
        // size matches the class being set.
        let ok = unsafe {
            SetInformationJobObject(
                as_handle(job),
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *const c_void,
                size,
            )
        };
        check(NativeOp::SetInformation, ok)
    }

    fn query_limit_flags(&self, job: RawHandle) -> Result<u32, NativeError> {
        // Read back through the SAME class the flags were set through. Reading a
        // narrower view would answer about a subset of what was configured, and
        // the exact-equality check in `job.rs` is only meaningful when the two
        // sides describe the same thing.
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        // SAFETY: as above; the return-length pointer is optional and null.
        let ok = unsafe {
            QueryInformationJobObject(
                as_handle(job),
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut c_void,
                size,
                ptr::null_mut(),
            )
        };
        check(NativeOp::QueryInformation, ok)?;
        Ok(limits.BasicLimitInformation.LimitFlags)
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
