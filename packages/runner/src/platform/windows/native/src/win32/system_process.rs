//! The real construction boundary, over windows-sys.
//!
//! Same shape as `system_job.rs`: every `unsafe` block sits behind a SAFETY
//! comment, and every arm reports its own [`NativeOp`] with the numeric Win32
//! error and nothing else.
//!
//! The three helpers below are re-declared rather than imported from
//! `system_job.rs` because that file is required to stay BYTE-IDENTICAL to the
//! block child 1 committed — widening its private helpers to `pub(super)` would
//! break the diff that proves the move was verbatim. They follow child 1's
//! pattern exactly rather than introducing a second error-handling style.

use core::ffi::c_void;
use core::ptr;

use windows_sys::Win32::Foundation::{GetLastError, FILETIME, HANDLE};
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, IsProcessInJob};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetProcessId, GetProcessTimes, ResumeThread, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};

use super::system_process_attrs::{self, OwnedAttributeList};
use super::{NativeError, NativeOp, ProcessCalls, RawHandle, SystemWin32};
use crate::process::{CreatedProcess, ProcessSpec};

pub(super) fn as_handle(handle: RawHandle) -> HANDLE {
    handle.value() as HANDLE
}

/// Reads `GetLastError` immediately after a failed call. Must not be called
/// after anything else runs, or it reports an unrelated error.
pub(super) fn last_error(op: NativeOp) -> NativeError {
    // SAFETY: GetLastError reads this thread's last-error value and has no
    // preconditions.
    NativeError::new(op, unsafe { GetLastError() })
}

pub(super) fn check(op: NativeOp, ok: windows_sys::core::BOOL) -> Result<(), NativeError> {
    if ok == 0 {
        return Err(last_error(op));
    }
    Ok(())
}

impl ProcessCalls for SystemWin32 {
    type AttributeList = OwnedAttributeList;

    fn init_attribute_list(&self, attributes: u32) -> Result<OwnedAttributeList, NativeError> {
        system_process_attrs::initialize(attributes)
    }

    fn set_job_list_attribute(
        &self,
        list: &mut OwnedAttributeList,
        job: RawHandle,
    ) -> Result<(), NativeError> {
        system_process_attrs::set_job_list(list, job)
    }

    fn set_handle_list_attribute(
        &self,
        list: &mut OwnedAttributeList,
        handles: [RawHandle; super::INHERITED_HANDLE_COUNT],
    ) -> Result<(), NativeError> {
        system_process_attrs::set_handle_list(list, handles)
    }

    fn create_process_suspended(
        &self,
        spec: &ProcessSpec<'_>,
        list: &OwnedAttributeList,
    ) -> Result<CreatedProcess, NativeError> {
        let mut startup = startup_info(spec, list);
        // CreateProcessW may WRITE THROUGH lpCommandLine, so it is handed a
        // mutable copy rather than the caller's buffer.
        let mut command_line = spec.command_line.to_vec();
        let mut info = PROCESS_INFORMATION::default();

        // SAFETY: every pointer refers to a live, correctly typed value that
        // outlives the call. bInheritHandles is TRUE (1): with FALSE the
        // HANDLE_LIST allowlist would silently inherit nothing and the child
        // would come up with no standard streams.
        let ok = unsafe {
            CreateProcessW(
                spec.application.as_ptr(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                spec.environment.as_ptr().cast::<c_void>(),
                spec.current_directory.as_ptr(),
                ptr::addr_of_mut!(startup).cast::<STARTUPINFOW>(),
                &mut info,
            )
        };
        check(NativeOp::CreateProcess, ok)?;

        Ok(CreatedProcess {
            process: RawHandle::new(info.hProcess as isize),
            thread: RawHandle::new(info.hThread as isize),
        })
    }

    fn assign_process_to_job(
        &self,
        process: RawHandle,
        job: RawHandle,
    ) -> Result<(), NativeError> {
        // SAFETY: both handles were produced by this boundary and are open.
        let ok = unsafe { AssignProcessToJobObject(as_handle(job), as_handle(process)) };
        check(NativeOp::AssignProcessToJob, ok)
    }

    fn is_process_in_job(&self, process: RawHandle, job: RawHandle) -> Result<bool, NativeError> {
        let mut member: windows_sys::core::BOOL = 0;
        // SAFETY: `member` is a live, correctly typed out-parameter.
        //
        // TWO RESULTS READ SEPARATELY. The returned BOOL says whether the CALL
        // succeeded; the answer is written through the out-pointer. Collapsing
        // them would report "not a member" as a Win32 failure, or worse read an
        // uninitialized answer from a failed call.
        let ok = unsafe { IsProcessInJob(as_handle(process), as_handle(job), &mut member) };
        check(NativeOp::IsProcessInJob, ok)?;
        Ok(member != 0)
    }

    fn process_id(&self, process: RawHandle) -> Result<u32, NativeError> {
        // SAFETY: `process` is an open process handle from this boundary.
        let id = unsafe { GetProcessId(as_handle(process)) };
        if id == 0 {
            return Err(last_error(NativeOp::QueryProcessId));
        }
        Ok(id)
    }

    fn creation_time(&self, process: RawHandle) -> Result<u64, NativeError> {
        let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        // SAFETY: all four out-parameters are live FILETIMEs. None is optional.
        let ok = unsafe {
            GetProcessTimes(
                as_handle(process),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        };
        check(NativeOp::QueryCreationTime, ok)?;
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }

    fn resume_thread(&self, thread: RawHandle) -> Result<u32, NativeError> {
        // SAFETY: `thread` is the open initial-thread handle from this boundary.
        //
        // NOT A BOOL CHECK. ResumeThread returns the PRIOR suspend count, and
        // u32::MAX (-1 as DWORD) is its failure signal. Reading it as a BOOL
        // would treat the ordinary count 1 as success and 0 as failure, which
        // is both wrong and silently wrong.
        let prior = unsafe { ResumeThread(as_handle(thread)) };
        if prior == u32::MAX {
            return Err(last_error(NativeOp::ResumeThread));
        }
        Ok(prior)
    }

    fn delete_attribute_list(&self, list: OwnedAttributeList) {
        system_process_attrs::delete(list);
    }
}

/// Builds the extended startup info: the attribute list plus the three standard
/// handles, which must be named here as well as allowlisted for the child to
/// actually receive them.
fn startup_info(spec: &ProcessSpec<'_>, list: &OwnedAttributeList) -> STARTUPINFOEXW {
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = as_handle(spec.inherited[0]);
    startup.StartupInfo.hStdOutput = as_handle(spec.inherited[1]);
    startup.StartupInfo.hStdError = as_handle(spec.inherited[2]);
    startup.lpAttributeList = list.as_ptr();
    startup
}
