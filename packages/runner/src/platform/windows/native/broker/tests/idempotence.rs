//! Three termination triggers armed at ONE rendezvous, and exactly one teardown.
//!
//! # What 3c already proved, and what this file is therefore not
//!
//! tests/session.rs drives CANCEL, fd0 end-of-stream and an instructed timeout
//! ONE AFTER ANOTHER, each with its own call-count table. Running those three
//! again in sequence here would add nothing: the defect this file exists to rule
//! out is only reachable when two of them are live AT THE SAME TIME and the
//! session tears down twice. A serialised test is sequential wearing
//! concurrency's clothes, and it cannot see that.
//!
//! # Where the race actually is, given a single-threaded session
//!
//! The session is single-threaded BY CONSTRUCTION (watch.rs), so the concurrency
//! is not inside it — it is between the session thread and the two peer threads
//! that own the other end of fd0, exactly as a real parent process would be. The
//! three racers are:
//!
//! ```text
//! CANCEL      a peer thread appends a cancel frame to fd0
//! fd0 EOF     a peer thread closes fd0
//! TIMEOUT     the instructed timeout expires inside the session's own loop
//! ```
//!
//! # THE RENDEZVOUS IS INSIDE THE FIRST WAIT, AND THAT PLACEMENT IS LOAD-BEARING
//!
//! It cannot go inside the fd0 read: `watch` checks `remaining == 0` BEFORE it
//! reads fd0, so every timeout-biased round would skip a rendezvous the peers
//! were already blocked on and hang the suite. `wait_for_process` is the one
//! point the loop always reaches, whichever racer eventually wins.
//!
//! It is a CONDVAR WITH A BOUND rather than a `Barrier` for the same reason:
//! `Barrier` has no timeout, so a session that failed before the release point
//! would deadlock instead of failing. [`Gate`] releases the peers, then waits
//! (bounded) for both to acknowledge, so all three are genuinely running at the
//! same instant and a lost peer becomes a NAMED assertion failure.
//!
//! # WRITING CANCEL AFTER fd0 CLOSED IS REFUSED, WHICH IS WHAT MAKES THIS A RACE
//!
//! [`Shared::append`] refuses once [`Shared::end`] has run, because a parent that
//! closed its write end physically cannot then write down it. Without that, the
//! reader would always drain pending bytes before honouring EOF and CANCEL would
//! win every single round — a fixed answer dressed as a race. With it, the two
//! peers contend for one lock and either outcome is physically meaningful:
//!
//! ```text
//! cancel takes the lock first  -> bytes are on fd0, then it closes -> Cancelled
//! end takes the lock first     -> fd0 closed, the cancel never lands -> ControlEnded
//! ```
//!
//! That consistency is ASSERTED rather than assumed: a round reporting
//! `ControlEnded` whose cancel was accepted, or `Cancelled` whose cancel was
//! refused, fails the suite.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use moe_windows_job_broker::{
    ByteChannel, Completion, Inbound, Outbound, Outcome, Session, ShutdownSignal, Stopped,
    Unobserved, Wiring, FRAME_HEADER_BYTES, PROTOCOL_VERSION,
};
use moe_windows_job_core::{
    CreatedProcess, NativeError, NativeOp, ProcessCalls, ProcessSpec, RawHandle, UnknownExit,
    WaitOutcome, Win32Calls, INHERITED_HANDLE_COUNT, REQUIRED_LIMIT_FLAGS,
};

/// The first handle value the scripted table hands out.
const FIRST_HANDLE: isize = 0x1000;

/// fd3, fd4 and fd5 — the provider trio the child inherits.
const PROVIDERS: [RawHandle; INHERITED_HANDLE_COUNT] =
    [RawHandle::new(0x33), RawHandle::new(0x34), RawHandle::new(0x35)];

const SCRIPTED_PID: u32 = 7_321;
const SCRIPTED_CREATION_TIME: u64 = 0x01DB_0000_0000_002A;

/// How long a scripted wait really sleeps, whatever it was asked for.
///
/// REAL TIME, NOT ZERO. The peers do their work inside this window, so a wait
/// that returned instantly would collapse the race back into a fixed order. It
/// is capped so the 150-round sweep costs seconds rather than minutes; the
/// session's own `remaining` arithmetic uses the INSTRUCTED slice, so capping the
/// sleep changes which racer wins in wall-clock terms and nothing else.
const WAIT_SLEEP_CAP_MS: u64 = 4;

/// Instructed timeouts, chosen to bias which racer wins.
///
/// `watch` takes a slice of at most 50ms and ends the run when `remaining`
/// reaches zero BEFORE it reads fd0, so a timeout of exactly one slice always
/// resolves as `TimedOut` and anything longer always reaches fd0. All three
/// racers are armed in every round regardless; the bias only decides which one
/// the loop resolves first, which is what gives the sweep more than one winner.
const TIMEOUT_BIASES: [u32; 3] = [50, 100, 150];

/// Rounds per bias. A single iteration of a genuine race proves almost nothing.
const ROUNDS_PER_BIAS: usize = 50;

/// How long a peer waits to be released, and the session waits for both peers.
/// Exceeding it is a harness fault reported by name, never a silent hang.
const RENDEZVOUS_BOUND: Duration = Duration::from_secs(10);

/// How long a blocking read may wait for bytes or EOF before giving up.
const READ_BOUND: Duration = Duration::from_secs(10);

/// The peers that must acknowledge the rendezvous: cancel and end-of-stream.
const PEERS: usize = 2;

// ---------------------------------------------------------------------------
// The rendezvous
// ---------------------------------------------------------------------------

/// A one-shot release point with a bound on every wait.
struct Gate {
    released: Mutex<bool>,
    signal: Condvar,
    arrived: AtomicUsize,
    lost: AtomicBool,
}

impl Gate {
    fn new() -> Self {
        Self {
            released: Mutex::new(false),
            signal: Condvar::new(),
            arrived: AtomicUsize::new(0),
            lost: AtomicBool::new(false),
        }
    }

    /// Session side: release the peers.
    fn release(&self) {
        *self.released.lock().expect("the gate lock is never poisoned") = true;
        self.signal.notify_all();
    }

    /// Peer side: block until released, then acknowledge.
    fn join(&self) {
        let deadline = Instant::now() + RENDEZVOUS_BOUND;
        let mut released = self.released.lock().expect("the gate lock is never poisoned");
        while !*released {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                self.lost.store(true, Ordering::SeqCst);
                return;
            };
            let (guard, outcome) = self
                .signal
                .wait_timeout(released, left)
                .expect("the gate lock is never poisoned");
            released = guard;
            if outcome.timed_out() && !*released {
                self.lost.store(true, Ordering::SeqCst);
                return;
            }
        }
        drop(released);
        self.arrived.fetch_add(1, Ordering::SeqCst);
    }

    /// Session side: wait (bounded) until every peer has acknowledged, so all
    /// three really are running at the same instant.
    fn await_peers(&self) -> bool {
        let deadline = Instant::now() + RENDEZVOUS_BOUND;
        while self.arrived.load(Ordering::SeqCst) < PEERS {
            if Instant::now() >= deadline || self.lost.load(Ordering::SeqCst) {
                return false;
            }
            std::thread::yield_now();
        }
        !self.lost.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// A pipe both ends can reach
// ---------------------------------------------------------------------------

/// One channel's bytes, and everything the READER actually took from it.
struct Shared {
    pending: Vec<u8>,
    read_at: usize,
    ended: bool,
    /// The reader's recorded input. Kept so a later test can assert what did and
    /// did not reach a decoder, rather than only what came out.
    consumed: Vec<u8>,
    written: Vec<u8>,
}

impl Shared {
    fn holding(bytes: &[u8]) -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            pending: bytes.to_vec(),
            read_at: 0,
            ended: false,
            consumed: Vec::new(),
            written: Vec::new(),
        }))
    }

    fn closed() -> Arc<Mutex<Self>> {
        let shared = Self::holding(&[]);
        shared.lock().expect("a fresh lock is never poisoned").ended = true;
        shared
    }
}

/// Appends bytes, or refuses because the writer already closed its end.
fn append(shared: &Arc<Mutex<Shared>>, bytes: &[u8]) -> bool {
    let mut state = shared.lock().expect("the channel lock is never poisoned");
    if state.ended {
        return false;
    }
    state.pending.extend_from_slice(bytes);
    true
}

/// Closes the writer's end. Every later append is refused.
fn end(shared: &Arc<Mutex<Shared>>) {
    shared.lock().expect("the channel lock is never poisoned").ended = true;
}

/// A [`ByteChannel`] over a [`Shared`] the peer threads also hold.
struct Channel {
    shared: Arc<Mutex<Shared>>,
}

impl Channel {
    fn over(shared: &Arc<Mutex<Shared>>) -> Self {
        Self { shared: Arc::clone(shared) }
    }
}

impl ByteChannel for Channel {
    /// Blocks for bytes or EOF, exactly as a real pipe does.
    ///
    /// A zero-length read on an open channel would be a FABRICATED end of
    /// stream, and `read_frame` turns that straight into `FrameTruncated` — so
    /// returning early here would hand the session an EOF no peer produced. The
    /// bound exists only so a harness fault fails by name instead of hanging.
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, u32> {
        let deadline = Instant::now() + READ_BOUND;
        loop {
            {
                let mut state = self.shared.lock().expect("the channel lock is never poisoned");
                let available = state.pending.len() - state.read_at;
                if available > 0 {
                    let take = available.min(buffer.len());
                    let from = state.read_at;
                    buffer[..take].copy_from_slice(&state.pending[from..from + take]);
                    state.read_at += take;
                    let taken = buffer[..take].to_vec();
                    state.consumed.extend_from_slice(&taken);
                    return Ok(take);
                }
                if state.ended {
                    return Ok(0);
                }
            }
            if Instant::now() >= deadline {
                return Err(u32::MAX);
            }
            std::thread::yield_now();
        }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<usize, u32> {
        let mut state = self.shared.lock().expect("the channel lock is never poisoned");
        state.written.extend_from_slice(bytes);
        Ok(bytes.len())
    }
}

// ---------------------------------------------------------------------------
// The Win32 double, shareable because the session thread borrows it
// ---------------------------------------------------------------------------

/// A scripted Win32 + process boundary that records an ordered call log and
/// releases the rendezvous on the session's FIRST wait.
///
/// Every field is a lock or an atomic rather than a `Cell`, because `&calls` is
/// borrowed by a scoped thread and that requires `Sync`. It scripts the boundary
/// and nothing else: no proof arm, no completion precondition and no termination
/// ordering is restated here.
struct RacingCalls {
    log: Mutex<Vec<&'static str>>,
    waits: Mutex<Vec<WaitOutcome>>,
    next_handle: AtomicIsize,
    active_remaining: AtomicU32,
    released: AtomicBool,
    gate: Arc<Gate>,
    rendezvous: AtomicBool,
}

impl RacingCalls {
    fn new(gate: &Arc<Gate>) -> Self {
        Self {
            log: Mutex::new(Vec::new()),
            waits: Mutex::new(vec![WaitOutcome::TimedOut]),
            next_handle: AtomicIsize::new(FIRST_HANDLE),
            active_remaining: AtomicU32::new(0),
            released: AtomicBool::new(false),
            gate: Arc::clone(gate),
            rendezvous: AtomicBool::new(true),
        }
    }

    fn arm(&self, name: &'static str) -> Result<(), NativeError> {
        self.log.lock().expect("the log lock is never poisoned").push(name);
        Ok(())
    }

    fn hand_out(&self) -> RawHandle {
        RawHandle::new(self.next_handle.fetch_add(1, Ordering::SeqCst))
    }

    fn count(&self, name: &str) -> usize {
        self.log
            .lock()
            .expect("the log lock is never poisoned")
            .iter()
            .filter(|entry| **entry == name)
            .count()
    }
}

impl Win32Calls for RacingCalls {
    fn create_job_object(&self) -> Result<RawHandle, NativeError> {
        self.arm("create-job")?;
        Ok(self.hand_out())
    }

    fn set_limit_flags(&self, _job: RawHandle, flags: u32) -> Result<(), NativeError> {
        assert_eq!(flags, REQUIRED_LIMIT_FLAGS, "the session must set exactly the core's flags");
        self.arm("set-flags")
    }

    fn query_limit_flags(&self, _job: RawHandle) -> Result<u32, NativeError> {
        self.arm("query-flags")?;
        Ok(REQUIRED_LIMIT_FLAGS)
    }

    fn terminate_job(&self, _job: RawHandle) -> Result<(), NativeError> {
        self.arm("terminate-job")
    }

    fn query_active_processes(&self, _job: RawHandle) -> Result<u32, NativeError> {
        self.arm("accounting")?;
        let remaining = self.active_remaining.load(Ordering::SeqCst);
        self.active_remaining.store(remaining.saturating_sub(1), Ordering::SeqCst);
        Ok(remaining)
    }

    fn close_handle(&self, _handle: RawHandle) -> Result<(), NativeError> {
        self.arm("close")
    }
}

impl ProcessCalls for RacingCalls {
    type AttributeList = ();

    fn init_attribute_list(&self, _attributes: u32) -> Result<(), NativeError> {
        self.arm("init-list")
    }

    fn set_job_list_attribute(&self, _list: &mut (), _job: RawHandle) -> Result<(), NativeError> {
        self.arm("job-list")
    }

    fn set_handle_list_attribute(
        &self,
        _list: &mut (),
        handles: [RawHandle; INHERITED_HANDLE_COUNT],
    ) -> Result<(), NativeError> {
        // `assert!` rather than `assert_eq!`: RawHandle has no Debug, by rail.
        assert!(handles == PROVIDERS, "the child inherits exactly fd3, fd4 and fd5");
        self.arm("handle-list")
    }

    fn create_process_suspended(
        &self,
        _spec: &ProcessSpec<'_>,
        _list: &(),
    ) -> Result<CreatedProcess, NativeError> {
        self.arm("create-process")?;
        Ok(CreatedProcess { process: self.hand_out(), thread: self.hand_out() })
    }

    fn assign_process_to_job(&self, _p: RawHandle, _job: RawHandle) -> Result<(), NativeError> {
        self.arm("assign")
    }

    fn is_process_in_job(&self, _p: RawHandle, _job: RawHandle) -> Result<bool, NativeError> {
        self.arm("membership")?;
        Ok(true)
    }

    fn process_id(&self, _process: RawHandle) -> Result<u32, NativeError> {
        self.arm("pid")?;
        Ok(SCRIPTED_PID)
    }

    fn creation_time(&self, _process: RawHandle) -> Result<u64, NativeError> {
        self.arm("creation-time")?;
        Ok(SCRIPTED_CREATION_TIME)
    }

    fn resume_thread(&self, _thread: RawHandle) -> Result<u32, NativeError> {
        self.arm("resume")?;
        Ok(1)
    }

    /// THE RELEASE POINT. The first wait of the run opens the gate and waits for
    /// both peers to acknowledge, so the session, the cancel writer and the
    /// closer are all live before this wait's sleep begins.
    fn wait_for_process(&self, _p: RawHandle, timeout_ms: u32) -> Result<WaitOutcome, NativeError> {
        self.arm("wait")?;
        if !self.released.swap(true, Ordering::SeqCst) {
            self.gate.release();
            self.rendezvous.store(self.gate.await_peers(), Ordering::SeqCst);
        }
        std::thread::sleep(Duration::from_millis(u64::from(timeout_ms).min(WAIT_SLEEP_CAP_MS)));
        let mut waits = self.waits.lock().expect("the wait lock is never poisoned");
        if waits.len() > 1 {
            Ok(waits.remove(0))
        } else {
            Ok(*waits.first().unwrap_or(&WaitOutcome::TimedOut))
        }
    }

    fn exit_code(&self, _process: RawHandle) -> Result<u32, NativeError> {
        self.arm("exit-code")?;
        Ok(0)
    }

    fn terminate_process(&self, _process: RawHandle) -> Result<(), NativeError> {
        self.arm("terminate-process")
    }

    fn image_name(&self, _process: RawHandle) -> Result<Vec<u16>, NativeError> {
        self.arm("image-name")?;
        Ok("C:\\Windows\\System32\\PING.EXE".encode_utf16().chain([0]).collect())
    }

    fn delete_attribute_list(&self, _list: ()) {}
}

/// Never asks the session to stop: the racers here are the three the DoD names.
struct RunToCompletion;

impl ShutdownSignal for RunToCompletion {
    fn requested(&self) -> bool {
        false
    }
}

// ---------------------------------------------------------------------------
// Frames, hand-built so the test states the wire layout
// ---------------------------------------------------------------------------

fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![PROTOCOL_VERSION, opcode];
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn text(value: &str) -> Vec<u8> {
    let mut bytes = (value.len() as u16).to_le_bytes().to_vec();
    bytes.extend_from_slice(value.as_bytes());
    bytes
}

fn a_launch_frame() -> Vec<u8> {
    let mut payload = text("C:\\Windows\\System32\\PING.EXE");
    payload.extend_from_slice(&0u16.to_le_bytes());
    payload.extend_from_slice(&text("C:\\Windows\\Temp"));
    payload.extend_from_slice(&0u16.to_le_bytes());
    frame(Inbound::Launch.opcode(), &payload)
}

fn a_cancel_frame() -> Vec<u8> {
    frame(Inbound::Cancel.opcode(), &[])
}

/// Parses a recorded outbound stream back into frames, never searches it.
fn frames_on(stream: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let mut frames = Vec::new();
    let mut at = 0;
    while at + FRAME_HEADER_BYTES <= stream.len() {
        let declared =
            u32::from_le_bytes([stream[at + 2], stream[at + 3], stream[at + 4], stream[at + 5]])
                as usize;
        let start = at + FRAME_HEADER_BYTES;
        let Some(payload) = stream.get(start..start + declared) else {
            break;
        };
        frames.push((stream[at + 1], payload.to_vec()));
        at = start + declared;
    }
    frames
}

fn count_of(stream: &[u8], kind: Outbound) -> usize {
    frames_on(stream).iter().filter(|(opcode, _)| *opcode == kind.opcode()).count()
}

// ---------------------------------------------------------------------------
// One round of the race
// ---------------------------------------------------------------------------

/// What one round observed. Every field is read from a recorded fact, never
/// inferred from another field.
struct Round {
    stopped: Stopped,
    completion: Completion,
    cancel_accepted: bool,
    cancel_attempted: bool,
    ended_applied: bool,
    rendezvous: bool,
    terminates: usize,
    reaps: usize,
    starteds: usize,
    completeds: usize,
}

/// Runs the session while two peer threads race it, all three released together.
fn race_once(timeout_ms: u32) -> Round {
    let gate = Arc::new(Gate::new());
    let calls = RacingCalls::new(&gate);
    let control = Shared::holding(&a_launch_frame());
    let status = Shared::closed();
    let mut wired = Wiring {
        control: Channel::over(&control),
        status: Channel::over(&status),
        diagnostics: Channel::over(&Shared::closed()),
        provider_out: Channel::over(&Shared::closed()),
        provider_err: Channel::over(&Shared::closed()),
    };

    let cancel_frame = a_cancel_frame();
    let (outcome, cancel_accepted, cancel_attempted, ended_applied) =
        std::thread::scope(|scope| {
            let canceller = scope.spawn(|| {
                gate.join();
                (true, append(&control, &cancel_frame))
            });
            let closer = scope.spawn(|| {
                gate.join();
                end(&control);
                true
            });
            let outcome =
                Session::new(&calls, PROVIDERS, timeout_ms).run(&mut wired, &RunToCompletion);
            let (attempted, accepted) = canceller.join().expect("the cancel peer must not panic");
            let applied = closer.join().expect("the closing peer must not panic");
            (outcome, accepted, attempted, applied)
        });

    let (stopped, completion) = match outcome {
        Outcome::Ran(stopped, completion) => (stopped, completion),
        Outcome::NotLaunched(_) => panic!("every round of this race must reach a launched child"),
        Outcome::NoInstruction => panic!("every round of this race sends a launch"),
    };
    let written = status.lock().expect("the status lock is never poisoned").written.clone();

    Round {
        stopped,
        completion,
        cancel_accepted,
        cancel_attempted,
        ended_applied,
        rendezvous: calls.rendezvous.load(Ordering::SeqCst),
        terminates: calls.count("terminate-job"),
        reaps: calls.count("accounting"),
        starteds: count_of(&written, Outbound::Started),
        completeds: count_of(&written, Outbound::Completed),
    }
}

// ---------------------------------------------------------------------------
// DoD 1
// ---------------------------------------------------------------------------

#[test]
fn racing_cancel_end_of_stream_and_timeout_terminate_and_reap_exactly_once() {
    let mut rounds = Vec::new();
    for bias in TIMEOUT_BIASES {
        for _ in 0..ROUNDS_PER_BIAS {
            rounds.push((bias, race_once(bias)));
        }
    }

    // THE SWEEP RAN. A generated case that silently produced nothing passes
    // every assertion below by vacuity, so the count is pinned first.
    assert_eq!(
        rounds.len(),
        TIMEOUT_BIASES.len() * ROUNDS_PER_BIAS,
        "the race must actually have been run the scripted number of times"
    );

    for (bias, round) in &rounds {
        // ALL THREE RACERS WERE ARMED, per round. Without this the sweep could
        // be measuring a session nobody raced.
        assert!(round.rendezvous, "bias {bias}: the three racers never met at the rendezvous");
        assert!(round.cancel_attempted, "bias {bias}: the cancel peer never ran");
        assert!(round.ended_applied, "bias {bias}: the closing peer never ran");

        // EXACTLY ONCE IS THE PROPERTY. A double teardown is invisible to a
        // "did it terminate" assertion, which is why these are counts.
        assert_eq!(round.terminates, 1, "bias {bias}: terminated {} times", round.terminates);
        assert_eq!(round.reaps, 1, "bias {bias}: reaped {} times", round.reaps);
        assert_eq!(round.starteds, 1, "bias {bias}: STARTED must reach fd1 exactly once");
    }
}

#[test]
fn a_racing_loser_never_upgrades_an_unobserved_leg_to_a_definite_outcome() {
    // No wait in this file ever reports Signalled, so no round may claim an
    // exit. The racing loser must not supply one either: whichever trigger won,
    // the child was never observed to end.
    for bias in TIMEOUT_BIASES {
        for _ in 0..ROUNDS_PER_BIAS {
            let round = race_once(bias);
            assert_eq!(
                round.completion,
                Completion::Unknown(Unobserved::RootWait(UnknownExit::StillRunning)),
                "bias {bias}: an unobserved leg was upgraded to a definite outcome"
            );
            assert_eq!(
                round.completeds, 0,
                "bias {bias}: COMPLETED must be absent when nothing observed the end"
            );
        }
    }
}

#[test]
fn the_race_resolves_to_more_than_one_winner_and_every_winner_is_consistent() {
    let mut winners: Vec<Stopped> = Vec::new();
    for bias in TIMEOUT_BIASES {
        for _ in 0..ROUNDS_PER_BIAS {
            let round = race_once(bias);

            // WHICH RACER WON MUST MATCH WHAT THE PEERS ACTUALLY DID. A round
            // reporting ControlEnded whose cancel was accepted would mean the
            // reader dropped bytes that were on the channel; a round reporting
            // Cancelled whose cancel was refused would mean it decoded a frame
            // that was never written. Either is a mislabelled race.
            match round.stopped {
                Stopped::Cancelled => assert!(
                    round.cancel_accepted,
                    "a cancel was decoded that the peer never managed to write"
                ),
                Stopped::ControlEnded => assert!(
                    !round.cancel_accepted,
                    "fd0 reported end of stream while a written cancel was still unread"
                ),
                Stopped::TimedOut => {}
                other => panic!("no racer in this file can produce {other:?}"),
            }
            winners.push(round.stopped);
        }
    }

    let mut distinct = winners.clone();
    distinct.sort();
    distinct.dedup();
    assert!(
        distinct.len() >= 2,
        "the race collapsed to a single fixed winner {distinct:?}, so nothing raced"
    );
    assert!(
        winners.contains(&Stopped::TimedOut),
        "the instructed timeout never won a round: {distinct:?}"
    );
    assert!(
        winners.iter().any(|w| matches!(w, Stopped::Cancelled | Stopped::ControlEnded)),
        "neither fd0 racer ever won a round: {distinct:?}"
    );
}

#[test]
fn a_closed_fd0_refuses_a_later_cancel_so_the_two_peers_genuinely_contend() {
    // The premise the race rests on, asserted directly rather than left to be
    // inferred from the sweep: once the writer's end is closed, the cancel
    // CANNOT land. If this stopped holding, pending bytes would always drain
    // before EOF and every round above would resolve the same way while still
    // passing.
    let shared = Shared::holding(&[]);
    assert!(append(&shared, &a_cancel_frame()), "an open channel must accept a write");
    end(&shared);
    assert!(!append(&shared, &a_cancel_frame()), "a closed writer end must refuse a write");
}

#[test]
fn the_scripted_boundary_never_reports_a_signalled_wait() {
    // Guards the premise of the UNKNOWN assertion above. If the double ever
    // started reporting Signalled, that test would keep passing for the wrong
    // reason on any round where the child was "observed" to exit.
    let gate = Arc::new(Gate::new());
    let calls = RacingCalls::new(&gate);
    let waits = calls.waits.lock().expect("a fresh lock is never poisoned");
    assert!(
        waits.iter().all(|outcome| *outcome == WaitOutcome::TimedOut),
        "this file's double must never observe the child exit"
    );
}
