//! Real-kernel acceptance. These tests spawn actual Windows processes.
//!
//! THEY RUN. No `#[ignore]`, no `cfg` gate, no stub. Every other test in this
//! crate drives the scripted call table, which proves the production logic and
//! proves that the windows-sys implementations COMPILE — never that they work.
//! This file is the only thing that closes that seam, so skipping it would
//! leave the whole primitive unverified against the thing it is written for.
//!
//! NO SHELL, NO taskkill, NO PID ENUMERATION. The executable is resolved from
//! `%SystemRoot%` and passed as `lpApplicationName` with argv alongside;
//! cleanup is by retained handle only.
//!
//! WHAT IS FIXTURE AND WHAT IS UNDER TEST. `NulHandles` opens the three
//! inheritable handles a `ProcessSpec` requires, and `Observing` is a pure
//! delegating decorator over `SystemWin32` that records what the kernel
//! answered at one specific moment. Neither reimplements any production
//! authority: every containment decision — the attribute list, the assignment,
//! the membership proof, the resume ordering, the exit-code discipline — stays
//! in the crate and is exercised through its public surface.

use std::cell::Cell;
use std::fs::OpenOptions;
use std::os::windows::io::AsRawHandle;
use std::ptr;

use moe_windows_job_core::{
    query_exit_status, query_identity, wait_for_process, ContainedProcess, CreatedProcess,
    ExitStatus, Job, NativeError, ProcessCalls, ProcessSpec, RawHandle, SystemWin32, UnknownExit,
    WaitOutcome, Waited, Win32Calls, INHERITED_HANDLE_COUNT,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, HANDLE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// Long enough that a `ping -n 1` would have finished several times over if its
/// thread were running, short enough not to stall the suite. The TIMEOUT is the
/// observation: a process that never ran cannot signal.
const SUSPENDED_PROBE_MS: u32 = 500;

/// Three inheritable handles to the NUL device.
///
/// A `ProcessSpec` requires exactly three, and they must be inheritable or the
/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` allowlist rejects them. `std` opens NUL
/// non-inheritably, so each is duplicated with `bInheritHandle = TRUE`. Using
/// NUL rather than this process's console also keeps the child's output off the
/// test transcript.
struct NulHandles {
    handles: [HANDLE; INHERITED_HANDLE_COUNT],
}

impl NulHandles {
    fn open() -> Self {
        Self { handles: [inheritable_nul(), inheritable_nul(), inheritable_nul()] }
    }

    fn raw(&self) -> [RawHandle; INHERITED_HANDLE_COUNT] {
        [
            RawHandle::new(self.handles[0] as isize),
            RawHandle::new(self.handles[1] as isize),
            RawHandle::new(self.handles[2] as isize),
        ]
    }
}

impl Drop for NulHandles {
    /// Closes on EVERY exit path, including a panicking one: a `Drop` impl runs
    /// while the stack unwinds.
    fn drop(&mut self) {
        for handle in self.handles {
            // SAFETY: each handle was produced by DuplicateHandle in this
            // process and is closed exactly once, here.
            unsafe { CloseHandle(handle) };
        }
    }
}

fn inheritable_nul() -> HANDLE {
    let file = OpenOptions::new().read(true).write(true).open("NUL").expect("NUL must open");
    let mut duplicate: HANDLE = ptr::null_mut();
    // SAFETY: `file` is open for the duration of the call, `duplicate` is a live
    // out-parameter, and GetCurrentProcess returns a pseudo-handle that needs no
    // closing. bInheritHandle is 1 (TRUE), which is the whole point.
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            file.as_raw_handle() as HANDLE,
            GetCurrentProcess(),
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    };
    // SAFETY: read immediately after the failed call, before anything else runs.
    assert!(ok != 0, "DuplicateHandle failed with {}", unsafe { GetLastError() });
    duplicate
}

/// Owns the UTF-16 buffers a [`ProcessSpec`] borrows, for a real executable.
struct Command {
    application: Vec<u16>,
    command_line: Vec<u16>,
    current_directory: Vec<u16>,
    environment: Vec<u16>,
}

impl Command {
    /// Resolves `program` under `%SystemRoot%\System32`. Resolved from the
    /// environment rather than hardcoded to `C:\Windows`, which is not where
    /// Windows is installed on every host.
    fn in_system32(program: &str, arguments: &str) -> Self {
        let root = std::env::var("SystemRoot").expect("SystemRoot must be set on Windows");
        let directory = format!("{root}\\System32");
        let application = format!("{directory}\\{program}");
        Self {
            command_line: wide(&format!("{program} {arguments}")),
            application: wide(&application),
            environment: environment_block(&[
                format!("SystemRoot={root}"),
                format!("Path={directory}"),
            ]),
            current_directory: wide(&directory),
        }
    }

    fn spec<'a>(&'a self, nul: &'a NulHandles) -> ProcessSpec<'a> {
        ProcessSpec {
            application: &self.application,
            command_line: &self.command_line,
            current_directory: &self.current_directory,
            environment: &self.environment,
            inherited: nul.raw(),
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// Case-folds a UTF-16 path for comparison. Windows paths are case-insensitive,
/// and the kernel may report a different case than was requested.
fn upper(text: &[u16]) -> Vec<u16> {
    text.iter().map(|unit| char::from_u32(u32::from(*unit)).map_or(*unit, |c| c.to_ascii_uppercase() as u16)).collect()
}

fn environment_block(entries: &[String]) -> Vec<u16> {
    let mut block: Vec<u16> =
        entries.iter().flat_map(|entry| entry.encode_utf16().chain([0])).collect();
    block.push(0);
    block
}

/// A pure delegating decorator over [`SystemWin32`] that records what the kernel
/// answered AT THE MEMBERSHIP PROOF — the one moment between `CreateProcessW`
/// returning a suspended child and `ResumeThread` letting it run.
///
/// It decides nothing and reimplements nothing: every method forwards to the
/// real boundary. The three observations are taken inside `is_process_in_job`
/// only because that is where the production ordering puts the caller at that
/// instant, and because that method already receives both handles it needs.
struct Observing {
    inner: SystemWin32,
    membership: Cell<Option<bool>>,
    active_processes: Cell<Option<u32>>,
    wait_while_suspended: Cell<Option<WaitOutcome>>,
}

impl Observing {
    fn new() -> Self {
        Self {
            inner: SystemWin32,
            membership: Cell::new(None),
            active_processes: Cell::new(None),
            wait_while_suspended: Cell::new(None),
        }
    }
}

impl Win32Calls for Observing {
    fn create_job_object(&self) -> Result<RawHandle, NativeError> {
        self.inner.create_job_object()
    }

    fn set_limit_flags(&self, job: RawHandle, flags: u32) -> Result<(), NativeError> {
        self.inner.set_limit_flags(job, flags)
    }

    fn query_limit_flags(&self, job: RawHandle) -> Result<u32, NativeError> {
        self.inner.query_limit_flags(job)
    }

    fn terminate_job(&self, job: RawHandle) -> Result<(), NativeError> {
        self.inner.terminate_job(job)
    }

    fn query_active_processes(&self, job: RawHandle) -> Result<u32, NativeError> {
        self.inner.query_active_processes(job)
    }

    fn close_handle(&self, handle: RawHandle) -> Result<(), NativeError> {
        self.inner.close_handle(handle)
    }
}

impl ProcessCalls for Observing {
    /// Named by projection rather than spelled out: the real attribute-list type
    /// is private to the crate, and a decorator has no business naming it.
    type AttributeList = <SystemWin32 as ProcessCalls>::AttributeList;

    fn init_attribute_list(&self, attributes: u32) -> Result<Self::AttributeList, NativeError> {
        self.inner.init_attribute_list(attributes)
    }

    fn set_job_list_attribute(
        &self,
        list: &mut Self::AttributeList,
        job: RawHandle,
    ) -> Result<(), NativeError> {
        self.inner.set_job_list_attribute(list, job)
    }

    fn set_handle_list_attribute(
        &self,
        list: &mut Self::AttributeList,
        handles: [RawHandle; INHERITED_HANDLE_COUNT],
    ) -> Result<(), NativeError> {
        self.inner.set_handle_list_attribute(list, handles)
    }

    fn create_process_suspended(
        &self,
        spec: &ProcessSpec<'_>,
        list: &Self::AttributeList,
    ) -> Result<CreatedProcess, NativeError> {
        self.inner.create_process_suspended(spec, list)
    }

    fn assign_process_to_job(
        &self,
        process: RawHandle,
        job: RawHandle,
    ) -> Result<(), NativeError> {
        self.inner.assign_process_to_job(process, job)
    }

    fn is_process_in_job(&self, process: RawHandle, job: RawHandle) -> Result<bool, NativeError> {
        let member = self.inner.is_process_in_job(process, job)?;
        self.membership.set(Some(member));
        self.active_processes.set(Some(self.inner.query_active_processes(job)?));
        self.wait_while_suspended
            .set(Some(self.inner.wait_for_process(process, SUSPENDED_PROBE_MS)?));
        Ok(member)
    }

    fn process_id(&self, process: RawHandle) -> Result<u32, NativeError> {
        self.inner.process_id(process)
    }

    fn creation_time(&self, process: RawHandle) -> Result<u64, NativeError> {
        self.inner.creation_time(process)
    }

    fn resume_thread(&self, thread: RawHandle) -> Result<u32, NativeError> {
        self.inner.resume_thread(thread)
    }

    fn wait_for_process(
        &self,
        process: RawHandle,
        timeout_ms: u32,
    ) -> Result<WaitOutcome, NativeError> {
        self.inner.wait_for_process(process, timeout_ms)
    }

    fn exit_code(&self, process: RawHandle) -> Result<u32, NativeError> {
        self.inner.exit_code(process)
    }

    fn terminate_process(&self, process: RawHandle) -> Result<(), NativeError> {
        self.inner.terminate_process(process)
    }

    fn image_name(&self, process: RawHandle) -> Result<Vec<u16>, NativeError> {
        self.inner.image_name(process)
    }

    fn delete_attribute_list(&self, list: Self::AttributeList) {
        self.inner.delete_attribute_list(list);
    }
}

#[test]
fn a_suspended_child_is_inside_the_job_and_has_not_run_before_the_proofs() {
    // TEST A. `ping -n 1 127.0.0.1` exits in tens of milliseconds once it runs.
    // At the membership proof it has not been resumed, so a 500ms wait on its
    // handle MUST time out. That timeout is the observation that the thread
    // never executed -- there is no marker file and no race.
    let nul = NulHandles::open();
    let calls = Observing::new();
    let job = Job::create(&calls).expect("a real Job must be creatable");
    let command = Command::in_system32("PING.EXE", "-n 1 127.0.0.1");

    let contained = ContainedProcess::create(&calls, &job, &command.spec(&nul))
        .expect("a real suspended child must be creatable inside the Job");

    // Recorded BEFORE resume, by the kernel, at the membership proof.
    assert_eq!(
        calls.membership.get(),
        Some(true),
        "the child was not in the Job before it was allowed to run"
    );
    assert_eq!(calls.active_processes.get(), Some(1), "the Job did not hold exactly one process");
    assert_eq!(
        calls.wait_while_suspended.get(),
        Some(WaitOutcome::TimedOut),
        "the suspended child signalled, so its thread had already run"
    );

    // With no wait yet on this side, the exit code is not knowable and must not
    // be invented -- 259 would otherwise be reported as an exit code here.
    assert_eq!(
        query_exit_status(&calls, &contained, None).expect("an unknown exit is not a failure"),
        ExitStatus::Unknown(UnknownExit::NotWaited)
    );

    // The identity comes from the live handle, and the image is what the kernel
    // loaded rather than what was asked for.
    let identity = query_identity(&calls, &contained).expect("a real identity query must succeed");
    assert!(identity.pid != 0, "a real PID must be nonzero");
    assert!(identity.creation_time != 0, "a real creation time must be nonzero");
    // `assert!` rather than `assert_eq!`, and the message names NEITHER path.
    // A failing assert_eq! is a panic message, and a panic message carrying an
    // executable path is exactly the echo the rail forbids -- the same reason
    // `RawHandle` has no `Debug`.
    let requested: Vec<u16> = command.application.iter().copied().take_while(|u| *u != 0).collect();
    assert!(
        upper(&identity.image) == upper(&requested),
        "the kernel loaded a different image than the one requested"
    );

    // Resumed by construction, so now it really does exit.
    let waited = wait_for_process(&calls, &contained, u32::MAX).expect("a real wait must succeed");
    assert!(matches!(waited, Waited::Signalled(_)), "the resumed child never exited");

    match query_exit_status(&calls, &contained, Some(&waited)).expect("a real exit query succeeds")
    {
        ExitStatus::Exited(code) => assert_eq!(code.value(), 0, "ping to 127.0.0.1 must succeed"),
        other => panic!("a signalled process must have an exit code, got {other:?}"),
    }

    contained.close().expect("closing real handles must succeed");
    job.close().expect("closing the real Job must succeed");
}

#[test]
fn terminating_the_job_leaves_no_live_process_in_it() {
    // TEST B. A 60-second ping is still running when the Job is terminated, so
    // "the count reached zero" cannot be an accident of timing.
    let nul = NulHandles::open();
    let calls = SystemWin32;
    let job = Job::create(&calls).expect("a real Job must be creatable");
    let command = Command::in_system32("PING.EXE", "-n 60 127.0.0.1");

    let contained = ContainedProcess::create(&calls, &job, &command.spec(&nul))
        .expect("a real child must be creatable inside the Job");

    assert_eq!(job.active_processes().expect("a real count must be readable"), 1);

    job.terminate().expect("terminating a real Job must succeed");

    // WAIT on the retained handle rather than sleeping. TerminateJobObject
    // returns before its processes are gone, so a sleep-and-sample here would
    // be a flake dressed up as a proof.
    let waited = wait_for_process(&calls, &contained, u32::MAX).expect("a real wait must succeed");
    assert!(matches!(waited, Waited::Signalled(_)), "the terminated child never exited");

    assert_eq!(
        job.active_processes().expect("a real count must be readable"),
        0,
        "the Job still holds a live process after termination"
    );

    // Terminated, not exited on its own: the status is still a real exit code,
    // read only after the wait that observed it.
    let status = query_exit_status(&calls, &contained, Some(&waited)).expect("a real exit query");
    assert!(matches!(status, ExitStatus::Exited(_)), "a signalled process has an exit code");

    contained.close().expect("closing real handles must succeed");
    job.close().expect("closing the real Job must succeed");
}

