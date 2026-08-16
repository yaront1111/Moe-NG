//! The session: Job ownership, core delegation, STARTED after proof, and
//! natural COMPLETED.
//!
//! # Why every STARTED assertion is about the STREAM, never the return value
//!
//! DoD 1 says "absence from the recorded output, not merely that an error was
//! returned", and that distinction is the whole point. A test shaped as
//! `assert!(outcome.is_err())` passes even when the production code wrote a
//! STARTED frame to fd1 and THEN failed — the parent would already have been
//! told a process it can address exists. So every arm below reads the recorded
//! fd1 bytes back through [`frames_on`] and asserts no frame carrying
//! `Outbound::Started` appears in it.
//!
//! [`frames_on`] parses the stream rather than searching it for a byte. A
//! payload byte can equal an opcode by coincidence, so a `contains(&opcode)`
//! search would be both false-positive prone and, worse, would pass a test whose
//! subject had moved.
//!
//! # The scripted table reimplements no production logic
//!
//! It is a double for the Win32 boundary and for a pipe, and nothing else. The
//! five proof arms, the four completion preconditions and the termination
//! ordering all live in the production surface and are asserted against it —
//! never against a helper here that restates them.
//!
//! Failure shapes are kept DISTINCT on purpose, following the core's
//! tests/process_sweep.rs: `failing(op, code)` is the CALL failing, while
//! `reporting_membership(false)` / `reporting_suspend_count(7)` /
//! `reporting_limit_flags(x)` are the call SUCCEEDING while the fact it reports
//! is not the one required. Collapsing those two would let a refusal migrate
//! between them with the suite still green.

use core::task::Poll;
use std::cell::{Cell, RefCell};

use moe_windows_job_broker::{
    ByteChannel, Completed, Completion, DiagnosticNote, Inbound, Outbound, Outcome, Precondition,
    ProtocolReason, ProtocolStage, RefusalLayer, Session, ShutdownSignal, Stopped, Unobserved,
    Wiring, FRAME_HEADER_BYTES, PROTOCOL_VERSION, REFUSED_PAYLOAD_BYTES,
};
use moe_windows_job_core::{
    CreatedProcess, NativeError, NativeOp, ProcessCalls, ProcessSpec, RawHandle, UnknownExit,
    WaitOutcome, Win32Calls, INHERITED_HANDLE_COUNT, REQUIRED_LIMIT_FLAGS,
};

/// The first handle value the scripted table hands out. Any nonzero value works.
const FIRST_HANDLE: isize = 0x1000;

/// fd3, fd4 and fd5 — the provider trio the child inherits as its own standard
/// input, output and error. Deliberately far from [`FIRST_HANDLE`] so a close
/// landing on one is unmistakable.
const PROVIDERS: [RawHandle; INHERITED_HANDLE_COUNT] =
    [RawHandle::new(0x33), RawHandle::new(0x34), RawHandle::new(0x35)];

/// What the double reports for the identity arms. Asserted, so a session that
/// fabricated an identity rather than consuming the core's would fail.
const SCRIPTED_PID: u32 = 7_321;
const SCRIPTED_CREATION_TIME: u64 = 0x01DB_0000_0000_002A;

/// The exit code the double reports once a wait has been observed signalled.
const SCRIPTED_EXIT_CODE: u32 = 3;

/// An instructed timeout long enough that the session takes a control
/// instruction between wait slices rather than expiring first.
const PATIENT_TIMEOUT_MS: u32 = 60_000;

/// An instructed timeout the first wait slice exhausts, so a wait that reports
/// TimedOut ends the run on the timeout path.
const IMPATIENT_TIMEOUT_MS: u32 = 1;

/// Every field of the launch request that must NEVER reach an outbound channel.
///
/// These are the exact strings [`a_launch_frame`] sends, so the no-echo test
/// searches for what was actually supplied rather than for a plausible-looking
/// path that nothing put in.
const LAUNCH_EXECUTABLE: &str = "C:\\Windows\\System32\\PING.EXE";
const LAUNCH_ARGUMENT: &str = "--secret-argument";
const LAUNCH_CWD: &str = "C:\\Windows\\Temp\\secret-cwd";
const LAUNCH_ENV_KEY: &str = "SECRET_KEY";
const LAUNCH_ENV_VALUE: &str = "secret-value";
const LAUNCH_SECRETS: [&str; 5] =
    [LAUNCH_EXECUTABLE, LAUNCH_ARGUMENT, LAUNCH_CWD, LAUNCH_ENV_KEY, LAUNCH_ENV_VALUE];

/// Scripted Win32 + process boundary: records an ordered call log and can be
/// programmed to fail at exactly one arm, or to succeed while reporting a fact
/// that is not the required one.
struct ScriptedCalls {
    fail_at: Option<NativeOp>,
    fail_code: u32,
    /// What `query_limit_flags` reports when the CALL succeeds.
    limit_flags: Cell<u32>,
    /// What `is_process_in_job` reports when the CALL succeeds.
    in_job: Cell<bool>,
    /// What `resume_thread` reports as the PRIOR suspend count.
    prior_suspend_count: Cell<u32>,
    /// Successive `wait_for_process` outcomes. The LAST entry repeats, so a
    /// session that waits more often than the test scripted does not silently
    /// run off the end of the queue.
    waits: RefCell<Vec<WaitOutcome>>,
    wait_timeouts: RefCell<Vec<u32>>,
    exit_code: Cell<u32>,
    /// How many more processes `query_active_processes` reports before reaching
    /// zero, decremented per call.
    active_remaining: Cell<u32>,
    log: RefCell<Vec<&'static str>>,
    next_handle: Cell<isize>,
    deletes: Cell<usize>,
}

impl ScriptedCalls {
    fn healthy() -> Self {
        Self {
            fail_at: None,
            fail_code: 0,
            limit_flags: Cell::new(REQUIRED_LIMIT_FLAGS),
            in_job: Cell::new(true),
            prior_suspend_count: Cell::new(1),
            waits: RefCell::new(vec![WaitOutcome::Signalled]),
            wait_timeouts: RefCell::new(Vec::new()),
            exit_code: Cell::new(SCRIPTED_EXIT_CODE),
            active_remaining: Cell::new(0),
            log: RefCell::new(Vec::new()),
            next_handle: Cell::new(FIRST_HANDLE),
            deletes: Cell::new(0),
        }
    }

    fn failing(op: NativeOp, code: u32) -> Self {
        Self { fail_at: Some(op), fail_code: code, ..Self::healthy() }
    }

    /// The query SUCCEEDS and reports these flags. Distinct from
    /// `failing(QueryInformation, _)`, which is the call itself failing.
    fn reporting_limit_flags(flags: u32) -> Self {
        let calls = Self::healthy();
        calls.limit_flags.set(flags);
        calls
    }

    /// The call SUCCEEDS and reports this membership answer.
    fn reporting_membership(answer: bool) -> Self {
        let calls = Self::healthy();
        calls.in_job.set(answer);
        calls
    }

    /// The call SUCCEEDS and reports this PRIOR suspend count.
    fn reporting_suspend_count(count: u32) -> Self {
        let calls = Self::healthy();
        calls.prior_suspend_count.set(count);
        calls
    }

    /// Successive wait outcomes; the last repeats forever.
    fn waiting(&self, outcomes: &[WaitOutcome]) {
        *self.waits.borrow_mut() = outcomes.to_vec();
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

    /// How many times `name` appears in the ordered call log. This is what makes
    /// "exactly once" assertable; "did it terminate" cannot see a double.
    fn count(&self, name: &str) -> usize {
        self.log.borrow().iter().filter(|entry| **entry == name).count()
    }

    fn observed_wait_timeouts(&self) -> Vec<u32> {
        self.wait_timeouts.borrow().clone()
    }
}

impl Win32Calls for ScriptedCalls {
    fn create_job_object(&self) -> Result<RawHandle, NativeError> {
        self.arm(NativeOp::CreateJobObject, "create-job")?;
        Ok(self.hand_out())
    }

    fn set_limit_flags(&self, _job: RawHandle, _flags: u32) -> Result<(), NativeError> {
        self.arm(NativeOp::SetInformation, "set-flags")
    }

    fn query_limit_flags(&self, _job: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryInformation, "query-flags")?;
        Ok(self.limit_flags.get())
    }

    fn terminate_job(&self, _job: RawHandle) -> Result<(), NativeError> {
        self.arm(NativeOp::TerminateJob, "terminate-job")
    }

    fn query_active_processes(&self, _job: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryAccounting, "accounting")?;
        let remaining = self.active_remaining.get();
        self.active_remaining.set(remaining.saturating_sub(1));
        Ok(remaining)
    }

    fn close_handle(&self, _handle: RawHandle) -> Result<(), NativeError> {
        self.arm(NativeOp::CloseHandle, "close")
    }
}

impl ProcessCalls for ScriptedCalls {
    /// The double owns no buffer, which is the whole reason the trait carries an
    /// associated type rather than a concrete one.
    type AttributeList = ();

    fn init_attribute_list(&self, _attributes: u32) -> Result<(), NativeError> {
        self.arm(NativeOp::InitAttributeList, "init-list")
    }

    fn set_job_list_attribute(&self, _list: &mut (), _job: RawHandle) -> Result<(), NativeError> {
        self.arm(NativeOp::SetJobListAttribute, "job-list")
    }

    fn set_handle_list_attribute(
        &self,
        _list: &mut (),
        handles: [RawHandle; INHERITED_HANDLE_COUNT],
    ) -> Result<(), NativeError> {
        // `assert!` rather than `assert_eq!`: RawHandle has no Debug, by rail, so
        // the equality macro cannot format it. That is the guard working — a raw
        // handle value must not be printable even from a test failure.
        //
        // THE ALLOWLIST IS THE PROVIDER TRIO AND NOTHING ELSE. A session that
        // duplicated fd0, fd1 or fd2 into the child would hand it the control and
        // status channels, which is the one inheritance mistake that matters.
        assert!(handles == PROVIDERS, "the child inherits exactly fd3, fd4 and fd5");
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
        timeout_ms: u32,
    ) -> Result<WaitOutcome, NativeError> {
        self.arm(NativeOp::WaitForProcess, "wait")?;
        self.wait_timeouts.borrow_mut().push(timeout_ms);
        let mut waits = self.waits.borrow_mut();
        // The last entry repeats rather than being consumed: a queue that ran dry
        // would panic and report a harness fault as a production defect.
        if waits.len() > 1 {
            Ok(waits.remove(0))
        } else {
            Ok(*waits.first().unwrap_or(&WaitOutcome::Signalled))
        }
    }

    fn exit_code(&self, _process: RawHandle) -> Result<u32, NativeError> {
        self.arm(NativeOp::QueryExitCode, "exit-code")?;
        Ok(self.exit_code.get())
    }

    fn terminate_process(&self, _process: RawHandle) -> Result<(), NativeError> {
        self.arm(NativeOp::TerminateProcess, "terminate-process")
    }

    fn image_name(&self, _process: RawHandle) -> Result<Vec<u16>, NativeError> {
        self.arm(NativeOp::QueryImageName, "image-name")?;
        Ok("C:\\Windows\\System32\\PING.EXE".encode_utf16().chain([0]).collect())
    }

    /// COUNTED, NOT LOGGED, and infallible — windows-sys gives
    /// `DeleteProcThreadAttributeList` no return value, so there is nothing to
    /// script. Keeping it out of the ordered log is what lets the proof-order
    /// assertion state the twelve arms that can fail without an unfailable
    /// cleanup step sitting in the middle of them.
    fn delete_attribute_list(&self, _list: ()) {
        self.deletes.set(self.deletes.get() + 1);
    }
}

#[derive(Clone, Copy)]
enum PollStep {
    Pending,
    Bytes(usize),
    End,
    Error(u32),
}

/// A scripted pipe: hands out a prepared byte script, records everything
/// written, and can be told to end or to fail.
struct Pipe {
    inbound: Vec<u8>,
    read_at: usize,
    read_error: Option<u32>,
    write_error: Option<u32>,
    written: Vec<u8>,
    poll_steps: Vec<PollStep>,
    poll_at: usize,
    poll_calls: usize,
    polled_bytes: usize,
}

impl Pipe {
    /// A channel that is already at end of stream. This is what fd4 and fd5 look
    /// like once the child has exited and closed its ends.
    fn ended() -> Self {
        Self::of(&[])
    }

    fn of(inbound: &[u8]) -> Self {
        Self {
            inbound: inbound.to_vec(),
            read_at: 0,
            read_error: None,
            write_error: None,
            written: Vec::new(),
            poll_steps: Vec::new(),
            poll_at: 0,
            poll_calls: 0,
            polled_bytes: 0,
        }
    }

    fn with_poll_steps(mut self, steps: &[PollStep]) -> Self {
        self.poll_steps = steps.to_vec();
        self
    }

    /// A provider channel that never reaches EOF: every read yields a byte, so
    /// "drained to EOF" is false however long the session reads.
    fn never_ending() -> Self {
        Self { inbound: vec![0u8; 1], read_at: usize::MAX, ..Self::of(&[]) }
    }

    fn failing_reads_with(mut self, code: u32) -> Self {
        self.read_error = Some(code);
        self
    }
}

impl ByteChannel for Pipe {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, u32> {
        if let Some(code) = self.read_error {
            return Err(code);
        }
        // `read_at == usize::MAX` marks the never-ending provider: it always has
        // one more byte, so EOF is unreachable without the session inventing it.
        if self.read_at == usize::MAX {
            let take = buffer.len().min(1);
            buffer[..take].fill(0);
            return Ok(take);
        }
        let take = (self.inbound.len() - self.read_at).min(buffer.len());
        buffer[..take].copy_from_slice(&self.inbound[self.read_at..self.read_at + take]);
        self.read_at += take;
        Ok(take)
    }

    /// Answers the scripted readiness step, or — with no script — exactly what
    /// `read` would have answered.
    ///
    /// THE UNSCRIPTED FALLBACK IS NOT A CONVENIENCE. Every case written before
    /// this channel could be Pending assumed fd0 answers immediately, so the
    /// default has to keep answering immediately; a default of Pending would
    /// quietly retire those cases into timeouts that still pass.
    ///
    /// A script that runs dry PANICS BY NAME rather than falling back, because
    /// falling back would consume bytes the case never offered and report a
    /// harness fault as production behaviour.
    fn poll_read(&mut self, buffer: &mut [u8]) -> Result<Poll<usize>, u32> {
        self.poll_calls += 1;
        if self.poll_steps.is_empty() {
            let taken = self.read(buffer)?;
            self.polled_bytes += taken;
            return Ok(Poll::Ready(taken));
        }

        let Some(step) = self.poll_steps.get(self.poll_at).copied() else {
            panic!("the poll script ran dry after {} steps", self.poll_at);
        };
        self.poll_at += 1;
        match step {
            PollStep::Pending => Ok(Poll::Pending),
            PollStep::End => Ok(Poll::Ready(0)),
            PollStep::Error(code) => Err(code),
            PollStep::Bytes(count) => {
                let take = count
                    .min(buffer.len())
                    .min(self.inbound.len() - self.read_at);
                buffer[..take].copy_from_slice(&self.inbound[self.read_at..self.read_at + take]);
                self.read_at += take;
                self.polled_bytes += take;
                Ok(Poll::Ready(take))
            }
        }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<usize, u32> {
        if let Some(code) = self.write_error {
            return Err(code);
        }
        self.written.extend_from_slice(bytes);
        Ok(bytes.len())
    }
}

/// A frame header, built by hand so the tests state the wire layout rather than
/// asking the encoder what it happens to emit.
fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![PROTOCOL_VERSION, opcode];
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

/// A `u16`-length-prefixed string, hand-built for the same reason.
fn text(value: &str) -> Vec<u8> {
    let mut bytes = (value.len() as u16).to_le_bytes().to_vec();
    bytes.extend_from_slice(value.as_bytes());
    bytes
}

fn launch_payload(exe: &str, argv: &[&str], cwd: &str, env: &[(&str, &str)]) -> Vec<u8> {
    let mut bytes = text(exe);
    bytes.extend_from_slice(&(argv.len() as u16).to_le_bytes());
    for arg in argv {
        bytes.extend_from_slice(&text(arg));
    }
    bytes.extend_from_slice(&text(cwd));
    bytes.extend_from_slice(&(env.len() as u16).to_le_bytes());
    for (key, value) in env {
        bytes.extend_from_slice(&text(key));
        bytes.extend_from_slice(&text(value));
    }
    bytes
}

/// The one launch every test drives, unless it is testing the launch itself.
///
/// Every field carries a distinctive marker string so the no-echo test can
/// search the outbound channels for exactly what was supplied.
fn a_launch_frame() -> Vec<u8> {
    frame(
        Inbound::Launch.opcode(),
        &launch_payload(
            LAUNCH_EXECUTABLE,
            &[LAUNCH_ARGUMENT],
            LAUNCH_CWD,
            &[(LAUNCH_ENV_KEY, LAUNCH_ENV_VALUE)],
        ),
    )
}

fn a_cancel_frame() -> Vec<u8> {
    frame(Inbound::Cancel.opcode(), &[])
}

/// Parses a recorded outbound stream back into frames.
///
/// PARSED, NEVER SEARCHED. A payload byte can equal an opcode by coincidence, so
/// scanning the raw bytes for `Outbound::Started.opcode()` would be capable of
/// both a false positive and — far worse — of passing once the thing it was
/// written about had moved. Walking the length-prefixed frames is the only form
/// that answers "did a STARTED frame appear on this channel".
fn frames_on(stream: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let mut frames = Vec::new();
    let mut at = 0;
    while at + FRAME_HEADER_BYTES <= stream.len() {
        let declared = u32::from_le_bytes([
            stream[at + 2],
            stream[at + 3],
            stream[at + 4],
            stream[at + 5],
        ]) as usize;
        let start = at + FRAME_HEADER_BYTES;
        let Some(payload) = stream.get(start..start + declared) else {
            break;
        };
        frames.push((stream[at + 1], payload.to_vec()));
        at = start + declared;
    }
    frames
}

/// How many frames carrying `kind` appear on the stream.
fn count_of(stream: &[u8], kind: Outbound) -> usize {
    frames_on(stream).iter().filter(|(opcode, _)| *opcode == kind.opcode()).count()
}

fn only_protocol_refusal(stream: &[u8]) -> (u8, u16, u32) {
    let frames: Vec<_> = frames_on(stream)
        .into_iter()
        .filter(|(opcode, _)| *opcode == Outbound::Refused.opcode())
        .collect();
    assert_eq!(
        frames.len(),
        1,
        "the scenario must emit exactly one refusal"
    );
    let payload = &frames[0].1;
    assert_eq!(payload.len(), REFUSED_PAYLOAD_BYTES);
    (
        payload[0],
        u16::from_le_bytes([payload[1], payload[2]]),
        u32::from_le_bytes([payload[3], payload[4], payload[5], payload[6]]),
    )
}

fn assert_channel_ended_diagnostic(stream: &[u8]) {
    let ended: Vec<_> = frames_on(stream)
        .into_iter()
        .filter(|(_, payload)| payload.first() == Some(&DiagnosticNote::ChannelEnded.wire()))
        .collect();
    assert_eq!(
        ended.len(),
        1,
        "control EOF must emit exactly one ChannelEnded note"
    );
    assert_eq!(
        ended[0].1,
        vec![DiagnosticNote::ChannelEnded.wire(), 0, 0, 0, 0]
    );
}

/// The wiring one run needs: a control script, and provider channels that have
/// already reached EOF unless a test says otherwise.
fn wiring(control: Vec<u8>) -> Wiring<Pipe> {
    wiring_with_control(Pipe::of(&control))
}

fn wiring_with_control(control: Pipe) -> Wiring<Pipe> {
    Wiring {
        control,
        status: Pipe::of(&[]),
        diagnostics: Pipe::of(&[]),
        provider_out: Pipe::ended(),
        provider_err: Pipe::ended(),
    }
}

/// Never asks the session to stop. The helper-shutdown path supplies its own.
struct RunToCompletion;

impl ShutdownSignal for RunToCompletion {
    fn requested(&self) -> bool {
        false
    }
}

/// Drives one session over a launch frame and hands back what fd1 recorded.
fn run_launch(calls: &ScriptedCalls) -> (Outcome, Wiring<Pipe>) {
    run_with(calls, wiring(a_launch_frame()), PATIENT_TIMEOUT_MS)
}

/// Drives one session over supplied wiring and an instructed timeout.
fn run_with(
    calls: &ScriptedCalls,
    mut wired: Wiring<Pipe>,
    timeout_ms: u32,
) -> (Outcome, Wiring<Pipe>) {
    let outcome = Session::new(calls, PROVIDERS, timeout_ms).run(&mut wired, &RunToCompletion);
    (outcome, wired)
}

/// The completion a run settled on, or a panic naming what it did instead.
fn completion(outcome: &Outcome) -> Completion {
    match outcome {
        Outcome::Ran(_, settled) => *settled,
        // Spelled out rather than `_`, so a new outcome forces a decision here
        // instead of silently reporting "no child" for something else entirely.
        Outcome::NotLaunched(_) => panic!("this scenario must reach a launched child"),
        Outcome::NoInstruction => panic!("this scenario must send a launch"),
    }
}

// ---------------------------------------------------------------------------
// DoD 1 — STARTED is earned. Five proof arms, five tests, each asserting
// ABSENCE FROM THE fd1 STREAM rather than that an error was returned.
// ---------------------------------------------------------------------------

#[test]
fn started_is_absent_when_the_exact_job_limit_flags_are_not_proved() {
    // The query SUCCEEDS and reports flags that also carry BREAKAWAY_OK — the
    // exact configuration that lets a child leave the Job. The core compares by
    // equality, never bitwise-contains, so this must refuse.
    let calls = ScriptedCalls::reporting_limit_flags(REQUIRED_LIMIT_FLAGS | 0x0800);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Started), 0);
    assert!(matches!(outcome, Outcome::NotLaunched(_)));
    assert_eq!(calls.count("create-process"), 0, "no child may exist on an unproved Job");
}

#[test]
fn started_is_absent_when_explicit_assignment_is_not_proved() {
    let calls = ScriptedCalls::failing(NativeOp::AssignProcessToJob, 5);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Started), 0);
    assert!(matches!(outcome, Outcome::NotLaunched(_)));
}

#[test]
fn started_is_absent_when_membership_is_not_proved() {
    // The CALL succeeds and answers "not in the job". Distinct from the call
    // failing, and the arm a session could most plausibly skip.
    let calls = ScriptedCalls::reporting_membership(false);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Started), 0);
    assert!(matches!(outcome, Outcome::NotLaunched(_)));
    assert_eq!(calls.count("resume"), 0, "an unproved child must never be resumed");
}

#[test]
fn started_is_absent_when_retained_handle_identity_is_not_proved() {
    let calls = ScriptedCalls::failing(NativeOp::QueryProcessId, 6);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Started), 0);
    assert!(matches!(outcome, Outcome::NotLaunched(_)));
}

#[test]
fn started_is_absent_when_the_single_successful_resume_is_not_proved() {
    // The CALL succeeds and reports a prior suspend count of 7: something else
    // suspended this thread, so its state is not the one the core reasoned about.
    let calls = ScriptedCalls::reporting_suspend_count(7);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Started), 0);
    assert!(matches!(outcome, Outcome::NotLaunched(_)));
}

#[test]
fn started_reaches_fd1_exactly_once_when_every_arm_is_proved() {
    let calls = ScriptedCalls::healthy();
    let (outcome, wired) = run_launch(&calls);

    // ONCE, not merely present. A duplicate STARTED is its own defect and is
    // invisible to a presence assertion.
    assert_eq!(count_of(&wired.status.written, Outbound::Started), 1);
    assert!(matches!(outcome, Outcome::Ran(Stopped::Natural, _)));
}

#[test]
fn the_started_frame_carries_the_cores_identity_pair_and_not_the_image() {
    let calls = ScriptedCalls::healthy();
    let (_, wired) = run_launch(&calls);

    let frames = frames_on(&wired.status.written);
    let (_, payload) = frames
        .iter()
        .find(|(opcode, _)| *opcode == Outbound::Started.opcode())
        .expect("a proved launch emits STARTED");

    // pid then creation time, little-endian, and NOTHING else — the image path
    // the core queries must never reach the wire.
    let mut expected = SCRIPTED_PID.to_le_bytes().to_vec();
    expected.extend_from_slice(&SCRIPTED_CREATION_TIME.to_le_bytes());
    assert_eq!(payload, &expected);
}

#[test]
fn the_proof_arms_run_in_the_order_the_core_pins_before_started_is_written() {
    let calls = ScriptedCalls::healthy();
    let (_, wired) = run_launch(&calls);

    // ONE assert over the whole prefix, deliberately. An assertion shaped
    // "resume comes after membership" passes with an entire step missing —
    // including the membership proof itself.
    let observed = calls.calls();
    assert_eq!(
        &observed[..12],
        &[
            "create-job",
            "set-flags",
            "query-flags",
            "init-list",
            "job-list",
            "handle-list",
            "create-process",
            "assign",
            "membership",
            "pid",
            "creation-time",
            "resume",
        ]
    );
    assert_eq!(count_of(&wired.status.written, Outbound::Started), 1);
}

#[test]
fn a_refused_launch_emits_a_refusal_carrying_only_layer_reason_and_code() {
    let calls = ScriptedCalls::failing(NativeOp::CreateJobObject, 87);
    let (_, wired) = run_launch(&calls);

    let frames = frames_on(&wired.status.written);
    let refusals: Vec<_> =
        frames.iter().filter(|(opcode, _)| *opcode == Outbound::Refused.opcode()).collect();
    assert_eq!(refusals.len(), 1);

    // The length alone is a structural guard: 1 + 2 + 4 leaves no room for an
    // executable, an argv entry, a cwd, an environment value or a handle.
    let (_, payload) = refusals[0];
    assert_eq!(payload.len(), REFUSED_PAYLOAD_BYTES);
    assert_eq!(payload[0], RefusalLayer::Native.wire(), "a core failure is a NATIVE refusal");
    assert_eq!(u32::from_le_bytes([payload[3], payload[4], payload[5], payload[6]]), 87);
}

// ---------------------------------------------------------------------------
// DoD 3 — COMPLETED needs ALL FOUR preconditions. Four independent tests, as
// the DoD requires in as many words: four separate tests, not one combined
// path. Each fails exactly ONE leg, so the `Unobserved` variant each asserts
// names the leg that test is about and cannot be answered by a neighbour.
// ---------------------------------------------------------------------------

#[test]
fn completed_is_absent_when_the_retained_root_handle_is_not_waited() {
    // The wait CALL fails at the boundary, so nothing observed the process end.
    let calls = ScriptedCalls::failing(NativeOp::WaitForProcess, 6);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    // The reason is the CORE's, not one invented here: no wait was made, so the
    // core answers NotWaited.
    assert_eq!(
        completion(&outcome),
        Completion::Unknown(Unobserved::RootWait(UnknownExit::NotWaited))
    );
}

#[test]
fn completed_is_absent_when_the_exit_cannot_be_queried_exactly() {
    // The wait IS signalled, so this fails ONLY the exit-query leg and cannot be
    // answered by the root-wait guard ahead of it.
    let calls = ScriptedCalls::failing(NativeOp::QueryExitCode, 87);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    assert_eq!(completion(&outcome), Completion::Unknown(Unobserved::ExitQuery));
}

#[test]
fn completed_is_absent_when_a_provider_channel_never_reaches_eof() {
    // fd4 always has one more byte. Everything else is healthy, so a session
    // that treated EOF as optional would emit COMPLETED here.
    let calls = ScriptedCalls::healthy();
    let mut wired = wiring(a_launch_frame());
    wired.provider_out = Pipe::never_ending();
    let (outcome, wired) = run_with(&calls, wired, PATIENT_TIMEOUT_MS);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    assert_eq!(completion(&outcome), Completion::Unknown(Unobserved::ProviderEof));
}

#[test]
fn completed_is_absent_when_the_second_provider_channel_never_reaches_eof() {
    // fd5, with fd4 already ended. A session that drained only the first
    // provider — or that short-circuited on `out && err` — passes the test above
    // and fails this one. Two channels are named by the DoD, so both are failed
    // independently.
    let calls = ScriptedCalls::healthy();
    let mut wired = wiring(a_launch_frame());
    wired.provider_err = Pipe::never_ending();
    let (outcome, wired) = run_with(&calls, wired, PATIENT_TIMEOUT_MS);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    assert_eq!(completion(&outcome), Completion::Unknown(Unobserved::ProviderEof));
}

#[test]
fn a_provider_channel_that_fails_to_read_is_unobserved_not_ended() {
    // A read error is not an end of stream. Treating a failed read as EOF is the
    // plausible mistake here, and it would upgrade an unobservable leg into a
    // definite one.
    let calls = ScriptedCalls::healthy();
    let mut wired = wiring(a_launch_frame());
    wired.provider_out = Pipe::ended().failing_reads_with(6);
    let (outcome, wired) = run_with(&calls, wired, PATIENT_TIMEOUT_MS);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    assert_eq!(completion(&outcome), Completion::Unknown(Unobserved::ProviderEof));
}

#[test]
fn completed_is_absent_when_the_job_does_not_report_zero_active_processes() {
    // The accounting CALL fails, so `wait_until_job_is_empty` refuses rather
    // than observing emptiness. Chosen over a nonzero count deliberately: the
    // core polls 500 times at 10ms, so a nonzero count would spend five real
    // seconds proving the same thing.
    //
    // It ALSO proves the call happens, and happens BEFORE the frame. A session
    // that skipped the emptiness query would never meet this failure and would
    // emit COMPLETED, failing the first assertion.
    let calls = ScriptedCalls::failing(NativeOp::QueryAccounting, 5);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    assert_eq!(completion(&outcome), Completion::Unknown(Unobserved::JobActive));
}

#[test]
fn all_four_completion_preconditions_are_covered_by_the_four_tests_above() {
    // WITHOUT THIS, ONE PRECONDITION COULD SILENTLY GO UNTESTED. Four named
    // tests read exactly like four covered legs even when two of them fail the
    // same leg; only comparing the produced set against the production
    // vocabulary can tell those apart. `Precondition::ALL` carries its length in
    // its type, so a fifth precondition fails to compile here.
    let mut covered: Vec<Precondition> = vec![
        unobserved_from(ScriptedCalls::failing(NativeOp::WaitForProcess, 6)),
        unobserved_from(ScriptedCalls::failing(NativeOp::QueryExitCode, 87)),
        unobserved_from(ScriptedCalls::failing(NativeOp::QueryAccounting, 5)),
        unobserved_without_provider_eof(),
    ]
    .iter()
    .map(Unobserved::precondition)
    .collect();
    covered.sort();
    covered.dedup();

    let mut expected = Precondition::ALL.to_vec();
    expected.sort();
    assert_eq!(covered, expected, "every completion precondition must be failed by some test");
}

#[test]
fn a_healthy_run_emits_completed_exactly_once_carrying_the_cores_exit_code() {
    let calls = ScriptedCalls::healthy();
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 1);
    assert_eq!(
        completion(&outcome),
        Completion::Completed(Completed::Exited(SCRIPTED_EXIT_CODE))
    );

    // Discriminant 1 is "exited", then the code little-endian. A session that
    // invented a code would still produce five bytes, so the VALUE is asserted.
    let frames = frames_on(&wired.status.written);
    let (_, payload) = frames
        .iter()
        .find(|(opcode, _)| *opcode == Outbound::Completed.opcode())
        .expect("a fully observed end emits COMPLETED");
    let mut expected = vec![1u8];
    expected.extend_from_slice(&SCRIPTED_EXIT_CODE.to_le_bytes());
    assert_eq!(payload, &expected);
}

// ---------------------------------------------------------------------------
// DoD 6 — an exit code is never reported without the core's signalled-wait
// proof.
// ---------------------------------------------------------------------------

#[test]
fn a_still_running_process_yields_the_unknown_reason_code_and_never_a_number() {
    // The wait always times out: the process is still running. The core models
    // that as Unknown(StillRunning), and the session must report THAT rather
    // than reading `exit_code` and passing on whatever number came back — which
    // for a live process is STILL_ACTIVE (259), indistinguishable from a genuine
    // exit with 259. The double is programmed to return exactly 259 so a
    // reimplementation would produce a plausible-looking number.
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::TimedOut]);
    calls.exit_code.set(259);
    let (outcome, wired) = run_with(&calls, wiring(a_launch_frame()), IMPATIENT_TIMEOUT_MS);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    assert_eq!(
        completion(&outcome),
        Completion::Unknown(Unobserved::RootWait(UnknownExit::StillRunning))
    );
    // THE DECISIVE ONE. The raw query must never have been reached: only a
    // signalled wait authorises it, and there was none.
    assert_eq!(calls.count("exit-code"), 0, "an unproved exit must not be queried at all");
}

#[test]
fn an_abandoned_wait_is_not_collapsed_into_running_or_exited() {
    // WAIT_ABANDONED is neither "it exited" nor "it is still running". A session
    // folding it into either neighbour would report a state nothing observed.
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::Abandoned]);
    let (outcome, wired) = run_launch(&calls);

    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
    assert_eq!(
        completion(&outcome),
        Completion::Unknown(Unobserved::RootWait(UnknownExit::WaitAbandoned))
    );
}

// ---------------------------------------------------------------------------
// DoD 4 — a refusal carries a layer, a reason ordinal and a numeric Win32 code,
// and nothing else. Asserted POSITIVELY over every byte the session wrote to
// either outbound channel.
// ---------------------------------------------------------------------------

#[test]
fn no_outbound_byte_ever_echoes_the_executable_argv_cwd_or_environment() {
    // Driven through a refusal, because the refusal path is exactly where a
    // "helpful" error message would be assembled.
    let calls = ScriptedCalls::failing(NativeOp::CreateProcess, 2);
    let (_, wired) = run_launch(&calls);

    for secret in LAUNCH_SECRETS {
        assert!(
            !contains(&wired.status.written, secret.as_bytes()),
            "fd1 echoed a launch request field"
        );
        assert!(
            !contains(&wired.diagnostics.written, secret.as_bytes()),
            "fd2 echoed a launch request field"
        );
    }

    // And the structural guard: every refusal is exactly layer + reason + code,
    // which leaves no room for any of the above even in principle.
    let refusals: Vec<_> = frames_on(&wired.status.written)
        .into_iter()
        .filter(|(opcode, _)| *opcode == Outbound::Refused.opcode())
        .collect();
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0].1.len(), REFUSED_PAYLOAD_BYTES);
}

/// Runs one scenario to a launched child and returns why its end was unknown.
fn unobserved_from(calls: ScriptedCalls) -> Unobserved {
    let (outcome, _) = run_launch(&calls);
    unknown_of(&outcome)
}

/// The provider-EOF scenario, which needs custom wiring rather than a custom
/// call table.
fn unobserved_without_provider_eof() -> Unobserved {
    let calls = ScriptedCalls::healthy();
    let mut wired = wiring(a_launch_frame());
    wired.provider_out = Pipe::never_ending();
    let (outcome, _) = run_with(&calls, wired, PATIENT_TIMEOUT_MS);
    unknown_of(&outcome)
}

fn unknown_of(outcome: &Outcome) -> Unobserved {
    match completion(outcome) {
        Completion::Unknown(reason) => reason,
        Completion::Completed(_) => panic!("this scenario must not complete"),
    }
}

/// Whether `needle` appears anywhere in `haystack`.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

// ---------------------------------------------------------------------------
// Post-LAUNCH control polling. These cases drive the production Session while
// the scripted channel records the polling contract it is expected to use.
// ---------------------------------------------------------------------------

#[test]
fn silent_open_control_is_pending_while_a_longer_child_exits_naturally() {
    let launch = a_launch_frame();
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[
        WaitOutcome::TimedOut,
        WaitOutcome::TimedOut,
        WaitOutcome::Signalled,
    ]);
    let control = Pipe::of(&launch).with_poll_steps(&[PollStep::Pending, PollStep::Pending]);
    let (outcome, wired) = run_with(&calls, wiring_with_control(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::Natural, _)));
    assert_eq!(
        completion(&outcome),
        Completion::Completed(Completed::Exited(SCRIPTED_EXIT_CODE))
    );
    assert_eq!(calls.observed_wait_timeouts(), vec![50, 50, 50]);
    assert_eq!(wired.control.poll_calls, 2);
    assert_eq!(wired.control.polled_bytes, 0);
    assert_eq!(
        wired.control.read_at,
        launch.len(),
        "pending must consume no control bytes"
    );
    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 1);
    assert_eq!(count_of(&wired.status.written, Outbound::Refused), 0);
    assert_eq!(calls.count("terminate-job"), 0);
    assert_eq!(calls.count("terminate-process"), 0);
}

#[test]
fn fragmented_cancel_header_survives_pending_polls_and_stays_prompt() {
    let launch = a_launch_frame();
    let cancel = a_cancel_frame();
    assert_eq!(
        cancel.len(),
        FRAME_HEADER_BYTES,
        "CANCEL has a zero-length payload"
    );
    let mut inbound = launch.clone();
    inbound.extend_from_slice(&cancel);
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::TimedOut]);
    let steps = [
        PollStep::Bytes(2),
        PollStep::Pending,
        PollStep::Bytes(2),
        PollStep::Pending,
        PollStep::Bytes(2),
    ];
    let control = Pipe::of(&inbound).with_poll_steps(&steps);
    let (outcome, wired) = run_with(&calls, wiring_with_control(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::Cancelled, _)));
    assert_eq!(wired.control.poll_calls, 5);
    assert_eq!(wired.control.polled_bytes, FRAME_HEADER_BYTES);
    assert_eq!(wired.control.read_at, launch.len() + cancel.len());
    let waits = calls.observed_wait_timeouts();
    assert_eq!(waits, vec![50, 50, 50, 50, 50, 5_000]);
    assert!(waits[..5].iter().all(|timeout| *timeout <= 50));
    assert_eq!(count_of(&wired.status.written, Outbound::Refused), 0);
    assert_eq!(calls.count("terminate-job"), 1);
    assert_eq!(calls.count("accounting"), 1);
}

#[test]
fn post_launch_eof_is_control_ended_not_a_protocol_refusal() {
    let calls = patient_calls();
    let control = Pipe::of(&a_launch_frame()).with_poll_steps(&[PollStep::End]);
    let (outcome, wired) = run_with(&calls, wiring_with_control(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::ControlEnded, _)));
    assert_eq!(wired.control.poll_calls, 1);
    assert_eq!(count_of(&wired.status.written, Outbound::Refused), 0);
    assert_channel_ended_diagnostic(&wired.diagnostics.written);
    assert_eq!(calls.count("terminate-job"), 1);
    assert_eq!(calls.count("accounting"), 1);
}

#[test]
fn partial_payload_then_pending_eof_is_control_ended_not_a_protocol_refusal() {
    let launch = a_launch_frame();
    let second = a_launch_frame();
    assert!(
        second.len() > FRAME_HEADER_BYTES,
        "the partial-EOF frame must have a payload"
    );
    let mut inbound = launch.clone();
    inbound.extend_from_slice(&second);
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::TimedOut]);
    let steps = [
        PollStep::Bytes(FRAME_HEADER_BYTES + 1),
        PollStep::Pending,
        PollStep::End,
    ];
    let control = Pipe::of(&inbound).with_poll_steps(&steps);
    let (outcome, wired) = run_with(&calls, wiring_with_control(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::ControlEnded, _)));
    assert_eq!(wired.control.poll_calls, 3);
    assert_eq!(wired.control.polled_bytes, FRAME_HEADER_BYTES + 1);
    assert_eq!(count_of(&wired.status.written, Outbound::Refused), 0);
    assert_channel_ended_diagnostic(&wired.diagnostics.written);
    assert_eq!(calls.count("terminate-job"), 1);
    assert_eq!(calls.count("accounting"), 1);
}

#[test]
fn wrong_version_after_launch_refuses_at_protocol_framing() {
    let launch = a_launch_frame();
    let mut wrong_version = a_cancel_frame();
    wrong_version[0] = PROTOCOL_VERSION + 1;
    let mut inbound = launch;
    inbound.extend_from_slice(&wrong_version);
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::TimedOut]);
    let control = Pipe::of(&inbound).with_poll_steps(&[PollStep::Bytes(FRAME_HEADER_BYTES)]);
    let (outcome, wired) = run_with(&calls, wiring_with_control(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::ControlRefused, _)));
    assert_eq!(wired.control.poll_calls, 1);
    assert_eq!(
        only_protocol_refusal(&wired.status.written),
        (
            RefusalLayer::Protocol.wire(),
            ProtocolReason::VersionMismatch.ordinal() as u16,
            0
        ),
    );
    assert_eq!(
        ProtocolReason::VersionMismatch.stage(),
        ProtocolStage::Framing
    );
    assert_eq!(calls.count("terminate-job"), 1);
    assert_eq!(calls.count("accounting"), 1);
}

#[test]
fn poll_failure_after_launch_refuses_with_exact_channel_failure_evidence() {
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::TimedOut]);
    let control = Pipe::of(&a_launch_frame()).with_poll_steps(&[PollStep::Error(1_234)]);
    let (outcome, wired) = run_with(&calls, wiring_with_control(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::ControlRefused, _)));
    assert_eq!(wired.control.poll_calls, 1);
    assert_eq!(
        only_protocol_refusal(&wired.status.written),
        (
            RefusalLayer::Protocol.wire(),
            ProtocolReason::ChannelFailed.ordinal() as u16,
            1_234
        ),
    );
    assert_eq!(RefusalLayer::Protocol.wire(), 2);
    assert_eq!(ProtocolReason::ChannelFailed.ordinal(), 3);
    assert_eq!(
        ProtocolReason::ChannelFailed.stage(),
        ProtocolStage::Framing
    );
    assert_eq!(calls.count("terminate-job"), 1);
    assert_eq!(calls.count("accounting"), 1);
}

// ---------------------------------------------------------------------------
// DoD 5 — five termination paths, each terminating and reaping EXACTLY ONCE.
//
// FIVE SEPARATE TESTS WITH FIVE SEPARATE CALL-COUNT ASSERTIONS, because the DoD
// says in as many words that one shared path satisfying all five fails the item.
// They are deliberately NOT factored into a helper that asserts once: a helper
// is precisely the shape that would let four of the five stop being checked
// while the suite stayed green.
//
// EXACTLY-ONCE IS THE PROPERTY, NOT "IT TERMINATED". A double terminate is
// invisible to a did-it-terminate assertion, so every test below pins
// `count("terminate-job") == 1` and `count("accounting") == 1` — the second
// being the reap, since `wait_until_job_is_empty` reads the count once when the
// Job is already empty.
// ---------------------------------------------------------------------------

/// Asks the session to stop on its first opportunity.
struct StopNow;

impl ShutdownSignal for StopNow {
    fn requested(&self) -> bool {
        true
    }
}

/// A launch whose first wait slice expires, so the session takes one control
/// instruction before the child is observed to end.
fn patient_calls() -> ScriptedCalls {
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::TimedOut, WaitOutcome::Signalled]);
    calls
}

#[test]
fn cancel_on_fd0_terminates_and_reaps_exactly_once() {
    let calls = patient_calls();
    let mut control = a_launch_frame();
    control.extend_from_slice(&a_cancel_frame());
    let (outcome, wired) = run_with(&calls, wiring(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::Cancelled, _)));
    assert_eq!(calls.count("terminate-job"), 1, "cancel must terminate exactly once");
    assert_eq!(calls.count("accounting"), 1, "cancel must reap exactly once");
    // taskRail 1: cancel is not finished at the terminate. It must still observe
    // ActiveProcesses == 0 before returning an authority-neutral completion.
    assert_eq!(count_of(&wired.status.written, Outbound::Started), 1);
}

#[test]
fn an_instructed_timeout_terminates_and_reaps_exactly_once_and_preserves_unknown() {
    let calls = ScriptedCalls::healthy();
    calls.waiting(&[WaitOutcome::TimedOut]);
    let (outcome, wired) = run_with(&calls, wiring(a_launch_frame()), IMPATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::TimedOut, _)));
    assert_eq!(calls.count("terminate-job"), 1, "a timeout must terminate exactly once");
    assert_eq!(calls.count("accounting"), 1, "a timeout must reap exactly once");
    // UNKNOWN IS PRESERVED, NOT UPGRADED. The process was never observed to end,
    // so there is no exit to report and COMPLETED must be absent.
    assert_eq!(
        completion(&outcome),
        Completion::Unknown(Unobserved::RootWait(UnknownExit::StillRunning))
    );
    assert_eq!(count_of(&wired.status.written, Outbound::Completed), 0);
}

#[test]
fn fd0_reaching_end_of_stream_terminates_and_reaps_exactly_once() {
    // The control channel carries the launch and nothing more, so the next read
    // after the first wait slice finds the stream ended.
    let calls = patient_calls();
    let (outcome, _) = run_with(&calls, wiring(a_launch_frame()), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::ControlEnded, _)));
    assert_eq!(calls.count("terminate-job"), 1, "fd0 EOF must terminate exactly once");
    assert_eq!(calls.count("accounting"), 1, "fd0 EOF must reap exactly once");
}

#[test]
fn malformed_control_after_a_successful_launch_terminates_and_reaps_exactly_once() {
    // A SECOND launch frame on a channel that already accepted one. The session
    // must already hold the Job when it refuses, which is what makes this
    // different from a malformed frame arriving first.
    let calls = patient_calls();
    let mut control = a_launch_frame();
    control.extend_from_slice(&a_launch_frame());
    let (outcome, wired) = run_with(&calls, wiring(control), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::Ran(Stopped::ControlRefused, _)));
    assert_eq!(calls.count("terminate-job"), 1, "a refusal after launch terminates exactly once");
    assert_eq!(calls.count("accounting"), 1, "a refusal after launch reaps exactly once");

    // STARTED came first, so the refusal genuinely happened with a live child.
    assert_eq!(count_of(&wired.status.written, Outbound::Started), 1);

    // The refusal names the PROTOCOL layer and the duplicate-launch reason —
    // not merely "something refused". Asserting the layer is what stops this
    // staying green if the refusal migrated to the descriptor or native layer.
    let refusals: Vec<_> = frames_on(&wired.status.written)
        .into_iter()
        .filter(|(opcode, _)| *opcode == Outbound::Refused.opcode())
        .collect();
    assert_eq!(refusals.len(), 1);
    let payload = &refusals[0].1;
    assert_eq!(payload.len(), REFUSED_PAYLOAD_BYTES);
    assert_eq!(payload[0], RefusalLayer::Protocol.wire());
    assert_eq!(
        u16::from_le_bytes([payload[1], payload[2]]),
        ProtocolReason::DuplicateLaunch.ordinal() as u16
    );
    assert_eq!(
        ProtocolReason::DuplicateLaunch.stage(),
        ProtocolStage::Control
    );
}

#[test]
fn helper_shutdown_terminates_and_reaps_exactly_once() {
    let calls = patient_calls();
    let mut wired = wiring(a_launch_frame());
    let outcome = Session::new(&calls, PROVIDERS, PATIENT_TIMEOUT_MS).run(&mut wired, &StopNow);

    assert!(matches!(outcome, Outcome::Ran(Stopped::Shutdown, _)));
    assert_eq!(calls.count("terminate-job"), 1, "shutdown must terminate exactly once");
    assert_eq!(calls.count("accounting"), 1, "shutdown must reap exactly once");
    // The child was launched and announced before the helper stopped, so this is
    // a live-child shutdown rather than a refusal before anything existed.
    assert_eq!(count_of(&wired.status.written, Outbound::Started), 1);
}

#[test]
fn the_five_termination_paths_are_five_distinct_outcomes() {
    // A guard over the five tests above, in the same spirit as the precondition
    // sweep: five named tests read like five covered paths even if two of them
    // reach the SAME `Stopped`. Comparing the produced set against the
    // production vocabulary is what tells those apart.
    let cancel = {
        let calls = patient_calls();
        let mut control = a_launch_frame();
        control.extend_from_slice(&a_cancel_frame());
        stopped_of(run_with(&calls, wiring(control), PATIENT_TIMEOUT_MS).0)
    };
    let timeout = {
        let calls = ScriptedCalls::healthy();
        calls.waiting(&[WaitOutcome::TimedOut]);
        stopped_of(run_with(&calls, wiring(a_launch_frame()), IMPATIENT_TIMEOUT_MS).0)
    };
    let ended = {
        let calls = patient_calls();
        stopped_of(run_with(&calls, wiring(a_launch_frame()), PATIENT_TIMEOUT_MS).0)
    };
    let refused = {
        let calls = patient_calls();
        let mut control = a_launch_frame();
        control.extend_from_slice(&a_launch_frame());
        stopped_of(run_with(&calls, wiring(control), PATIENT_TIMEOUT_MS).0)
    };
    let shutdown = {
        let calls = patient_calls();
        let mut wired = wiring(a_launch_frame());
        stopped_of(Session::new(&calls, PROVIDERS, PATIENT_TIMEOUT_MS).run(&mut wired, &StopNow))
    };

    let mut observed = vec![cancel, timeout, ended, refused, shutdown];
    observed.sort();
    observed.dedup();
    assert_eq!(observed.len(), 5, "the five termination paths must be five distinct outcomes");
    assert!(!observed.contains(&Stopped::Natural), "no termination path may report a natural end");
}

#[test]
fn a_natural_end_reaps_without_terminating_anything() {
    // taskRail 1 in both directions. Ordinary completion must STILL observe
    // ActiveProcesses == 0 — closing the Job handle is crash safety, not success
    // evidence — but it must not terminate a child that already exited.
    let calls = ScriptedCalls::healthy();
    let (outcome, _) = run_launch(&calls);

    assert!(matches!(outcome, Outcome::Ran(Stopped::Natural, _)));
    assert_eq!(calls.count("terminate-job"), 0, "a child that exited must not be terminated");
    assert_eq!(calls.count("terminate-process"), 0);
    assert_eq!(calls.count("accounting"), 1, "ordinary completion still proves the Job is empty");
}

#[test]
fn fd0_ending_before_any_launch_writes_nothing_at_all_to_fd1() {
    // A parent that says nothing has violated no rule, so there is nothing to
    // refuse — and nobody left to tell, since the peer that would read a REFUSED
    // frame is the peer that just closed.
    //
    // fd1 STAYING COMPLETELY EMPTY IS THE POINT, not merely that no STARTED
    // appeared. The binary reports its descriptor inventory on fd1 as plain
    // ASCII on exactly this path, and that line and a binary frame stream cannot
    // share a channel: one frame here would corrupt the other.
    let calls = ScriptedCalls::healthy();
    let (outcome, wired) = run_with(&calls, wiring(Vec::new()), PATIENT_TIMEOUT_MS);

    assert_eq!(outcome, Outcome::NoInstruction);
    assert!(wired.status.written.is_empty(), "fd1 must be untouched when nothing was asked");
    assert_eq!(calls.count("create-job"), 0);
    assert_eq!(calls.count("terminate-job"), 0);
}

#[test]
fn a_cancel_before_any_launch_is_refused_and_reaps_nothing() {
    // There is no Job and no child yet, so there is nothing to terminate. A
    // session that unwound here would be terminating a Job it never created.
    let calls = ScriptedCalls::healthy();
    let (outcome, wired) = run_with(&calls, wiring(a_cancel_frame()), PATIENT_TIMEOUT_MS);

    assert!(matches!(outcome, Outcome::NotLaunched(_)));
    assert_eq!(calls.count("create-job"), 0);
    assert_eq!(calls.count("terminate-job"), 0);
    assert_eq!(count_of(&wired.status.written, Outbound::Started), 0);

    let refusals: Vec<_> = frames_on(&wired.status.written)
        .into_iter()
        .filter(|(opcode, _)| *opcode == Outbound::Refused.opcode())
        .collect();
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0].1[0], RefusalLayer::Protocol.wire());
    assert_eq!(
        u16::from_le_bytes([refusals[0].1[1], refusals[0].1[2]]),
        ProtocolReason::FrameOutOfOrder.ordinal() as u16
    );
}

fn stopped_of(outcome: Outcome) -> Stopped {
    match outcome {
        Outcome::Ran(stopped, _) => stopped,
        Outcome::NotLaunched(_) => panic!("this scenario must reach a launched child"),
        Outcome::NoInstruction => panic!("this scenario must send a launch"),
    }
}
