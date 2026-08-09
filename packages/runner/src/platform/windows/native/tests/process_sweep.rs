//! Failure sweep over every construction arm, driven through the injected call
//! table.
//!
//! Same discipline as tests/job_sweep.rs: every assertion pins the EXACT
//! `NativeOp` and the EXACT numeric Win32 code, because a test that only checks
//! "it refused" stays green when the production code starts refusing somewhere
//! else — and construction has FOUR refusal shapes that are one careless
//! `assert!(result.is_err())` away from collapsing into two.
//!
//! The scripted table is a test double for the Win32 boundary ONLY. It
//! reimplements no construction logic: the ordering, the membership refusal,
//! the suspend-count refusal and the cleanup discipline all live in the
//! production surface and are asserted against it.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};

use moe_windows_job_core::{
    query_exit_status, query_identity, terminate_process, unwind_after_membership,
    unwind_before_membership, wait_for_process, ContainedProcess, CreatedProcess, ExitStatus, Job,
    NativeError, NativeOp, ProcessCalls, ProcessSpec, RawHandle, UnknownExit, WaitOutcome, Waited,
    Win32Calls, INHERITED_HANDLE_COUNT, REQUIRED_LIMIT_FLAGS,
};

/// A Win32 handle value the scripted table hands out. Any nonzero value works;
/// it exists so close-counting can distinguish handles by identity.
const FIRST_HANDLE: isize = 0x1000;

/// Handles the CALLER owns and merely lends for inheritance. Deliberately far
/// from `FIRST_HANDLE` so a close landing on one is unmistakable.
const INHERITED: [RawHandle; INHERITED_HANDLE_COUNT] =
    [RawHandle::new(0x11), RawHandle::new(0x12), RawHandle::new(0x13)];

/// What the double reports for the identity arms. Arbitrary; asserted, so a
/// production surface that fabricated an identity instead of querying one would
/// fail rather than pass.
const SCRIPTED_PID: u32 = 4_321;
const SCRIPTED_CREATION_TIME: u64 = 0x01DB_0000_0000_0001;
const SCRIPTED_IMAGE: &str = "C:\\Windows\\System32\\PING.EXE";

/// Scripted Win32 + construction boundary: records an ordered call log, counts
/// closes per handle and attribute-list deletions, and can be programmed to
/// fail at exactly one arm.
struct ScriptedCalls {
    fail_at: Option<NativeOp>,
    fail_code: u32,
    /// What `is_process_in_job` reports when the CALL itself succeeds.
    in_job: Cell<bool>,
    /// What `resume_thread` reports as the PRIOR suspend count.
    prior_suspend_count: Cell<u32>,
    /// A SECOND programmable failure, for the close arm only.
    ///
    /// Needed because "the first error survives cleanup" is only testable when
    /// the cleanup actually HAS an outcome available to overwrite the first
    /// error with. With a single `fail_at` the cleanup always succeeds and the
    /// test proves nothing.
    close_failure: Cell<Option<u32>>,
    /// A THIRD programmable failure, for the process-terminate arm only.
    ///
    /// Same reason `close_failure` exists: proving that an unwind failure does
    /// not overwrite the error that CAUSED the unwind needs two failures at
    /// once, and `fail_at` only ever programs one.
    terminate_failure: Cell<Option<u32>>,
    /// What `wait_for_process` reports when the CALL itself succeeds. Three of
    /// the four Win32 results are Ok values, so this is programmable rather
    /// than being folded into `fail_at`.
    wait_outcome: Cell<WaitOutcome>,
    /// What `exit_code` reports. 259 is a legitimate value here, not a sentinel.
    exit_code: Cell<u32>,
    /// How many more processes `query_active_processes` reports before it
    /// reaches zero, decremented on every call. `TerminateJobObject` returns
    /// before its processes are gone, so a single sample would let a
    /// sample-once implementation pass.
    active_remaining: Cell<u32>,
    log: RefCell<Vec<&'static str>>,
    closes: RefCell<BTreeMap<isize, usize>>,
    next_handle: Cell<isize>,
    deletes: Cell<usize>,
}

impl ScriptedCalls {
    fn healthy() -> Self {
        Self {
            fail_at: None,
            fail_code: 0,
            in_job: Cell::new(true),
            prior_suspend_count: Cell::new(1),
            close_failure: Cell::new(None),
            terminate_failure: Cell::new(None),
            wait_outcome: Cell::new(WaitOutcome::Signalled),
            exit_code: Cell::new(0),
            active_remaining: Cell::new(0),
            log: RefCell::new(Vec::new()),
            closes: RefCell::new(BTreeMap::new()),
            next_handle: Cell::new(FIRST_HANDLE),
            deletes: Cell::new(0),
        }
    }

    fn failing(op: NativeOp, code: u32) -> Self {
        Self { fail_at: Some(op), fail_code: code, ..Self::healthy() }
    }

    /// The call SUCCEEDS and reports this membership answer. Distinct from
    /// `failing(IsProcessInJob, _)`, which is the call itself failing.
    fn reporting_membership(answer: bool) -> Self {
        let calls = Self::healthy();
        calls.in_job.set(answer);
        calls
    }

    /// The call SUCCEEDS and reports this prior suspend count. Distinct from
    /// `failing(ResumeThread, _)`, which is the call itself failing.
    fn reporting_suspend_count(count: u32) -> Self {
        let calls = Self::healthy();
        calls.prior_suspend_count.set(count);
        calls
    }

    /// Every close from here on fails with `code`, whatever else is programmed.
    fn fail_closes_with(&self, code: u32) {
        self.close_failure.set(Some(code));
    }

    /// Every process-terminate from here on fails with `code`, whatever else is
    /// programmed.
    fn fail_process_terminate_with(&self, code: u32) {
        self.terminate_failure.set(Some(code));
    }

    /// The wait CALL succeeds and reports this outcome. Distinct from
    /// `failing(WaitForProcess, _)`, which is the call itself failing.
    fn reporting_wait(&self, outcome: WaitOutcome) {
        self.wait_outcome.set(outcome);
    }

    /// The exit-code CALL succeeds and reports this number.
    fn reporting_exit_code(&self, code: u32) {
        self.exit_code.set(code);
    }

    /// The Job reports this many live processes, counting down one per query.
    fn reporting_active_processes(&self, count: u32) {
        self.active_remaining.set(count);
    }

    /// Records the call, then fails it if this arm is the programmed one.
    fn arm(&self, op: NativeOp, name: &'static str) -> Result<(), NativeError> {
        self.log.borrow_mut().push(name);
        if self.fail_at == Some(op) {
            return Err(NativeError::new(op, self.fail_code));
        }
        Ok(())
    }

    fn hand_out(&self) -> RawHandle {
        let value = self.next_handle.get();
        self.next_handle.set(value + 1);
        RawHandle::new(value)
    }

    fn calls(&self) -> Vec<&'static str> {
        self.log.borrow().clone()
    }

    fn close_count(&self, handle: isize) -> usize {
        self.closes.borrow().get(&handle).copied().unwrap_or(0)
    }

    fn handles_opened(&self) -> usize {
        (self.next_handle.get() - FIRST_HANDLE) as usize
    }

    fn deletes(&self) -> usize {
        self.deletes.get()
    }
}

impl Win32Calls for ScriptedCalls {
    fn create_job_object(&self) -> Result<RawHandle, NativeError> {
        self.arm(NativeOp::CreateJobObject, "create")?;
        Ok(self.hand_out())
    }

    fn set_limit_flags(&self, _job: RawHandle, _flags: u32) -> Result<(), NativeError> {
        self.arm(NativeOp::SetInformation, "set")
    }

    fn query_limit_flags(&self, _job: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryInformation, "query")?;
        Ok(REQUIRED_LIMIT_FLAGS)
    }

    fn terminate_job(&self, _job: RawHandle) -> Result<(), NativeError> {
        self.arm(NativeOp::TerminateJob, "terminate")
    }

    fn query_active_processes(&self, _job: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryAccounting, "accounting")?;
        let remaining = self.active_remaining.get();
        self.active_remaining.set(remaining.saturating_sub(1));
        Ok(remaining)
    }

    fn close_handle(&self, handle: RawHandle) -> Result<(), NativeError> {
        *self.closes.borrow_mut().entry(handle.value()).or_insert(0) += 1;
        self.arm(NativeOp::CloseHandle, "close")?;
        match self.close_failure.get() {
            Some(code) => Err(NativeError::new(NativeOp::CloseHandle, code)),
            None => Ok(()),
        }
    }
}

impl ProcessCalls for ScriptedCalls {
    /// The double owns no buffer, so the associated type costs it nothing. That
    /// is the whole reason the trait carries one instead of a concrete type.
    type AttributeList = ();

    fn init_attribute_list(&self, _attributes: u32) -> Result<(), NativeError> {
        self.arm(NativeOp::InitAttributeList, "init")
    }

    fn set_job_list_attribute(
        &self,
        _list: &mut (),
        _job: RawHandle,
    ) -> Result<(), NativeError> {
        self.arm(NativeOp::SetJobListAttribute, "job-list")
    }

    fn set_handle_list_attribute(
        &self,
        _list: &mut (),
        handles: [RawHandle; INHERITED_HANDLE_COUNT],
    ) -> Result<(), NativeError> {
        // `assert!` rather than `assert_eq!`: RawHandle has no Debug, by rail,
        // so the equality macro cannot format it. That is the guard working —
        // a raw handle value must not be printable even from a test failure.
        assert!(handles == INHERITED, "the allowlist must be the caller's three handles");
        self.arm(NativeOp::SetHandleListAttribute, "handle-list")
    }

    fn create_process_suspended(
        &self,
        _spec: &ProcessSpec<'_>,
        _list: &(),
    ) -> Result<CreatedProcess, NativeError> {
        self.arm(NativeOp::CreateProcess, "create-process")?;
        Ok(CreatedProcess { process: self.hand_out(), thread: self.hand_out() })
    }

    fn assign_process_to_job(
        &self,
        _process: RawHandle,
        _job: RawHandle,
    ) -> Result<(), NativeError> {
        self.arm(NativeOp::AssignProcessToJob, "assign")
    }

    fn is_process_in_job(&self, _process: RawHandle, _job: RawHandle) -> Result<bool, NativeError> {
        self.arm(NativeOp::IsProcessInJob, "membership")?;
        Ok(self.in_job.get())
    }

    fn process_id(&self, _process: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryProcessId, "pid")?;
        Ok(SCRIPTED_PID)
    }

    fn creation_time(&self, _process: RawHandle) -> Result<u64, NativeError> {
        self.arm(NativeOp::QueryCreationTime, "creation-time")?;
        Ok(SCRIPTED_CREATION_TIME)
    }

    fn resume_thread(&self, _thread: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::ResumeThread, "resume")?;
        Ok(self.prior_suspend_count.get())
    }

    fn wait_for_process(
        &self,
        _process: RawHandle,
        _timeout_ms: u32,
    ) -> Result<WaitOutcome, NativeError> {
        self.arm(NativeOp::WaitForProcess, "wait")?;
        Ok(self.wait_outcome.get())
    }

    fn exit_code(&self, _process: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryExitCode, "exit-code")?;
        Ok(self.exit_code.get())
    }

    fn terminate_process(&self, _process: RawHandle) -> Result<(), NativeError> {
        self.arm(NativeOp::TerminateProcess, "terminate-process")?;
        match self.terminate_failure.get() {
            Some(code) => Err(NativeError::new(NativeOp::TerminateProcess, code)),
            None => Ok(()),
        }
    }

    fn image_name(&self, _process: RawHandle) -> Result<Vec<u16>, NativeError> {
        self.arm(NativeOp::QueryImageName, "image-name")?;
        Ok(wide(SCRIPTED_IMAGE))
    }

    /// Counted rather than logged, and infallible: windows-sys gives
    /// `DeleteProcThreadAttributeList` no return value, so there is no outcome
    /// to script and no `NativeOp` it could report.
    fn delete_attribute_list(&self, _list: ()) {
        self.deletes.set(self.deletes.get() + 1);
    }
}

/// Owns the UTF-16 buffers a [`ProcessSpec`] borrows.
///
/// The contents never matter to the sweep — the double dereferences nothing —
/// but they are well-formed so the same storage can be reused unchanged by the
/// real-Windows acceptance test that sibling 2b owns.
struct SpecStorage {
    application: Vec<u16>,
    command_line: Vec<u16>,
    current_directory: Vec<u16>,
    environment: Vec<u16>,
}

impl SpecStorage {
    fn new() -> Self {
        Self {
            application: wide("C:\\Windows\\System32\\cmd.exe"),
            command_line: wide("cmd.exe /c exit 0"),
            current_directory: wide("C:\\Windows\\System32"),
            environment: environment_block(&["SystemRoot=C:\\Windows"]),
        }
    }

    fn spec(&self) -> ProcessSpec<'_> {
        ProcessSpec {
            application: &self.application,
            command_line: &self.command_line,
            current_directory: &self.current_directory,
            environment: &self.environment,
            inherited: INHERITED,
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

/// A `CREATE_UNICODE_ENVIRONMENT` block: NUL after each entry, then a final NUL.
fn environment_block(entries: &[&str]) -> Vec<u16> {
    let mut block: Vec<u16> = entries.iter().flat_map(|e| e.encode_utf16().chain([0])).collect();
    block.push(0);
    block
}

/// The complete call sequence a healthy construction must produce, including
/// the three Job arms that precede it.
///
/// ONE `assert_eq!` OVER THE WHOLE VECTOR, deliberately. A test shaped as "the
/// resume index is greater than the membership index" passes with an entire
/// step missing — including the membership proof itself.
const HEALTHY_SEQUENCE: [&str; 12] = [
    "create",
    "set",
    "query",
    "init",
    "job-list",
    "handle-list",
    "create-process",
    "assign",
    "membership",
    "pid",
    "creation-time",
    "resume",
];

#[test]
fn successful_construction_calls_every_arm_in_the_pinned_order() {
    let calls = ScriptedCalls::healthy();
    let job = Job::create(&calls).expect("healthy Job construction must succeed");
    let storage = SpecStorage::new();

    let contained = ContainedProcess::create(&calls, &job, &storage.spec())
        .expect("healthy construction must succeed");

    assert_eq!(calls.calls(), HEALTHY_SEQUENCE.to_vec());

    // The identity is QUERIED, not fabricated: both values come back from the
    // boundary, so a production surface that invented them would fail here.
    assert_eq!(contained.pid(), SCRIPTED_PID);
    assert_eq!(contained.creation_time(), SCRIPTED_CREATION_TIME);

    // The attribute list is deleted exactly once even on the success path.
    assert_eq!(calls.deletes(), 1, "attribute list deleted the wrong number of times");

    // Handles the caller merely lent for inheritance are not ours to close.
    for handle in INHERITED {
        assert_eq!(calls.close_count(handle.value()), 0, "closed a caller-owned handle");
    }

    contained.close().expect("healthy close must succeed");
}

/// Runs a whole construction against `calls` and returns the refusal.
///
/// The Job arms stay healthy throughout this file: job_sweep.rs owns their
/// failure modes, and driving them again here would duplicate coverage rather
/// than add any.
fn drive(calls: &ScriptedCalls) -> NativeError {
    let job = Job::create(calls).expect("the Job arms are healthy in this sweep");
    let storage = SpecStorage::new();
    ContainedProcess::create(calls, &job, &storage.spec())
        .err()
        .expect("construction must refuse at the programmed arm")
}

/// One entry per failable construction arm. Frozen, and its length is asserted,
/// so deleting a case cannot silently shrink the sweep.
struct Case {
    op: NativeOp,
    /// A distinct Win32 error per arm: a shared code could not distinguish
    /// "reported the right arm" from "reported the right code by coincidence".
    code: u32,
}

const CASES: [Case; 9] = [
    Case { op: NativeOp::InitAttributeList, code: 122 },      // ERROR_INSUFFICIENT_BUFFER
    Case { op: NativeOp::SetJobListAttribute, code: 8 },      // ERROR_NOT_ENOUGH_MEMORY
    Case { op: NativeOp::SetHandleListAttribute, code: 87 },  // ERROR_INVALID_PARAMETER
    Case { op: NativeOp::CreateProcess, code: 2 },            // ERROR_FILE_NOT_FOUND
    Case { op: NativeOp::AssignProcessToJob, code: 5 },       // ERROR_ACCESS_DENIED
    Case { op: NativeOp::IsProcessInJob, code: 6 },           // ERROR_INVALID_HANDLE
    Case { op: NativeOp::QueryProcessId, code: 1_008 },       // ERROR_NO_TOKEN
    Case { op: NativeOp::QueryCreationTime, code: 998 },      // ERROR_NOACCESS
    Case { op: NativeOp::ResumeThread, code: 1_314 },         // ERROR_PRIVILEGE_NOT_HELD
];

/// The nine construction operations this sweep owns, written by hand and kept
/// INDEPENDENT of `CASES`, exactly as job_sweep.rs keeps `JOB_OPS`.
const CONSTRUCTION_OPS: [NativeOp; 9] = [
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

/// The four lifecycle operations this sweep owns, on the same terms: written by
/// hand, independent of `LIFECYCLE_CASES`, so a dead case fails rather than
/// agreeing with itself.
const LIFECYCLE_OPS: [NativeOp; 4] = [
    NativeOp::WaitForProcess,
    NativeOp::QueryExitCode,
    NativeOp::TerminateProcess,
    NativeOp::QueryImageName,
];

/// How many operations tests/job_sweep.rs owns. Hand-written here too: an
/// integration test is its own crate and cannot share a const with a sibling,
/// and that duplication is exactly what lets each file fail independently.
const JOB_OP_COUNT: usize = 6;

#[test]
fn sweep_pins_the_exact_op_and_code_for_every_construction_arm() {
    // Guard the case list itself: a sweep that generates zero cases passes.
    assert_eq!(CASES.len(), 9, "every failable construction arm needs exactly one case");

    let mut produced = BTreeSet::new();
    for case in &CASES {
        let calls = ScriptedCalls::failing(case.op, case.code);
        let error = drive(&calls);

        assert_eq!(error.op(), case.op, "wrong arm reported for {:?}", case.op);
        assert_eq!(error.code(), case.code, "wrong Win32 code for {:?}", case.op);
        produced.insert(error.op());
    }

    let owned: BTreeSet<NativeOp> = CONSTRUCTION_OPS.iter().copied().collect();
    assert_eq!(produced, owned, "sweep did not reach every construction NativeOp");
    assert_eq!(produced.len(), 9);
}

#[test]
fn sweep_pins_the_exact_op_and_code_for_every_lifecycle_arm() {
    // Guard the case list itself: a sweep that generates zero cases passes.
    assert_eq!(LIFECYCLE_CASES.len(), 4, "every failable lifecycle arm needs exactly one case");

    let mut produced = BTreeSet::new();
    for case in &LIFECYCLE_CASES {
        let calls = ScriptedCalls::failing(case.op, case.code);
        let (job, contained) = healthy_pair(&calls);

        let error = (case.drive)(&calls, &contained)
            .unwrap_or_else(|| panic!("{:?} did not refuse at the programmed arm", case.op));

        assert_eq!(error.op(), case.op, "wrong arm reported for {:?}", case.op);
        assert_eq!(error.code(), case.code, "wrong Win32 code for {:?}", case.op);
        produced.insert(error.op());

        drop(contained);
        drop(job);
    }

    let owned: BTreeSet<NativeOp> = LIFECYCLE_OPS.iter().copied().collect();
    assert_eq!(produced, owned, "sweep did not reach every lifecycle NativeOp");
    assert_eq!(produced.len(), 4);
}

#[test]
fn the_two_sweeps_together_account_for_every_native_op() {
    // THE TOTALITY CHECK job_sweep.rs deliberately no longer owns. Every
    // variant must be reached by exactly one of the two sweeps, so a new
    // process-side variant added without a case fails HERE rather than passing
    // unnoticed in both files.
    //
    // THIS IS ALSO THE PROOF THAT NO OPEN-BY-PID ARM EXISTS. There is no way to
    // assert that a method is absent, so the guarantee is carried by the closed
    // vocabulary instead: reopening a process by PID would need an operation,
    // an operation needs a `NativeOp` variant, and any new variant breaks both
    // the fixed length of `NativeOp::ALL` and the sum below. The absence is
    // enforced by this count, not by a comment.
    let all: BTreeSet<NativeOp> = NativeOp::ALL.iter().copied().collect();
    assert_eq!(all.len(), NativeOp::ALL.len(), "NativeOp::ALL lists a variant twice");

    for op in CONSTRUCTION_OPS.iter().chain(LIFECYCLE_OPS.iter()) {
        assert!(all.contains(op), "{op:?} is no longer listed in NativeOp::ALL");
    }

    assert_eq!(
        CONSTRUCTION_OPS.len() + LIFECYCLE_OPS.len() + JOB_OP_COUNT,
        NativeOp::ALL.len(),
        "a NativeOp variant exists that neither sweep owns a case for"
    );
    assert_eq!(NativeOp::ALL.len(), 19, "the operation vocabulary changed size");
}

#[test]
fn a_failed_membership_call_carries_the_operating_systems_error() {
    let calls = ScriptedCalls::failing(NativeOp::IsProcessInJob, 6);
    let error = drive(&calls);

    assert_eq!(error.op(), NativeOp::IsProcessInJob);
    assert_eq!(error.code(), 6, "a failed CALL must carry the OS error, not our refusal code");
}

#[test]
fn membership_answered_false_is_our_refusal_not_a_win32_failure() {
    // The call SUCCEEDS and answers "not in the Job". Nothing failed at the
    // boundary, so code 0 -- child 1's convention. Collapsing this with the
    // test above would leave both passing while the production code reported
    // one outcome for two very different situations.
    let calls = ScriptedCalls::reporting_membership(false);
    let error = drive(&calls);

    assert_eq!(error.op(), NativeOp::IsProcessInJob);
    assert_eq!(error.code(), 0, "a successful query answering 'no' is our refusal");
}

#[test]
fn a_failed_resume_call_carries_the_operating_systems_error() {
    let calls = ScriptedCalls::failing(NativeOp::ResumeThread, 1_314);
    let error = drive(&calls);

    assert_eq!(error.op(), NativeOp::ResumeThread);
    assert_eq!(error.code(), 1_314);
}

#[test]
fn a_prior_suspend_count_other_than_one_is_our_refusal() {
    // 0 means the thread was never suspended; 2 means someone suspended it
    // again behind us. Both mean the thread is not in the state this code
    // reasoned about, and both are OURS to refuse with code 0.
    for count in [0, 2, 7] {
        let calls = ScriptedCalls::reporting_suspend_count(count);
        let error = drive(&calls);

        assert_eq!(error.op(), NativeOp::ResumeThread, "prior count {count} was not refused");
        assert_eq!(error.code(), 0, "a wrong prior count is our refusal, not a Win32 failure");
    }
}

#[test]
fn resume_never_runs_before_the_membership_proof_succeeds() {
    // ABSENCE FROM THE CALL LOG, not merely an Err return. A production surface
    // that resumed the thread and only afterwards noticed the membership
    // refusal would still return Err, and a test asserting only `is_err()`
    // would stay green while the child had already run.
    for calls in [
        ScriptedCalls::failing(NativeOp::IsProcessInJob, 6),
        ScriptedCalls::reporting_membership(false),
    ] {
        let error = drive(&calls);
        assert_eq!(error.op(), NativeOp::IsProcessInJob);

        assert!(!calls.calls().contains(&"resume"), "resumed a process of unproven membership");

        // Nothing after the proof ran at all -- the identity arms are absent
        // too, which is stronger than checking for "resume" alone. The three
        // trailing closes are the two acquired handles and the Job's own, so
        // this is the COMPLETE log rather than a prefix a later arm could hide
        // behind.
        //
        // The two entries before them are the PRE-MEMBERSHIP unwind: a failed
        // proof means the Job is not known to contain this child, so the child
        // is terminated and awaited through its own handle. Note what is NOT
        // here -- no "terminate" and no "accounting", i.e. the Job-side regime
        // did not run.
        let mut expected = HEALTHY_SEQUENCE[..9].to_vec();
        expected.extend(["terminate-process", "wait", "close", "close", "close"]);
        assert_eq!(calls.calls(), expected);
    }
}

#[test]
fn every_acquired_handle_closes_once_and_the_attribute_list_is_deleted_once() {
    for case in &CASES {
        let calls = ScriptedCalls::failing(case.op, case.code);
        let _ = drive(&calls);

        for index in 0..calls.handles_opened() {
            let handle = FIRST_HANDLE + index as isize;
            assert_eq!(
                calls.close_count(handle),
                1,
                "handle {handle:#x} not closed exactly once after {:?} failed",
                case.op
            );
        }

        for handle in INHERITED {
            assert_eq!(
                calls.close_count(handle.value()),
                0,
                "closed a caller-owned handle after {:?} failed",
                case.op
            );
        }

        // Exactly one deletion on every path that HAS a list. When the
        // initialization itself fails there is no list, so asserting 1 there
        // would be asserting a deletion of nothing.
        let expected = usize::from(case.op != NativeOp::InitAttributeList);
        assert_eq!(
            calls.deletes(),
            expected,
            "attribute list deleted {} times after {:?} failed",
            calls.deletes(),
            case.op
        );
    }
}

#[test]
fn an_unterminated_spec_is_refused_before_any_boundary_call() {
    // Every field here is handed to `unsafe` FFI as a PCWSTR, and a Win32
    // string function reads until it finds a NUL -- so an empty or
    // unterminated slice reads past the caller's allocation. No scripted test
    // could ever observe that: the double dereferences nothing. The refusal is
    // what makes it observable, and it must land BEFORE the boundary.
    let good = SpecStorage::new();
    let unterminated = wide("cmd.exe")[..7].to_vec();

    let mut cases: Vec<ProcessSpec<'_>> = Vec::new();
    cases.push(ProcessSpec { application: &unterminated, ..good.spec() });
    cases.push(ProcessSpec { command_line: &unterminated, ..good.spec() });
    cases.push(ProcessSpec { current_directory: &unterminated, ..good.spec() });
    cases.push(ProcessSpec { application: &[], ..good.spec() });
    // A block that terminates its entry but not the block itself.
    cases.push(ProcessSpec { environment: &[0x41, 0x3D, 0x42, 0], ..good.spec() });
    cases.push(ProcessSpec { environment: &[0], ..good.spec() });
    assert_eq!(cases.len(), 6, "the malformed-spec sweep generated no cases");

    for (index, spec) in cases.iter().enumerate() {
        let calls = ScriptedCalls::healthy();
        let job = Job::create(&calls).expect("healthy Job construction must succeed");
        let error = ContainedProcess::create(&calls, &job, spec)
            .err()
            .unwrap_or_else(|| panic!("malformed spec {index} was accepted"));

        assert_eq!(error.op(), NativeOp::CreateProcess, "wrong arm for malformed spec {index}");
        assert_eq!(error.code(), 0, "a malformed spec is our refusal, not a Win32 failure");
        // Only the three Job arms ran: construction never reached the boundary.
        assert_eq!(calls.calls(), vec!["create", "set", "query"], "case {index} touched Win32");
        assert_eq!(calls.deletes(), 0, "case {index} allocated an attribute list");
    }
}

#[test]
fn the_first_failure_survives_a_failing_cleanup_close() {
    // Assignment fails after BOTH handles were acquired, and every close fails
    // too -- so a cleanup outcome genuinely exists to overwrite the first error
    // with. The caller must still see AssignProcessToJob, or the reason the run
    // failed is hidden behind the reason the cleanup failed.
    let calls = ScriptedCalls::failing(NativeOp::AssignProcessToJob, 5);
    calls.fail_closes_with(1_006);
    let error = drive(&calls);

    assert_eq!(error.op(), NativeOp::AssignProcessToJob, "a cleanup close overwrote the error");
    assert_eq!(error.code(), 5);
    assert_eq!(calls.close_count(FIRST_HANDLE + 1), 1, "process handle leaked or double-closed");
    assert_eq!(calls.close_count(FIRST_HANDLE + 2), 1, "thread handle leaked or double-closed");
}

#[test]
fn a_failed_close_is_never_laundered_into_success() {
    // The close outcome is UNKNOWN, so it must surface as an error rather than
    // become an implicit success -- and BOTH handles must still be attempted,
    // since stopping at the first failure would leak the second.
    let calls = ScriptedCalls::healthy();
    let job = Job::create(&calls).expect("healthy Job construction must succeed");
    let storage = SpecStorage::new();
    let contained = ContainedProcess::create(&calls, &job, &storage.spec())
        .expect("healthy construction must succeed");

    calls.fail_closes_with(998);
    let error = contained.close().err().expect("a failed close must not report success");

    assert_eq!(error.op(), NativeOp::CloseHandle);
    assert_eq!(error.code(), 998);
    assert_eq!(calls.close_count(FIRST_HANDLE + 1), 1, "process handle not closed exactly once");
    assert_eq!(calls.close_count(FIRST_HANDLE + 2), 1, "thread handle not closed exactly once");
}

/// A healthy Job plus a healthy contained process over the same call table.
///
/// The lifecycle tests below are about what happens AFTER construction, so a
/// refusal here is a broken fixture rather than the thing under test.
fn healthy_pair(
    calls: &ScriptedCalls,
) -> (Job<'_, ScriptedCalls>, ContainedProcess<'_, ScriptedCalls>) {
    let job = Job::create(calls).expect("healthy Job construction must succeed");
    let storage = SpecStorage::new();
    let contained = ContainedProcess::create(calls, &job, &storage.spec())
        .expect("healthy construction must succeed");
    (job, contained)
}

#[test]
fn an_exit_query_with_no_prior_wait_is_unknown_and_never_a_number() {
    // THE STILL_ACTIVE TRAP. GetExitCodeProcess answers 259 for a process that
    // is still running AND for one that genuinely exited with 259, so the
    // number means nothing until a wait has reported the process signalled.
    // Reporting it anyway is unverifiable evidence gaining authority.
    let calls = ScriptedCalls::healthy();
    calls.reporting_exit_code(7);
    let (job, contained) = healthy_pair(&calls);

    let status = query_exit_status(&calls, &contained, None)
        .expect("an unknown exit is not a call failure");

    assert_eq!(status, ExitStatus::Unknown(UnknownExit::NotWaited));
    // Not merely "the answer was Unknown": the query must not have been MADE.
    // Calling it and then discarding the number would still be reading an
    // ambiguous value, and would leave the arm reachable without a wait.
    assert!(!calls.calls().contains(&"exit-code"), "queried an exit code with no prior wait");

    contained.close().expect("healthy close must succeed");
    job.close().expect("healthy close must succeed");
}

#[test]
fn an_exit_query_after_a_timed_out_wait_is_unknown() {
    let calls = ScriptedCalls::healthy();
    calls.reporting_wait(WaitOutcome::TimedOut);
    calls.reporting_exit_code(7);
    let (job, contained) = healthy_pair(&calls);

    let waited = wait_for_process(&calls, &contained, 500).expect("a timeout is an Ok value");
    assert!(matches!(waited, Waited::TimedOut), "WAIT_TIMEOUT must not be an error");

    let status = query_exit_status(&calls, &contained, Some(&waited))
        .expect("an unknown exit is not a call failure");

    assert_eq!(status, ExitStatus::Unknown(UnknownExit::StillRunning));
    assert!(!calls.calls().contains(&"exit-code"), "queried an exit code for a running process");

    contained.close().expect("healthy close must succeed");
    job.close().expect("healthy close must succeed");
}

#[test]
fn an_exit_query_after_an_abandoned_wait_is_unknown() {
    // WAIT_ABANDONED is neither "it exited" nor "it is still running". Folding
    // it into either neighbour would report an unknown state as a known one.
    let calls = ScriptedCalls::healthy();
    calls.reporting_wait(WaitOutcome::Abandoned);
    calls.reporting_exit_code(7);
    let (job, contained) = healthy_pair(&calls);

    let waited = wait_for_process(&calls, &contained, 500).expect("WAIT_ABANDONED is an Ok value");
    assert!(matches!(waited, Waited::Abandoned));

    let status = query_exit_status(&calls, &contained, Some(&waited))
        .expect("an unknown exit is not a call failure");

    assert_eq!(status, ExitStatus::Unknown(UnknownExit::WaitAbandoned));
    assert!(!calls.calls().contains(&"exit-code"), "queried an exit code after WAIT_ABANDONED");

    contained.close().expect("healthy close must succeed");
    job.close().expect("healthy close must succeed");
}

#[test]
fn an_exit_code_is_reported_only_after_a_wait_reported_signalled() {
    let calls = ScriptedCalls::healthy();
    calls.reporting_wait(WaitOutcome::Signalled);
    calls.reporting_exit_code(3);
    let (job, contained) = healthy_pair(&calls);

    let waited = wait_for_process(&calls, &contained, u32::MAX).expect("a healthy wait must succeed");
    assert!(matches!(waited, Waited::Signalled(_)));

    let status = query_exit_status(&calls, &contained, Some(&waited))
        .expect("a healthy exit query must succeed");

    match status {
        ExitStatus::Exited(code) => assert_eq!(code.value(), 3),
        other => panic!("a signalled wait must yield an exit code, got {other:?}"),
    }
    assert!(calls.calls().contains(&"exit-code"), "the exit code was fabricated, not queried");

    contained.close().expect("healthy close must succeed");
    job.close().expect("healthy close must succeed");
}

#[test]
fn an_exit_code_of_259_is_reported_as_exited_not_as_still_active() {
    // The lazy implementation is `if code == 259 { unknown }`, which blacklists
    // a legitimate exit code forever. The discipline is the PRIOR WAIT, never
    // the value: once the process is signalled, 259 means exited with 259.
    let calls = ScriptedCalls::healthy();
    calls.reporting_wait(WaitOutcome::Signalled);
    calls.reporting_exit_code(259);
    let (job, contained) = healthy_pair(&calls);

    let waited = wait_for_process(&calls, &contained, u32::MAX).expect("a healthy wait must succeed");
    let status = query_exit_status(&calls, &contained, Some(&waited))
        .expect("a healthy exit query must succeed");

    match status {
        ExitStatus::Exited(code) => assert_eq!(code.value(), 259, "STILL_ACTIVE was blacklisted"),
        other => panic!("259 after a signalled wait is an exit code, got {other:?}"),
    }

    contained.close().expect("healthy close must succeed");
    job.close().expect("healthy close must succeed");
}

#[test]
fn three_of_the_four_wait_results_are_ok_values() {
    // WaitForSingleObject returns a WAIT_EVENT, not a BOOL. A production
    // surface shaped as `!= WAIT_OBJECT_0 -> Err` passes an is_err() test and
    // makes the suspended-process acceptance test unwritable.
    let outcomes = [WaitOutcome::Signalled, WaitOutcome::TimedOut, WaitOutcome::Abandoned];
    assert_eq!(outcomes.len(), 3, "the wait-outcome sweep generated no cases");

    for outcome in outcomes {
        let calls = ScriptedCalls::healthy();
        calls.reporting_wait(outcome);
        let (job, contained) = healthy_pair(&calls);

        let waited = wait_for_process(&calls, &contained, 500)
            .unwrap_or_else(|error| panic!("{outcome:?} must be an Ok value, got {error:?}"));

        let matched = match (outcome, &waited) {
            (WaitOutcome::Signalled, Waited::Signalled(_)) => true,
            (WaitOutcome::TimedOut, Waited::TimedOut) => true,
            (WaitOutcome::Abandoned, Waited::Abandoned) => true,
            _ => false,
        };
        assert!(matched, "{outcome:?} was reported as the wrong observation");

        contained.close().expect("healthy close must succeed");
        job.close().expect("healthy close must succeed");
    }
}

#[test]
fn a_failed_wait_call_carries_the_operating_systems_error() {
    // WAIT_FAILED is the ONLY result that becomes an error, and it carries the
    // real GetLastError value rather than our code 0. Construction never waits,
    // so the same table can be programmed to fail this arm from the start.
    let calls = ScriptedCalls::failing(NativeOp::WaitForProcess, 6);
    let (job, contained) = healthy_pair(&calls);

    let error =
        wait_for_process(&calls, &contained, 500).err().expect("a failed wait CALL must refuse");

    assert_eq!(error.op(), NativeOp::WaitForProcess);
    assert_eq!(error.code(), 6, "a failed call must carry the OS error, not our refusal code");

    contained.close().expect("healthy close must succeed");
    job.close().expect("healthy close must succeed");
}

/// One entry per failable LIFECYCLE arm. Each carries the operation that must
/// drive it, so adding an arm to the vocabulary without a driver here is a
/// missing table entry rather than a silently unreached branch of a `match`.
struct LifecycleCase {
    op: NativeOp,
    /// A distinct Win32 error per arm, and distinct from every construction
    /// code above, so "right arm" cannot be confused with "right code by
    /// coincidence".
    code: u32,
    drive: fn(&ScriptedCalls, &ContainedProcess<'_, ScriptedCalls>) -> Option<NativeError>,
}

fn drive_wait(
    calls: &ScriptedCalls,
    contained: &ContainedProcess<'_, ScriptedCalls>,
) -> Option<NativeError> {
    wait_for_process(calls, contained, 500).err()
}

fn drive_exit_code(
    calls: &ScriptedCalls,
    contained: &ContainedProcess<'_, ScriptedCalls>,
) -> Option<NativeError> {
    // The wait arm is healthy in this case, so the query is reached with the
    // proof it requires and the failure observed is the exit query's own.
    let waited = wait_for_process(calls, contained, u32::MAX)
        .expect("the wait arm is healthy in the exit-code case");
    query_exit_status(calls, contained, Some(&waited)).err()
}

fn drive_terminate(
    calls: &ScriptedCalls,
    contained: &ContainedProcess<'_, ScriptedCalls>,
) -> Option<NativeError> {
    terminate_process(calls, contained).err()
}

fn drive_image_name(
    calls: &ScriptedCalls,
    contained: &ContainedProcess<'_, ScriptedCalls>,
) -> Option<NativeError> {
    query_identity(calls, contained).err()
}

const LIFECYCLE_CASES: [LifecycleCase; 4] = [
    // ERROR_SEM_TIMEOUT
    LifecycleCase { op: NativeOp::WaitForProcess, code: 121, drive: drive_wait },
    // ERROR_INVALID_DATA
    LifecycleCase { op: NativeOp::QueryExitCode, code: 13, drive: drive_exit_code },
    // ERROR_SHUTDOWN_IN_PROGRESS
    LifecycleCase { op: NativeOp::TerminateProcess, code: 1_115, drive: drive_terminate },
    // ERROR_GEN_FAILURE
    LifecycleCase { op: NativeOp::QueryImageName, code: 31, drive: drive_image_name },
];

#[test]
fn the_identity_query_reports_the_queried_image_and_the_retained_pid() {
    // PID and creation time are DELEGATED to what construction read from the
    // live handle; only the image is queried now. Asserting all three catches a
    // surface that re-queried identity later, which would answer about whatever
    // the handle refers to at that point rather than about the proved process.
    let calls = ScriptedCalls::healthy();
    let (job, contained) = healthy_pair(&calls);

    let identity = query_identity(&calls, &contained).expect("a healthy identity query succeeds");

    assert_eq!(identity.pid, SCRIPTED_PID);
    assert_eq!(identity.creation_time, SCRIPTED_CREATION_TIME);
    assert_eq!(identity.image, wide(SCRIPTED_IMAGE), "the image was fabricated, not queried");
    assert!(calls.calls().contains(&"image-name"));

    contained.close().expect("healthy close must succeed");
    job.close().expect("healthy close must succeed");
}

/// The construction prefix every unwind test starts from, up to and including
/// the membership proof.
const THROUGH_MEMBERSHIP: [&str; 9] = [
    "create",
    "set",
    "query",
    "init",
    "job-list",
    "handle-list",
    "create-process",
    "assign",
    "membership",
];

#[test]
fn a_pre_membership_fault_terminates_and_awaits_the_child_directly() {
    // REGIME ONE. Membership has NOT been proven, so the Job may not contain
    // this child. Terminating the Job could return Ok while the child keeps
    // running with nothing left to name it -- so the child's own handle is
    // terminated and awaited instead.
    let calls = ScriptedCalls::failing(NativeOp::AssignProcessToJob, 5);
    let error = drive(&calls);
    assert_eq!(error.op(), NativeOp::AssignProcessToJob);

    // THE WHOLE VECTOR, not a containment. A containment assertion passes with
    // the job-side cleanup ALSO present, which is exactly the collapse of the
    // two regimes this test exists to forbid.
    let mut expected = THROUGH_MEMBERSHIP[..8].to_vec();
    expected.extend(["terminate-process", "wait", "close", "close", "close"]);
    assert_eq!(calls.calls(), expected);
}

#[test]
fn a_post_membership_fault_terminates_the_job_and_waits_for_it_to_empty() {
    // REGIME TWO. The Job owns the child now, so terminating the JOB is correct
    // and sufficient -- and it also covers any grandchild the child may already
    // have spawned, which terminating one process handle would not.
    //
    // Two live processes are scripted, so the accounting query must be REPEATED
    // until it reaches zero. TerminateJobObject returns before its processes
    // are gone; a surface that sampled once would report an emptiness it never
    // observed, and would pass a test that only checked for one query.
    let calls = ScriptedCalls::failing(NativeOp::QueryProcessId, 1_008);
    calls.reporting_active_processes(2);
    let error = drive(&calls);
    assert_eq!(error.op(), NativeOp::QueryProcessId);

    let mut expected = THROUGH_MEMBERSHIP.to_vec();
    expected.extend(["pid", "terminate", "accounting", "accounting", "accounting"]);
    expected.extend(["close", "close", "close"]);
    assert_eq!(calls.calls(), expected);
}

#[test]
fn an_unwind_failure_never_replaces_the_error_that_caused_the_unwind() {
    // BOTH HALVES OF THE RULE, in one test.
    //
    // Half one: assignment fails, and the unwind's terminate fails too. The
    // caller must still see AssignProcessToJob -- an unwind failure that
    // overwrote it would hide why the run actually failed.
    let calls = ScriptedCalls::failing(NativeOp::AssignProcessToJob, 5);
    calls.fail_process_terminate_with(1_115);
    let error = drive(&calls);

    assert_eq!(error.op(), NativeOp::AssignProcessToJob, "the unwind overwrote the first error");
    assert_eq!(error.code(), 5);

    // Half two: the unwind's own failure is not swallowed either. Called
    // directly it surfaces as an error carrying its OWN NativeOp -- and the
    // wait still ran, because stopping at the first failure would leak it.
    let direct = ScriptedCalls::healthy();
    direct.fail_process_terminate_with(1_115);
    let unwind_error = unwind_before_membership(&direct, RawHandle::new(FIRST_HANDLE))
        .err()
        .expect("a failed terminate during unwind must not report success");

    assert_eq!(unwind_error.op(), NativeOp::TerminateProcess);
    assert_eq!(unwind_error.code(), 1_115);
    assert_eq!(direct.calls(), vec!["terminate-process", "wait"], "the wait was skipped");
}

#[test]
fn an_unwind_wait_that_does_not_observe_the_exit_stays_uncertain() {
    // The terminate succeeded but the wait timed out, so whether the process is
    // gone is UNKNOWN. That must not be laundered into success: it refuses as
    // WaitForProcess with code 0 -- our refusal, not the operating system's.
    for outcome in [WaitOutcome::TimedOut, WaitOutcome::Abandoned] {
        let calls = ScriptedCalls::healthy();
        calls.reporting_wait(outcome);

        let error = unwind_before_membership(&calls, RawHandle::new(FIRST_HANDLE))
            .err()
            .unwrap_or_else(|| panic!("{outcome:?} during unwind must not report success"));

        assert_eq!(error.op(), NativeOp::WaitForProcess);
        assert_eq!(error.code(), 0, "an unobserved exit is our refusal, not a Win32 failure");
    }
}

#[test]
fn a_failed_accounting_query_during_unwind_surfaces_its_own_op() {
    // The post-membership regime's second step has the same rule as the first:
    // a cleanup whose outcome cannot be read is an error carrying its own
    // NativeOp, never a silent success.
    let calls = ScriptedCalls::failing(NativeOp::QueryAccounting, 6);
    let job = Job::create(&calls).expect("healthy Job construction must succeed");

    let error = unwind_after_membership(&job)
        .err()
        .expect("an unreadable process count must not report an empty Job");

    assert_eq!(error.op(), NativeOp::QueryAccounting);
    assert_eq!(error.code(), 6, "a failed CALL carries the OS error, not our refusal code");
    assert_eq!(calls.calls(), vec!["create", "set", "query", "terminate", "accounting"]);
}

/// The production poll bound, hand-written here for the same reason
/// `JOB_OP_COUNT` is: an integration test cannot share a const with the crate,
/// and the duplication is what lets this file fail independently.
const EMPTY_POLL_ATTEMPTS: usize = 500;

#[test]
fn a_job_that_never_empties_is_uncertain_and_never_reported_as_empty() {
    // The count is scripted to stay nonzero for longer than the bound allows,
    // so the wait exhausts. An emptiness that was never observed must not be
    // reported: it refuses as QueryAccounting with code 0, our refusal rather
    // than the operating system's.
    //
    // This also PINS THE POLL: the exact number of accounting entries proves
    // the surface sampled repeatedly instead of reading the count once, which
    // is the defect TerminateJobObject's asynchrony invites.
    let calls = ScriptedCalls::healthy();
    calls.reporting_active_processes(u32::MAX);
    let job = Job::create(&calls).expect("healthy Job construction must succeed");

    let error = unwind_after_membership(&job)
        .err()
        .expect("a Job that never empties must not report success");

    assert_eq!(error.op(), NativeOp::QueryAccounting);
    assert_eq!(error.code(), 0, "an unobserved emptiness is our refusal, not a Win32 failure");

    let polls = calls.calls().iter().filter(|name| **name == "accounting").count();
    assert_eq!(polls, EMPTY_POLL_ATTEMPTS, "the process count was not polled to the bound");
}
