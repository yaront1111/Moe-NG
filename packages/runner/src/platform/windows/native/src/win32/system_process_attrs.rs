//! The real `PROC_THREAD_ATTRIBUTE_LIST`, and the storage its pointers require.
//!
//! Split out of `system_process.rs` by responsibility rather than by
//! reformatting, under the size bar this crate holds every source to.
//!
//! WHY THIS TYPE OWNS MORE THAN A BUFFER. `UpdateProcThreadAttribute` stores a
//! POINTER to each attribute's value; it does not copy the value. So every
//! value handed to it must outlive the list and must not move before
//! `CreateProcessW` returns. Passing `&job_handle` from a local, or a `Vec` that
//! is later moved, compiles and passes every scripted test — the double never
//! dereferences anything — and is a use-after-free on real Windows. The job
//! handle and the handle array therefore live in `Box`es owned by this value,
//! so their addresses are fixed on the heap even if the list itself is moved.

use core::ffi::c_void;
use core::ptr;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
    LPPROC_THREAD_ATTRIBUTE_LIST,
};

use super::system_process::{as_handle, check, last_error};
use super::{
    NativeError, NativeOp, RawHandle, ATTRIBUTE_HANDLE_LIST, ATTRIBUTE_JOB_LIST,
    INHERITED_HANDLE_COUNT,
};

/// An initialized attribute list plus the storage its attributes point into.
pub struct OwnedAttributeList {
    /// `Vec<usize>` rather than `Vec<u8>`: the list requires pointer alignment
    /// and a byte vector only guarantees alignment 1. Allocated once at the
    /// probed size and never grown, so the heap block never moves.
    buffer: Vec<usize>,
    job: Box<HANDLE>,
    handles: Box<[HANDLE; INHERITED_HANDLE_COUNT]>,
}

impl OwnedAttributeList {
    /// The list itself. Casts away const because `CreateProcessW` and
    /// `UpdateProcThreadAttribute` both type this parameter as mutable, though
    /// the creation path only reads it.
    pub(super) fn as_ptr(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

/// Allocates and initializes a list sized for `attributes` attributes.
pub(super) fn initialize(attributes: u32) -> Result<OwnedAttributeList, NativeError> {
    let mut size: usize = 0;
    // SAFETY: the documented two-call size probe. A null list with a zero size
    // asks for the required byte count and is EXPECTED to fail with
    // ERROR_INSUFFICIENT_BUFFER, so its BOOL is deliberately not checked --
    // treating that documented failure as an error would refuse every
    // construction. What is checked is that it produced a size.
    let probed =
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), attributes, 0, &mut size) };
    if probed != 0 || size == 0 {
        return Err(last_error(NativeOp::InitAttributeList));
    }

    let words = size.div_ceil(size_of::<usize>());
    let mut buffer: Vec<usize> = vec![0; words];
    // SAFETY: `buffer` holds at least `size` bytes at pointer alignment, and
    // `size` still carries the probed value the second call requires.
    let ok = unsafe {
        InitializeProcThreadAttributeList(buffer.as_mut_ptr().cast(), attributes, 0, &mut size)
    };
    check(NativeOp::InitAttributeList, ok)?;

    Ok(OwnedAttributeList {
        buffer,
        job: Box::new(ptr::null_mut()),
        handles: Box::new([ptr::null_mut(); INHERITED_HANDLE_COUNT]),
    })
}

/// Puts the Job on the list, which is what makes membership atomic with
/// creation.
pub(super) fn set_job_list(
    list: &mut OwnedAttributeList,
    job: RawHandle,
) -> Result<(), NativeError> {
    *list.job = as_handle(job);
    let value: *const c_void = ptr::addr_of!(*list.job).cast();
    let target = list.as_ptr();
    // SAFETY: `target` is an initialized list; `value` points into a Box this
    // list owns, so the pointee stays valid and un-moved until the list is
    // deleted -- which is exactly what UpdateProcThreadAttribute requires,
    // because it stores the pointer rather than copying the handle.
    let ok = unsafe {
        UpdateProcThreadAttribute(
            target,
            0,
            ATTRIBUTE_JOB_LIST as usize,
            value,
            size_of::<HANDLE>(),
            ptr::null_mut(),
            ptr::null(),
        )
    };
    check(NativeOp::SetJobListAttribute, ok)
}

/// Restricts inheritance to exactly the caller's three handles.
///
/// Meaningless unless `CreateProcessW` is also passed `bInheritHandles = TRUE`;
/// with FALSE the allowlist is honoured by inheriting nothing at all, and the
/// child silently gets no standard streams.
pub(super) fn set_handle_list(
    list: &mut OwnedAttributeList,
    handles: [RawHandle; INHERITED_HANDLE_COUNT],
) -> Result<(), NativeError> {
    for (slot, handle) in list.handles.iter_mut().zip(handles) {
        *slot = as_handle(handle);
    }
    let value: *const c_void = list.handles.as_ptr().cast();
    let target = list.as_ptr();
    // SAFETY: as in set_job_list -- the array lives in a Box this list owns, so
    // the stored pointer stays valid until the list is deleted.
    let ok = unsafe {
        UpdateProcThreadAttribute(
            target,
            0,
            ATTRIBUTE_HANDLE_LIST as usize,
            value,
            size_of::<HANDLE>() * INHERITED_HANDLE_COUNT,
            ptr::null_mut(),
            ptr::null(),
        )
    };
    check(NativeOp::SetHandleListAttribute, ok)
}

/// Releases the list. Infallible: windows-sys declares
/// `DeleteProcThreadAttributeList` with no return value, so there is no outcome
/// to report and nothing a cleanup step could launder an earlier error into.
pub(super) fn delete(mut list: OwnedAttributeList) {
    let target = list.buffer.as_mut_ptr().cast();
    // SAFETY: `list` was produced by `initialize` and is CONSUMED here, so this
    // runs at most once for it. The buffer outlives the call.
    unsafe { DeleteProcThreadAttributeList(target) };
}
