//! Failure sweep over every Win32 arm, driven through the injected call table.
//!
//! Every assertion here checks the EXACT `NativeOp` and the EXACT numeric Win32
//! code. Asserting only that a call returned `Err` would stay green if the
//! production code started refusing at a different arm, which is the defect
//! epic rail 6 names.
//!
//! The scripted table below is a test double for the Win32 boundary ONLY. It
//! does not reimplement any Job semantics: the flag comparison, the refusal and
//! the close discipline all live in the production surface and are asserted
//! against it.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};

use moe_windows_job_core::{Job, NativeError, NativeOp, RawHandle, Win32Calls, REQUIRED_LIMIT_FLAGS};

/// `JOB_OBJECT_LIMIT_BREAKAWAY_OK`. Spelled as a literal rather than imported so
/// the mismatch case cannot drift in lockstep with the production constant.
const BREAKAWAY_OK: u32 = 0x0000_0800;

/// A Win32 handle value the scripted table hands out. Any nonzero value works;
/// it exists so close-counting can distinguish handles by identity.
const FIRST_HANDLE: isize = 0x1000;

/// Scripted Win32 boundary: records an ordered call log, counts closes per
/// handle, and can be programmed to fail at exactly one arm.
struct ScriptedCalls {
    fail_at: Option<NativeOp>,
    fail_code: u32,
    /// What `query_limit_flags` reports back. Defaults to the required value.
    reported_flags: Cell<u32>,
    log: RefCell<Vec<&'static str>>,
    closes: RefCell<BTreeMap<isize, usize>>,
    next_handle: Cell<isize>,
}

impl ScriptedCalls {
    fn healthy() -> Self {
        Self {
            fail_at: None,
            fail_code: 0,
            reported_flags: Cell::new(REQUIRED_LIMIT_FLAGS),
            log: RefCell::new(Vec::new()),
            closes: RefCell::new(BTreeMap::new()),
            next_handle: Cell::new(FIRST_HANDLE),
        }
    }

    fn failing(op: NativeOp, code: u32) -> Self {
        Self { fail_at: Some(op), fail_code: code, ..Self::healthy() }
    }

    fn reporting(flags: u32) -> Self {
        let calls = Self::healthy();
        calls.reported_flags.set(flags);
        calls
    }

    /// Records the call, then fails it if this arm is the programmed one.
    fn arm(&self, op: NativeOp, name: &'static str) -> Result<(), NativeError> {
        self.log.borrow_mut().push(name);
        if self.fail_at == Some(op) {
            return Err(NativeError::new(op, self.fail_code));
        }
        Ok(())
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
}

impl Win32Calls for ScriptedCalls {
    fn create_job_object(&self) -> Result<RawHandle, NativeError> {
        self.arm(NativeOp::CreateJobObject, "create")?;
        let value = self.next_handle.get();
        self.next_handle.set(value + 1);
        Ok(RawHandle::new(value))
    }

    fn set_limit_flags(&self, _job: RawHandle, _flags: u32) -> Result<(), NativeError> {
        self.arm(NativeOp::SetInformation, "set")
    }

    fn query_limit_flags(&self, _job: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryInformation, "query")?;
        Ok(self.reported_flags.get())
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
        self.arm(NativeOp::CloseHandle, "close")
    }
}

/// One entry per failable arm. Frozen, and its length is asserted, so deleting a
/// case cannot silently shrink the sweep.
struct Case {
    op: NativeOp,
    /// A distinct Win32 error per arm: a shared code could not distinguish
    /// "reported the right arm" from "reported the right code by coincidence".
    code: u32,
}

/// The six job-side operations this sweep owns, written by hand and kept
/// INDEPENDENT of `CASES`. Comparing the sweep against its own input would prove
/// nothing; comparing it against a separately written list is what makes a dead
/// arm fail here.
///
/// THIS IS EXACT EQUALITY, NEVER A SUBSET OR CONTAINMENT TEST. `NativeOp` also
/// carries nine construction-side variants owned by tests/process_sweep.rs.
/// Softening this to "produced is contained in `NativeOp::ALL`" would let the
/// sweep pass with a job arm entirely unreached — which is precisely the
/// weakening this repair exists to avoid. process_sweep owns the totality check
/// that every variant is reached by exactly one of the two sweeps.
const JOB_OPS: [NativeOp; 6] = [
    NativeOp::CreateJobObject,
    NativeOp::SetInformation,
    NativeOp::QueryInformation,
    NativeOp::TerminateJob,
    NativeOp::QueryAccounting,
    NativeOp::CloseHandle,
];

const CASES: [Case; 6] = [
    Case { op: NativeOp::CreateJobObject, code: 5 },      // ERROR_ACCESS_DENIED
    Case { op: NativeOp::SetInformation, code: 87 },      // ERROR_INVALID_PARAMETER
    Case { op: NativeOp::QueryInformation, code: 24 },    // ERROR_BAD_LENGTH
    Case { op: NativeOp::TerminateJob, code: 1_314 },     // ERROR_PRIVILEGE_NOT_HELD
    Case { op: NativeOp::QueryAccounting, code: 6 },      // ERROR_INVALID_HANDLE
    Case { op: NativeOp::CloseHandle, code: 998 },        // ERROR_NOACCESS
];

/// Drives one case to the point where its arm fires and returns the error.
/// Create/set/query fail during construction; the rest need a live Job first.
fn drive(case: &Case, calls: &ScriptedCalls) -> NativeError {
    match case.op {
        NativeOp::CreateJobObject | NativeOp::SetInformation | NativeOp::QueryInformation => {
            Job::create(calls).err().expect("construction must refuse at the programmed arm")
        }
        NativeOp::TerminateJob => {
            let job = Job::create(calls).expect("construction must succeed");
            job.terminate().err().expect("terminate must refuse")
        }
        NativeOp::QueryAccounting => {
            let job = Job::create(calls).expect("construction must succeed");
            job.active_processes().err().expect("accounting must refuse")
        }
        NativeOp::CloseHandle => {
            let job = Job::create(calls).expect("construction must succeed");
            job.close().err().expect("close must refuse")
        }
        // The construction-side ops belong to tests/process_sweep.rs and can
        // never appear in CASES. Listed EXPLICITLY rather than caught by `_`:
        // a wildcard would let a future job-side variant land in a silent
        // fallthrough, whereas this arm keeps "add a variant, break this match"
        // as a compile error — the same forcing function NativeOp exists for.
        NativeOp::InitAttributeList
        | NativeOp::SetJobListAttribute
        | NativeOp::SetHandleListAttribute
        | NativeOp::CreateProcess
        | NativeOp::AssignProcessToJob
        | NativeOp::IsProcessInJob
        | NativeOp::QueryProcessId
        | NativeOp::QueryCreationTime
        | NativeOp::ResumeThread => {
            panic!("{:?} is a construction op; tests/process_sweep.rs owns it", case.op)
        }
    }
}

#[test]
fn sweep_pins_the_exact_op_and_code_for_every_arm() {
    // Guard the case list itself: a sweep that generates zero cases passes.
    assert_eq!(CASES.len(), 6, "every failable arm needs exactly one case");

    let mut produced = BTreeSet::new();
    for case in &CASES {
        let calls = ScriptedCalls::failing(case.op, case.code);
        let error = drive(case, &calls);

        assert_eq!(error.op(), case.op, "wrong arm reported for {:?}", case.op);
        assert_eq!(error.code(), case.code, "wrong Win32 code for {:?}", case.op);
        produced.insert(error.op());
    }

    // Cross-check the produced set against the hand-written JOB_OPS, not
    // against CASES: comparing the sweep to its own input would prove nothing.
    let owned: BTreeSet<NativeOp> = JOB_OPS.iter().copied().collect();
    assert_eq!(produced, owned, "sweep did not reach every job-side NativeOp");
    assert_eq!(produced.len(), 6);

    // ...and every op this sweep owns is still listed in the production enum's
    // coverage array. Naming a deleted VARIANT would already fail to compile;
    // this catches the case a compile error cannot see — a variant that still
    // exists but was dropped from `NativeOp::ALL`, which would silently shrink
    // what the totality check in process_sweep is able to demand.
    let all: BTreeSet<NativeOp> = NativeOp::ALL.iter().copied().collect();
    for op in JOB_OPS {
        assert!(all.contains(&op), "{op:?} is no longer listed in NativeOp::ALL");
    }
}

#[test]
fn required_flags_are_kill_on_close_alone() {
    // Pins the constant itself: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and nothing
    // else. A value carrying a breakaway bit would defeat the whole primitive.
    assert_eq!(REQUIRED_LIMIT_FLAGS, 0x0000_2000);
    assert_eq!(REQUIRED_LIMIT_FLAGS & BREAKAWAY_OK, 0);
}

#[test]
fn successful_creation_calls_create_set_query_in_order() {
    let calls = ScriptedCalls::healthy();
    let job = Job::create(&calls).expect("healthy construction must succeed");

    assert_eq!(calls.calls(), vec!["create", "set", "query"]);
    drop(job);
}

#[test]
fn query_back_refuses_flags_that_also_carry_breakaway() {
    // Exact equality, not a bitwise-contains: a contains test would accept this
    // Job, and a child could then break away from it.
    let calls = ScriptedCalls::reporting(REQUIRED_LIMIT_FLAGS | BREAKAWAY_OK);
    let error = Job::create(&calls).err().expect("mismatched flags must refuse");

    assert_eq!(error.op(), NativeOp::QueryInformation);
    assert_eq!(error.code(), 0, "a mismatch is a refusal, not a Win32 failure");
    assert_eq!(calls.close_count(FIRST_HANDLE), 1, "refusal must still close the Job");
}

#[test]
fn first_failure_survives_the_cleanup_close() {
    // Set fails, so the handle must be closed on the way out -- but the error
    // the caller sees stays SetInformation. A cleanup close that overwrote it
    // would hide why the run actually failed.
    let calls = ScriptedCalls::failing(NativeOp::SetInformation, 87);
    let error = Job::create(&calls).err().expect("set failure must refuse");

    assert_eq!(error.op(), NativeOp::SetInformation);
    assert_eq!(error.code(), 87);
    assert_eq!(calls.calls(), vec!["create", "set", "close"]);
}

#[test]
fn every_acquired_handle_closes_exactly_once_on_every_path() {
    // Success path: the explicit close is the only close, and Drop must not
    // repeat it.
    let calls = ScriptedCalls::healthy();
    let job = Job::create(&calls).expect("healthy construction must succeed");
    job.close().expect("healthy close must succeed");
    assert_eq!(calls.close_count(FIRST_HANDLE), 1, "success path closed twice or not at all");

    // Dropped-without-close path: Drop is the leak guard and closes once.
    let dropped = ScriptedCalls::healthy();
    drop(Job::create(&dropped).expect("healthy construction must succeed"));
    assert_eq!(dropped.close_count(FIRST_HANDLE), 1, "drop guard closed twice or not at all");

    // Every failure path: no handle is leaked and none is closed twice.
    for case in &CASES {
        let calls = ScriptedCalls::failing(case.op, case.code);
        let _ = drive(case, &calls);
        for index in 0..calls.handles_opened() {
            let handle = FIRST_HANDLE + index as isize;
            assert_eq!(
                calls.close_count(handle),
                1,
                "handle {handle:#x} not closed exactly once after {:?} failed",
                case.op
            );
        }
    }
}

#[test]
fn a_failed_close_is_never_laundered_into_success() {
    // Close fails. The outcome is UNKNOWN, so it must surface as an error --
    // and it must not be retried by Drop, which would close twice.
    let calls = ScriptedCalls::failing(NativeOp::CloseHandle, 998);
    let job = Job::create(&calls).expect("healthy construction must succeed");
    let error = job.close().err().expect("a failed close must not report success");

    assert_eq!(error.op(), NativeOp::CloseHandle);
    assert_eq!(error.code(), 998);
    assert_eq!(calls.close_count(FIRST_HANDLE), 1, "failed close was retried by Drop");
}
