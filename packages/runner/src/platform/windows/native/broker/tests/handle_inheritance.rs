//! The provider inherits THREE handles and nothing else — proved by the child.
//!
//! WHY THE CHILD HAS TO SAY IT. The tempting version of this test asserts what
//! the parent put in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. That is the assumption
//! restated, not evidence: it would stay green if inheritance leaked every
//! handle in the process, because the parent's list would be unchanged. Only the
//! child can see its own handle table, so `handle_probe` looks and reports back,
//! and every assertion below is about what it SAW.
//!
//! THE LAUNCH IS THE PRODUCTION ONE. `Job::create` then
//! `ContainedProcess::create` from `moe-windows-job-core`, so this is evidence
//! about the path that ships rather than a bespoke `CreateProcessW` written for
//! the test. `Recording` is a pure delegating decorator that notes the handle
//! VALUES the boundary produced; it decides nothing.
//!
//! WHY THE FORBIDDEN VALUES ARRIVE ON THE CHILD'S STDIN. Two of the six — the
//! child's own process and thread handles — are created BY `CreateProcessW`, so
//! they do not exist while its command line is being built. Argv cannot carry
//! them in any ordering. The parent writes all six down the child's stdin once
//! `create` has returned.
//!
//! NO NUMERIC HANDLE VALUE IS ASSERTED ANYWHERE. Values are not stable across
//! runs; only presence, absence and type are.

use std::cell::Cell;
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr;

use moe_windows_job_core::{
    query_exit_status, wait_for_process, ContainedProcess, CreatedProcess, ExitStatus, Job,
    NativeError, ProcessCalls, ProcessSpec, RawHandle, SystemWin32, WaitOutcome, Waited,
    Win32Calls, INHERITED_HANDLE_COUNT,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, HANDLE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

/// fd0, fd1, fd2, the Job, the process and the thread.
const FORBIDDEN_COUNT: usize = 6;

/// Every handle this test asks the child about must have a value at or above
/// this, and [`HandleFloor`] is what makes that true.
///
/// WHY IT MATTERS. "Absent" is answered by `GetHandleInformation` on a NUMBER,
/// and Windows hands out handle values as small ascending indices in EACH
/// process independently. A parent handle that happened to share a value with
/// something the child opened for itself would be reported present, and the test
/// would fail while nothing was actually wrong — a false alarm, never a false
/// pass, but a flaky proof gets deleted rather than believed. Raising the
/// parent's values out of the range a handful of child-local handles can reach
/// turns that from a probability into a structural fact, and the assertions
/// below check it rather than trusting it.
const HANDLE_VALUE_FLOOR: isize = 4096;

#[test]
fn the_probe_child_sees_only_the_three_handles_it_was_allowed() {
    let _floor = HandleFloor::raise();

    // The parent's own pipes. The three the child gets are INHERITABLE
    // duplicates; the three originals never leave this process.
    let (to_child, from_parent) = std::io::pipe().expect("a pipe must be creatable");
    let (from_child, to_parent) = std::io::pipe().expect("a pipe must be creatable");
    let (child_errors, to_parent_errors) = std::io::pipe().expect("a pipe must be creatable");
    let mut from_parent = from_parent;
    let mut from_child = from_child;

    let allowed = Inheritable::three([
        inheritable(to_child.as_raw_handle() as HANDLE),
        inheritable(to_parent.as_raw_handle() as HANDLE),
        inheritable(to_parent_errors.as_raw_handle() as HANDLE),
    ]);

    // Three more pipe handles this process holds and never passes. They stand in
    // for the Node parent's fd0/fd1/fd2, which the provider must not see.
    let (unpassed_read, unpassed_write) = std::io::pipe().expect("a pipe must be creatable");
    let (unpassed_spare, _keep_alive) = std::io::pipe().expect("a pipe must be creatable");

    let calls = Recording::new();
    let job = Job::create(&calls).expect("a real Job must be creatable");
    let command = Command::for_probe(allowed.values());

    let contained = ContainedProcess::create(&calls, &job, &command.spec(allowed.raw()))
        .expect("the probe must be creatable inside the Job");

    // The child has its own copies now. Dropping the parent's inheritable
    // duplicates is what lets the child observe end-of-stream on stdin and what
    // lets THIS process observe it on the child's stdout.
    let allowed_values = allowed.values();
    drop(allowed);
    drop(to_child);
    drop(to_parent);
    drop(to_parent_errors);

    let forbidden: [isize; FORBIDDEN_COUNT] = [
        unpassed_read.as_raw_handle() as isize,
        unpassed_write.as_raw_handle() as isize,
        unpassed_spare.as_raw_handle() as isize,
        calls.job.get(),
        calls.process.get(),
        calls.thread.get(),
    ];
    assert!(
        forbidden.iter().all(|value| *value != 0),
        "the recorder did not capture every handle the launch produced"
    );
    // The floor holds for everything the child is asked about, so a `present`
    // answer below can only mean a real leak and never a coincidental value.
    assert!(
        forbidden.iter().chain(allowed_values.iter()).all(|value| *value >= HANDLE_VALUE_FLOOR),
        "a handle value fell below the floor, so absence would be ambiguous"
    );

    let line = forbidden.map(|value| value.to_string()).join(" ");
    writeln!(from_parent, "{line}").expect("the probe's stdin must accept the forbidden values");
    drop(from_parent);

    let mut report = String::new();
    from_child.read_to_string(&mut report).expect("the probe's report must be readable");

    let waited = wait_for_process(&calls, &contained, u32::MAX).expect("a real wait must succeed");
    assert!(matches!(waited, Waited::Signalled(_)), "the probe never exited");
    let status = query_exit_status(&calls, &contained, Some(&waited)).expect("a real exit query");

    // POSITIVE OBSERVATIONS, all three of them made by the child.
    assert!(
        report.contains("allowed 0=pipe 1=pipe 2=pipe"),
        "the child could not use the three handles it WAS given: {report}"
    );
    assert!(
        report.contains("forbidden 0=absent 1=absent 2=absent 3=absent 4=absent 5=absent"),
        "a handle the provider must not have reached the child: {report}"
    );
    assert!(
        !report.contains("present"),
        "the child found a forbidden handle in its own table: {report}"
    );
    // The core hands stdio through STARTF_USESTDHANDLES and leaves lpReserved2
    // null, so a child launched this way has NO CRT block at all. Pinned because
    // it is the difference between this launch path and Node's.
    assert!(
        report.contains("crt=BlockAbsent"),
        "the core's launch path grew a CRT descriptor block: {report}"
    );
    match status {
        ExitStatus::Exited(code) => {
            assert_eq!(code.value(), 0, "the probe's own verdict was a failure: {report}")
        }
        other => panic!("a signalled process must have an exit code, got {other:?}"),
    }

    contained.close().expect("closing the probe's handles must succeed");
    job.close().expect("closing the real Job must succeed");
    drop(child_errors);
}

/// Holds enough handles open that every value allocated afterwards is at or
/// above [`HANDLE_VALUE_FLOOR`].
///
/// Windows hands out the lowest free index, so keeping the low ones occupied is
/// all it takes. The duplicates are of this process's own pseudo-handle — the
/// cheapest real handle available — and NON-inheritable, so they could not reach
/// a child even if the allowlist were not already stopping them.
struct HandleFloor {
    handles: Vec<HANDLE>,
}

impl HandleFloor {
    fn raise() -> Self {
        let mut handles = Vec::new();
        loop {
            let mut duplicate: HANDLE = ptr::null_mut();
            // SAFETY: both process arguments are pseudo-handles needing no
            // close, and `duplicate` is a live out-parameter. bInheritHandle is
            // 0 (FALSE) deliberately.
            let ok = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    GetCurrentProcess(),
                    GetCurrentProcess(),
                    &mut duplicate,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            };
            assert!(ok != 0, "DuplicateHandle failed while raising the handle floor");
            let value = duplicate as isize;
            handles.push(duplicate);
            if value >= HANDLE_VALUE_FLOOR {
                return Self { handles };
            }
            assert!(handles.len() < 65_536, "handle values never reached the floor");
        }
    }
}

impl Drop for HandleFloor {
    fn drop(&mut self) {
        for handle in &self.handles {
            // SAFETY: each was produced by DuplicateHandle here and is closed
            // exactly once.
            unsafe { CloseHandle(*handle) };
        }
    }
}

/// Three inheritable duplicates, closed exactly once each.
///
/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` REJECTS NON-INHERITABLE HANDLES, and
/// `std` opens its pipes non-inheritable, so duplication is required rather than
/// tidy. `Drop` runs while a panic unwinds, so these close on the failing paths
/// too — and the Job is configured `KILL_ON_JOB_CLOSE`, so a panic before the
/// wait still takes the probe down with it.
struct Inheritable {
    handles: [HANDLE; INHERITED_HANDLE_COUNT],
}

impl Inheritable {
    fn three(handles: [HANDLE; INHERITED_HANDLE_COUNT]) -> Self {
        Self { handles }
    }

    fn raw(&self) -> [RawHandle; INHERITED_HANDLE_COUNT] {
        [
            RawHandle::new(self.handles[0] as isize),
            RawHandle::new(self.handles[1] as isize),
            RawHandle::new(self.handles[2] as isize),
        ]
    }

    /// The values the child is TOLD it should be able to use, so it can confirm
    /// them positively rather than the parent asserting they were passed.
    fn values(&self) -> [isize; INHERITED_HANDLE_COUNT] {
        [self.handles[0] as isize, self.handles[1] as isize, self.handles[2] as isize]
    }
}

impl Drop for Inheritable {
    fn drop(&mut self) {
        for handle in self.handles {
            // SAFETY: each was produced by DuplicateHandle in this process and
            // is closed exactly once, here.
            unsafe { CloseHandle(handle) };
        }
    }
}

fn inheritable(source: HANDLE) -> HANDLE {
    let mut duplicate: HANDLE = ptr::null_mut();
    // SAFETY: `source` is open for the duration of the call and `duplicate` is a
    // live out-parameter. GetCurrentProcess returns a pseudo-handle that needs no
    // closing. bInheritHandle is 1 (TRUE), which is the entire point.
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            source,
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

/// Owns the UTF-16 buffers a [`ProcessSpec`] borrows, for the probe binary.
struct Command {
    application: Vec<u16>,
    command_line: Vec<u16>,
    current_directory: Vec<u16>,
    environment: Vec<u16>,
}

impl Command {
    /// `CARGO_BIN_EXE_handle_probe` is cargo's own answer for where it put the
    /// fixture, so nothing here guesses a path.
    fn for_probe(allowed: [isize; INHERITED_HANDLE_COUNT]) -> Self {
        let exe = Path::new(env!("CARGO_BIN_EXE_handle_probe"));
        let directory = exe.parent().expect("a built binary always has a parent directory");
        let root = std::env::var("SystemRoot").expect("SystemRoot must be set on Windows");
        Self {
            // argv[0] is quoted: the target directory path contains separators
            // and may contain spaces, and an unquoted argv[0] would split.
            command_line: wide(&format!(
                "\"{}\" {} {} {}",
                exe.display(),
                allowed[0],
                allowed[1],
                allowed[2]
            )),
            application: wide(&exe.display().to_string()),
            environment: environment_block(&[format!("SystemRoot={root}")]),
            current_directory: wide(&directory.display().to_string()),
        }
    }

    fn spec<'a>(&'a self, inherited: [RawHandle; INHERITED_HANDLE_COUNT]) -> ProcessSpec<'a> {
        ProcessSpec {
            application: &self.application,
            command_line: &self.command_line,
            current_directory: &self.current_directory,
            environment: &self.environment,
            inherited,
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

fn environment_block(entries: &[String]) -> Vec<u16> {
    let mut block: Vec<u16> =
        entries.iter().flat_map(|entry| entry.encode_utf16().chain([0])).collect();
    block.push(0);
    block
}

/// A pure delegating decorator over [`SystemWin32`] that records the handle
/// VALUES the boundary produced, so the parent can tell the child what to look
/// for. It reimplements nothing: every method forwards.
struct Recording {
    inner: SystemWin32,
    job: Cell<isize>,
    process: Cell<isize>,
    thread: Cell<isize>,
}

impl Recording {
    fn new() -> Self {
        Self { inner: SystemWin32, job: Cell::new(0), process: Cell::new(0), thread: Cell::new(0) }
    }
}

impl Win32Calls for Recording {
    fn create_job_object(&self) -> Result<RawHandle, NativeError> {
        let job = self.inner.create_job_object()?;
        self.job.set(job.value());
        Ok(job)
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

impl ProcessCalls for Recording {
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
        let created = self.inner.create_process_suspended(spec, list)?;
        self.process.set(created.process.value());
        self.thread.set(created.thread.value());
        Ok(created)
    }

    fn assign_process_to_job(&self, process: RawHandle, job: RawHandle) -> Result<(), NativeError> {
        self.inner.assign_process_to_job(process, job)
    }

    fn is_process_in_job(&self, process: RawHandle, job: RawHandle) -> Result<bool, NativeError> {
        self.inner.is_process_in_job(process, job)
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
