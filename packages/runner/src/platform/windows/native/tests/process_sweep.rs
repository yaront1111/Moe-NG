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
    ContainedProcess, CreatedProcess, Job, NativeError, NativeOp, ProcessCalls, ProcessSpec,
    RawHandle, Win32Calls, INHERITED_HANDLE_COUNT, REQUIRED_LIMIT_FLAGS,
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
        Ok(0)
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
const PROCESS_OPS: [NativeOp; 9] = [
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

    let owned: BTreeSet<NativeOp> = PROCESS_OPS.iter().copied().collect();
    assert_eq!(produced, owned, "sweep did not reach every construction NativeOp");
    assert_eq!(produced.len(), 9);
}

#[test]
fn the_two_sweeps_together_account_for_every_native_op() {
    // THE TOTALITY CHECK job_sweep.rs deliberately no longer owns. Every
    // variant must be reached by exactly one of the two sweeps, so a tenth
    // construction variant added without a case fails HERE rather than passing
    // unnoticed in both files.
    let all: BTreeSet<NativeOp> = NativeOp::ALL.iter().copied().collect();
    assert_eq!(all.len(), NativeOp::ALL.len(), "NativeOp::ALL lists a variant twice");

    for op in PROCESS_OPS {
        assert!(all.contains(&op), "{op:?} is no longer listed in NativeOp::ALL");
    }

    assert_eq!(
        PROCESS_OPS.len() + JOB_OP_COUNT,
        NativeOp::ALL.len(),
        "a NativeOp variant exists that neither sweep owns a case for"
    );
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
        let mut expected = HEALTHY_SEQUENCE[..9].to_vec();
        expected.extend(["close", "close", "close"]);
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
