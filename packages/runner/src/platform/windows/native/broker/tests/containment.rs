//! Containment: a forcibly killed broker still cannot strand a process tree, and
//! the two ways a Job empties are proved SEPARATELY.
//!
//! # THE TWO MECHANISMS, AND WHY ONE MAY NEVER STAND IN FOR THE OTHER
//!
//! ```text
//! CONTROLLED   natural completion and cancel query the Job and observe
//!              ActiveProcesses == 0 before returning. Success EVIDENCE.
//! FORCIBLE     the broker is killed, so it queries nothing. The last handle to
//!              the Job closes with it and the kernel kills the members. CRASH
//!              SAFETY, not evidence — nobody was left to observe anything.
//! ```
//!
//! taskRail 3 requires both, asserted apart. This file keeps them apart at the
//! level of EVIDENCE SOURCE, not merely of assertion text: the controlled paths
//! are read from a scripted boundary's ordered call log, and the forcible path is
//! read from the operating system's own view of two live processes. Neither
//! measurement can be satisfied by the other's mechanism, so a shared helper
//! could not have collapsed them even by accident.
//!
//! # WHY A PID IS NOT AN IDENTITY (taskRail 1)
//!
//! Windows reuses PIDs. Asserting a PID no longer opens is a FALSE GREEN, not a
//! weak check: it also passes when the number was recycled onto an unrelated live
//! process, and it passes when the number was recycled onto a process that is
//! very much alive. Every liveness question here is asked of a
//! `(pid, creation_time)` pair, and
//! [`the_creation_time_half_of_an_identity_is_load_bearing`] proves the second
//! half actually discriminates rather than being carried along for decoration.
//!
//! # WHAT THIS FILE OWNS OF WIN32, AND WHY IT IS EXACTLY ONE CALL
//!
//! `OpenProcess` only. The core deliberately has NO open-by-PID — lifecycle.rs
//! states the reason, which is the very PID reuse above — so the lookup has to be
//! supplied here. Every JUDGEMENT is then delegated to the core's own
//! `SystemWin32`: `creation_time`, `exit_code`, `terminate_process` and
//! `close_handle`. The test supplies the lookup the core withholds and restates
//! none of the authority it keeps (taskRail 5).

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use moe_windows_job_broker::{
    read_frame, AcceptState, Accepted, ByteChannel, ChannelKind, Completion, Inbound, Outcome,
    Session, ShutdownSignal, Stopped, Wiring, PROTOCOL_VERSION,
};
use moe_windows_job_core::{
    CreatedProcess, NativeError, ProcessCalls, ProcessSpec, RawHandle, SystemWin32, WaitOutcome,
    Win32Calls, INHERITED_HANDLE_COUNT, REQUIRED_LIMIT_FLAGS,
};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

/// `GetExitCodeProcess` reports this while a process has not exited. Any other
/// value is a real exit code, so it is the one value that means "still running".
const STILL_ACTIVE: u32 = 259;

/// The host the crate pins, restated here so this file fails by name rather than
/// skipping when it is run somewhere else.
const REQUIRED_NODE: &str = "v24.16.0";
const REQUIRED_PLATFORM: &str = "win32 x64";

/// How long the harness may take to reach each observable milestone.
const REPORT_BOUND: Duration = Duration::from_secs(30);
const DEATH_BOUND: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Cleanup runs while a panic unwinds, so it is bounded far tighter than the
/// assertions: a guard that hung would replace one named failure with none.
const CLEANUP_BOUND: Duration = Duration::from_secs(5);
const CLEANUP_ATTEMPTS: usize = 20;

// ---------------------------------------------------------------------------
// Identity: a pid AND the creation time that disambiguates it
// ---------------------------------------------------------------------------

/// One process, named so that PID reuse cannot impersonate it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    pid: u32,
    creation_time: u64,
}

/// Whether the process an [`Identity`] names is still running.
///
/// `Gone` covers all three ways it can fail to be running, deliberately folded
/// together because the assertion only ever asks the one question: the PID opens
/// nothing, the PID opens a DIFFERENT process (reuse), or it opens ours and it
/// has exited.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Liveness {
    Running,
    Gone,
}

/// Opens a process by PID for querying, or reports that nothing answers.
///
/// THE ONE RAW WIN32 CALL IN THIS FILE. See the module docs for why it cannot be
/// delegated: the core withholds open-by-PID on purpose.
fn open(pid: u32, access: u32) -> Option<RawHandle> {
    // SAFETY: the PID is arbitrary by design — a value naming nothing is the
    // expected result on the dead path, and is reported as a null handle rather
    // than as undefined behaviour.
    let handle: HANDLE = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        return None;
    }
    Some(RawHandle::new(handle as isize))
}

/// Asks the operating system whether this exact process is still running.
fn liveness(calls: &SystemWin32, who: Identity) -> Liveness {
    let Some(handle) = open(who.pid, PROCESS_QUERY_LIMITED_INFORMATION) else {
        return Liveness::Gone;
    };
    let verdict = judge(calls, handle, who);
    let _ = calls.close_handle(handle);
    verdict
}

/// The judgement, with every query delegated to the core.
///
/// THE CREATION-TIME COMPARISON COMES FIRST AND IS NOT OPTIONAL. Without it this
/// function would answer for whatever process currently wears the PID.
fn judge(calls: &SystemWin32, handle: RawHandle, who: Identity) -> Liveness {
    match calls.creation_time(handle) {
        Ok(observed) if observed == who.creation_time => {}
        _ => return Liveness::Gone,
    }
    match calls.exit_code(handle) {
        Ok(STILL_ACTIVE) => Liveness::Running,
        _ => Liveness::Gone,
    }
}

/// Kills exactly the process an identity names, and nothing else.
///
/// The creation time is re-checked against the open handle before terminating,
/// so a PID recycled since the identity was recorded is left alone. The same
/// rail the assertions follow applies here, where getting it wrong would kill an
/// unrelated process on a real machine.
fn terminate(calls: &SystemWin32, who: Identity) {
    let Some(handle) = open(who.pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION) else {
        return;
    };
    if calls.creation_time(handle) == Ok(who.creation_time) {
        let _ = calls.terminate_process(handle);
    }
    let _ = calls.close_handle(handle);
}

/// Waits for an identity to stop running, or gives up.
fn await_death(calls: &SystemWin32, who: Identity, bound: Duration) -> Liveness {
    let deadline = Instant::now() + bound;
    loop {
        let now = liveness(calls, who);
        if now == Liveness::Gone || Instant::now() >= deadline {
            return now;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

// ---------------------------------------------------------------------------
// Cleanup that survives a panic
// ---------------------------------------------------------------------------

/// Kills anything the harness may have left running, on EVERY exit path.
///
/// A detached grandchild that outlives a panicking test is a stray process on
/// the developer's host, and the whole point of that binary is that an ordinary
/// teardown misses it. `Drop` runs while a panic unwinds, so an assertion
/// failure cleans up exactly as a pass does.
///
/// IT REFUSES TO KILL A STRANGER. Each identity's creation time is re-checked
/// against the open handle before terminating, so a PID recycled between the
/// report and the cleanup is left alone. The same rail the assertions follow
/// applies to the cleanup, where getting it wrong would kill an unrelated
/// process on a real machine.
struct Reaper {
    node: Option<Child>,
    identities: Vec<Identity>,
    directory: PathBuf,
}

impl Reaper {
    fn new(directory: PathBuf) -> Self {
        Self { node: None, identities: Vec::new(), directory }
    }
}

impl Drop for Reaper {
    fn drop(&mut self) {
        if let Some(node) = self.node.as_mut() {
            let _ = node.kill();
            let _ = node.wait();
        }
        let calls = SystemWin32;
        for who in &self.identities {
            terminate(&calls, *who);
        }
        // TERMINATION IS ASYNCHRONOUS: `TerminateProcess` returns before the
        // process is gone. Removing the directory first can therefore fail
        // against a process that has not finished exiting, and `remove_dir_all`
        // reports that by returning an error nobody reads — leaving a workspace
        // behind on exactly the panic path this guard exists for.
        for who in &self.identities {
            let _ = await_death(&calls, *who, CLEANUP_BOUND);
        }
        for _ in 0..CLEANUP_ATTEMPTS {
            if std::fs::remove_dir_all(&self.directory).is_ok() || !self.directory.exists() {
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

// ---------------------------------------------------------------------------
// DoD 2 — the forcible kill, against the real broker
// ---------------------------------------------------------------------------

#[test]
fn killing_the_broker_kills_its_provider_and_the_provider_s_detached_grandchild() {
    require_node();
    let calls = SystemWin32;
    let workspace = workspace("containment");
    let report = workspace.join("identities.txt");
    let go = workspace.join("go");
    let broker_pid = workspace.join("broker.pid");
    let mut reaper = Reaper::new(workspace.clone());

    reaper.node = Some(start_harness(&report, &go, &broker_pid));

    // RECORDED BEFORE ANYTHING CAN FAIL, so every later panic path can reap it.
    let broker = await_broker_identity(&broker_pid, &calls);
    reaper.identities = vec![broker];

    let text = await_report(&report, reaper.node.as_mut());
    let parent = parse_identity(&text, "parent");
    let grandchild = parse_identity(&text, "grandchild");
    reaper.identities = vec![broker, parent, grandchild];

    // THE POSITIVE CONTROL. Without it "both are dead" is satisfied by a
    // provider that never started and a grandchild that was never spawned, and
    // the whole test would pass while proving nothing.
    assert_eq!(liveness(&calls, broker), Liveness::Running, "the broker never ran");
    assert_eq!(liveness(&calls, parent), Liveness::Running, "the provider never ran");
    assert_eq!(
        liveness(&calls, grandchild),
        Liveness::Running,
        "the detached grandchild never ran, so nothing was there to contain"
    );
    assert_ne!(parent.pid, grandchild.pid, "the report described one process twice");

    // Releases the harness to forcibly terminate the broker.
    std::fs::write(&go, b"go").expect("the go file must be writable");
    let node = reaper.node.take().expect("the harness was started above");
    let harness = await_harness(node, DEATH_BOUND);
    let out = String::from_utf8_lossy(&harness.stdout).into_owned();
    assert!(harness.status.success(), "the node harness itself failed: {out}");
    assert!(out.contains("killed=true"), "the harness never killed the broker: {out}");

    // THE KILL LANDED. Without this the two assertions below could be satisfied
    // by a broker that exited on its own, which is a different property.
    assert_eq!(
        await_death(&calls, broker, DEATH_BOUND),
        Liveness::Gone,
        "the broker survived being forcibly terminated"
    );

    // BOTH, and the grandchild is the one that matters: it is detached from the
    // console, the process group, every inherited handle and its parent's
    // lifetime. Only Job membership could have reached it.
    assert_eq!(
        await_death(&calls, parent, DEATH_BOUND),
        Liveness::Gone,
        "the provider outlived the broker that owned its Job"
    );
    assert_eq!(
        await_death(&calls, grandchild, DEATH_BOUND),
        Liveness::Gone,
        "the DETACHED GRANDCHILD was stranded: closing the last Job handle did not reach it"
    );
}

/// Proves the identity check is not PID-only, which is the entire content of
/// taskRail 1.
///
/// A live process is asked about twice: once with its real creation time and
/// once with that value perturbed by a single bit. If the creation time were
/// ignored — the defect the rail names — both answers would be `Running` and the
/// containment assertions above could report a recycled PID as the dead process.
#[test]
fn the_creation_time_half_of_an_identity_is_load_bearing() {
    let calls = SystemWin32;
    let handle = open(std::process::id(), PROCESS_QUERY_LIMITED_INFORMATION)
        .expect("this process can always be opened by its own pid");
    let creation_time =
        calls.creation_time(handle).expect("this process always has a creation time");
    let _ = calls.close_handle(handle);
    let real = Identity { pid: std::process::id(), creation_time };

    assert_eq!(liveness(&calls, real), Liveness::Running, "this test process is running");
    assert_eq!(
        liveness(&calls, Identity { creation_time: creation_time ^ 1, ..real }),
        Liveness::Gone,
        "a matching pid with a different creation time was accepted as the same process"
    );
}

/// THE PREMISE THE GRANDCHILD ASSERTION RESTS ON, asserted directly instead of
/// being left to be inferred.
///
/// `killing_the_broker_kills_..._detached_grandchild` is only evidence of
/// CONTAINMENT if an ordinary teardown would have MISSED the grandchild. If
/// killing the provider also killed it — as it would on a platform with process
/// trees, or if the fixture stopped passing `DETACHED_PROCESS` — that test would
/// keep passing while proving nothing about the Job at all, which is exactly the
/// silent-detachment failure this file cannot afford.
///
/// So: no broker and no Job here. The provider is spawned directly, the provider
/// alone is terminated, and the grandchild must SURVIVE.
#[test]
fn killing_only_the_provider_leaves_its_detached_grandchild_running() {
    let calls = SystemWin32;
    let workspace = workspace("detachment");
    let report = workspace.join("identities.txt");
    let mut reaper = Reaper::new(workspace.clone());

    let spawner = Command::new(provider_binary())
        .arg(&report)
        .spawn()
        .expect("the provider fixture must be runnable on its own");
    reaper.node = Some(spawner);

    let text = await_report(&report, reaper.node.as_mut());
    let parent = parse_identity(&text, "parent");
    let grandchild = parse_identity(&text, "grandchild");
    reaper.identities = vec![parent, grandchild];

    assert_eq!(liveness(&calls, parent), Liveness::Running, "the provider never ran");
    assert_eq!(liveness(&calls, grandchild), Liveness::Running, "the grandchild never ran");

    // ONLY the provider. Nothing here touches the grandchild.
    terminate(&calls, parent);
    assert_eq!(
        await_death(&calls, parent, DEATH_BOUND),
        Liveness::Gone,
        "the provider survived being terminated directly"
    );

    // THE POINT: an ordinary kill of the process that created it does not reach
    // it, so only Job membership could have in the containment test above.
    assert_eq!(
        liveness(&calls, grandchild),
        Liveness::Running,
        "the grandchild died with its parent, so it was never detached and the \
         containment proof would be measuring ordinary parent-child cleanup"
    );
}

// ---------------------------------------------------------------------------
// DoD 3 — the controlled paths, read from a call log rather than from the OS
// ---------------------------------------------------------------------------

#[test]
fn ordinary_completion_observes_an_empty_job_without_terminating_it() {
    let calls = ScriptedCalls::new(vec![WaitOutcome::Signalled]);
    let outcome = run_controlled(&calls, &[], 10_000);

    assert!(
        matches!(outcome, Outcome::Ran(Stopped::Natural, Completion::Completed(_))),
        "the ordinary path must reach a natural, observed completion"
    );
    // THE EVIDENCE: the Job was ASKED, and the last answer was zero.
    assert_eq!(
        calls.accounting_answers(),
        vec![0],
        "ordinary completion must observe ActiveProcesses == 0 before returning"
    );
    // AND IT GOT THERE WITHOUT KILLING ANYTHING. This is what distinguishes an
    // ordinary completion from a teardown that also happens to empty the Job.
    assert_eq!(
        calls.count("terminate-job"),
        0,
        "ordinary completion terminated the Job instead of observing it empty"
    );
}

#[test]
fn cancel_terminates_and_then_still_observes_an_empty_job() {
    let calls = ScriptedCalls::new(vec![WaitOutcome::TimedOut, WaitOutcome::Signalled]);
    let outcome = run_controlled(&calls, &cancel_frame(), 10_000);

    assert!(
        matches!(outcome, Outcome::Ran(Stopped::Cancelled, Completion::Completed(_))),
        "the cancel path must reach a cancelled, observed completion"
    );
    assert_eq!(
        calls.count("terminate-job"),
        1,
        "cancel must terminate the Job exactly once"
    );
    // ASSERTED IN ITS OWN RIGHT, not inferred from the terminate above:
    // terminating a Job returns BEFORE its processes are gone, so a cancel that
    // stopped at the terminate would have proved nothing about emptiness.
    assert_eq!(
        calls.accounting_answers(),
        vec![0],
        "cancel must observe ActiveProcesses == 0 before returning"
    );
}

// ---------------------------------------------------------------------------
// DoD 4 — the confused deputy
// ---------------------------------------------------------------------------

/// Provider bytes that ARE a well-formed control frame never reach control.
///
/// The four assertions are ordered so that each one closes a way the next could
/// pass for the wrong reason.
#[test]
fn provider_bytes_that_are_a_valid_control_frame_never_reach_the_control_path() {
    let hostile = cancel_frame();

    // 1. THEY REALLY ARE A CONTROL FRAME, proved through the production decoder
    //    and the production accept state machine rather than asserted. Without
    //    this the test could be shipping bytes that no control path could ever
    //    have obeyed, which would make everything below unimpressive.
    assert!(
        would_be_obeyed_on_fd0(&hostile),
        "the hostile bytes are not a frame the control path would have obeyed, \
         so this proves nothing about separation"
    );

    // THE SESSION MUST ACTUALLY BE POLLING fd0 WHILE THE HOSTILE BYTES SIT ON
    // fd4 AND fd5. A first wait that returned `Signalled` would end the run
    // before the control loop ran even once, and the test would be asserting
    // separation against a broker that never went looking for an instruction.
    // TimedOut-then-Signalled makes it read fd0 (finding it empty, hence
    // `ControlEnded`) and still reach the provider drain afterwards.
    let calls = ScriptedCalls::new(vec![WaitOutcome::TimedOut, WaitOutcome::Signalled]);
    let (outcome, wires) = run_session(&calls, &[], &hostile, 10_000);

    // 2. THEY ENTERED THE BROKER. If the provider channels were never read, "the
    //    bytes never reached control" would be true of bytes that never went
    //    anywhere at all — the vacuous pass this file has to rule out.
    assert_eq!(
        Tape::consumed(&wires.provider_out),
        hostile,
        "fd4 was never read, so nothing was actually offered to the broker"
    );
    assert_eq!(
        Tape::consumed(&wires.provider_err),
        hostile,
        "fd5 was never read, so nothing was actually offered to the broker"
    );

    // 3. THE ASSERTION DoD 4 NAMES: on the control path's RECORDED INPUT. The
    //    control path read exactly the legitimate launch frame and not one byte
    //    of what arrived on fd4 or fd5.
    let control = Tape::consumed(&wires.control);
    assert!(
        !contains(&control, &hostile),
        "provider bytes appeared in what the control path read"
    );
    assert_eq!(
        control,
        a_launch_frame(),
        "the control path consumed something other than exactly the launch it was sent"
    );

    // 4. AND THE RUN WAS NOT HIJACKED. fd0 was empty when the session looked, so
    //    the only cancel frame in the entire process was the one on fd4 and fd5.
    //    A run that ends `Cancelled` here obeyed a provider.
    assert!(
        matches!(outcome, Outcome::Ran(Stopped::ControlEnded, Completion::Completed(_))),
        "the run ended as {outcome:?} rather than on an empty fd0, so a provider frame steered it"
    );
}

/// No provider byte can influence what fd1 says.
///
/// PROVED BY COMPARISON, NOT BY EXPECTATION. Asserting "no unexpected status
/// frame" passes against a broker that parsed the provider bytes and happened to
/// emit the same thing. Running the identical session twice — once with the
/// hostile bytes on fd4 and fd5, once with those channels empty — and requiring
/// the two fd1 streams to be BYTE-IDENTICAL leaves no room for an influence that
/// merely looks acceptable.
#[test]
fn provider_bytes_cannot_influence_any_status_frame() {
    let hostile = cancel_frame();

    let clean = ScriptedCalls::new(vec![WaitOutcome::Signalled]);
    let (_, without) = run_session(&clean, &[], &[], 10_000);

    let noisy = ScriptedCalls::new(vec![WaitOutcome::Signalled]);
    let (_, with) = run_session(&noisy, &[], &hostile, 10_000);

    let quiet = Tape::written(&without.status);
    let loud = Tape::written(&with.status);

    // The premise: fd1 actually carried something, or two empty streams would
    // match trivially.
    assert!(!quiet.is_empty(), "fd1 carried no frames at all, so equality is vacuous");
    assert_eq!(loud, quiet, "provider bytes changed what fd1 reported");
    assert!(
        !contains(&loud, &hostile),
        "the hostile frame was echoed onto fd1"
    );
    assert_eq!(
        Tape::written(&with.diagnostics),
        Tape::written(&without.diagnostics),
        "provider bytes changed what fd2 reported"
    );
}

/// Decodes bytes through the PRODUCTION control path and reports whether the
/// state machine would have acted on them after a legitimate launch.
fn would_be_obeyed_on_fd0(candidate: &[u8]) -> bool {
    let mut stream = a_launch_frame();
    stream.extend_from_slice(candidate);
    let tape = Tape::holding(&stream);
    let mut channel = Recorder::over(&tape);
    let mut accept = AcceptState::new();

    let launch = read_frame(&mut channel, ChannelKind::Control).expect("the launch frame parses");
    accept.accept(&launch).expect("a legitimate launch is accepted");

    let Ok(frame) = read_frame(&mut channel, ChannelKind::Control) else {
        return false;
    };
    matches!(accept.accept(&frame), Ok(Accepted::Cancel))
}

// ---------------------------------------------------------------------------
// The node harness: six real pipes, and a kill on cue
// ---------------------------------------------------------------------------

/// Spawns Node holding the other end of the broker's six pipes.
///
/// NODE CARRIES NO PROTOCOL KNOWLEDGE. The launch frame is built in Rust from
/// this crate's own opcode and version constants and handed over as hex, so the
/// bytes on fd0 come from the production vocabulary rather than from a second
/// encoder written in JavaScript that could drift from it.
///
/// fd0 IS HELD OPEN AND SILENT AFTER THE LAUNCH, deliberately: that is what
/// parks the broker in its run loop holding the Job, which is the state the kill
/// has to interrupt.
fn start_harness(report: &Path, go: &Path, broker_pid: &Path) -> Child {
    let script = r#"
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appear = async (path, bound) => {
  const deadline = Date.now() + bound;
  while (Date.now() < deadline) {
    if (fs.existsSync(path)) return true;
    await sleep(25);
  }
  return false;
};
(async () => {
  const child = spawn(process.env.MOE_BROKER_EXE, [], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.on('exit', (c, s) => r(`${c}/${s}`)));
  // PUBLISH THE PID OR KILL WHAT WE CANNOT NAME. If this write fails the Rust
  // side never learns the broker's identity, so its reaper cannot terminate it
  // and a parked broker would hold its Job for the full launch timeout.
  try {
    fs.writeFileSync(process.env.MOE_BROKER_PID + '.partial', String(child.pid));
    fs.renameSync(process.env.MOE_BROKER_PID + '.partial', process.env.MOE_BROKER_PID);
  } catch (error) {
    process.stdout.write('pid-publish-failed=' + error.message + '\n');
    child.kill('SIGKILL');
    process.exit(5);
  }
  for (const stream of child.stdio) {
    if (stream && typeof stream.resume === 'function') stream.resume();
  }
  child.stdin.write(Buffer.from(process.env.MOE_LAUNCH_FRAME, 'hex'));
  if (!(await appear(process.env.MOE_REPORT, 30000))) {
    process.stdout.write('report=missing\n');
    child.kill('SIGKILL');
    process.exit(3);
  }
  if (!(await appear(process.env.MOE_GO, 60000))) {
    process.stdout.write('go=missing\n');
    child.kill('SIGKILL');
    process.exit(4);
  }
  const killed = child.kill('SIGKILL');
  process.stdout.write('killed=' + killed + '\n');
  process.stdout.write('broker-exit=' + (await exited) + '\n');
  process.exit(0);
})();
"#;

    Command::new("node")
        .args(["-e", script])
        .env("MOE_BROKER_EXE", broker_binary())
        .env("MOE_PROVIDER_EXE", provider_binary())
        .env("MOE_REPORT", report)
        .env("MOE_GO", go)
        .env("MOE_BROKER_PID", broker_pid)
        .env("MOE_LAUNCH_FRAME", hex(&launch_frame(&provider_binary(), report)))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("node must be runnable to hold the broker's six pipes")
}

/// Waits for the harness to finish, or FAILS BY NAME rather than hanging.
///
/// THIS BOUND WAS FOUND BY A DRILL, NOT BY DESIGN. With the harness's kill
/// removed, the broker stayed alive, so Node stayed alive awaiting its exit, and
/// an unbounded `wait_with_output` blocked the whole test forever instead of
/// reporting a fault. A hang is the one failure mode that never names itself and
/// never goes red — it just consumes the run — so the bound is not defensive
/// decoration, it is what makes the containment assertions reachable at all.
///
/// Killing the harness does NOT reach the broker, which is Node's child and not
/// ours; the caller's [`Reaper`] holds every identity that needs terminating.
fn await_harness(mut harness: Child, bound: Duration) -> std::process::Output {
    let deadline = Instant::now() + bound;
    loop {
        match harness.try_wait() {
            Ok(Some(_)) => {
                return harness.wait_with_output().expect("an exited harness has readable output")
            }
            Ok(None) => {}
            Err(error) => panic!("the node harness could not be waited on: {error}"),
        }
        if Instant::now() >= deadline {
            let _ = harness.kill();
            let _ = harness.wait();
            panic!("the node harness never finished within {bound:?}, so the broker was never killed");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Reads the broker's own identity, so the kill target is named and reapable.
///
/// The PID comes from Node, which is the only party that knows it; the creation
/// time is read HERE from the live handle. Recording it before the kill is what
/// lets the reaper clean up the broker on a failure path, and lets the test
/// assert the broker itself actually died rather than assuming it.
fn await_broker_identity(pid_path: &Path, calls: &SystemWin32) -> Identity {
    let deadline = Instant::now() + REPORT_BOUND;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(pid_path) {
            if let Ok(pid) = text.trim().parse::<u32>() {
                let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
                    .expect("the broker must still be open when its pid is published");
                let creation_time =
                    calls.creation_time(handle).expect("a live process has a creation time");
                let _ = calls.close_handle(handle);
                return Identity { pid, creation_time };
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    panic!("the harness never published the broker's pid within {REPORT_BOUND:?}");
}

/// Blocks until the provider publishes both identities.
///
/// FAILS BY NAME rather than hanging, and the harness's own output is folded in
/// so a Node-side failure is reported as itself instead of as a timeout.
fn await_report(report: &Path, mut harness: Option<&mut Child>) -> String {
    let deadline = Instant::now() + REPORT_BOUND;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(report) {
            if text.contains("grandchild") {
                return text;
            }
        }
        if let Some(process) = harness.as_mut() {
            if let Ok(Some(status)) = process.try_wait() {
                panic!("the harness exited early with {status} before publishing identities");
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    panic!("the provider never published its identities within {REPORT_BOUND:?}");
}

/// Reads one `<name> <pid> <creation_time>` line.
fn parse_identity(text: &str, name: &str) -> Identity {
    let line = text
        .lines()
        .find(|line| line.starts_with(name))
        .unwrap_or_else(|| panic!("the report has no {name} line: {text:?}"));
    let mut fields = line.split_whitespace().skip(1);
    let mut next = |what: &str| {
        fields
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_else(|| panic!("the {name} line has no {what}: {line:?}"))
    };
    let pid = u32::try_from(next("pid")).expect("a pid always fits in u32");
    Identity { pid, creation_time: next("creation time") }
}

/// Refuses to run against anything but the pinned host.
///
/// Every branch PANICS rather than returning, so no missing prerequisite can
/// turn into a green test (taskRail 6).
fn require_node() {
    let version = Command::new("node")
        .arg("--version")
        .output()
        .expect("node must be on PATH: this test cannot be satisfied without it");
    let version = String::from_utf8_lossy(&version.stdout).trim().to_owned();
    assert_eq!(version, REQUIRED_NODE, "the crate pins Node {REQUIRED_NODE}, found {version}");

    let platform = Command::new("node")
        .args(["-p", "process.platform + ' ' + process.arch"])
        .output()
        .expect("node must report its platform");
    let platform = String::from_utf8_lossy(&platform.stdout).trim().to_owned();
    assert_eq!(platform, REQUIRED_PLATFORM, "the crate pins {REQUIRED_PLATFORM}, found {platform}");
}

fn broker_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_moe-windows-job-broker"))
}

fn provider_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_detached_spawner"))
}

/// A fresh directory under the target tree, so nothing lands in the repository.
fn workspace(name: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_BIN_EXE_moe-windows-job-broker"))
        .parent()
        .expect("a cargo binary always sits inside the target directory")
        .join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("the workspace directory must be creatable");
    root
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Frames, built from the production vocabulary
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

/// executable, argv, cwd, environment — the order `decode_launch` consumes.
fn launch_frame(executable: &Path, report: &Path) -> Vec<u8> {
    let mut payload = text(&executable.to_string_lossy());
    payload.extend_from_slice(&1u16.to_le_bytes());
    payload.extend_from_slice(&text(&report.to_string_lossy()));
    payload.extend_from_slice(&text(
        &executable.parent().expect("a binary always has a directory").to_string_lossy(),
    ));
    payload.extend_from_slice(&0u16.to_le_bytes());
    frame(Inbound::Launch.opcode(), &payload)
}

fn cancel_frame() -> Vec<u8> {
    frame(Inbound::Cancel.opcode(), &[])
}

fn a_launch_frame() -> Vec<u8> {
    let mut payload = text("C:\\Windows\\System32\\PING.EXE");
    payload.extend_from_slice(&0u16.to_le_bytes());
    payload.extend_from_slice(&text("C:\\Windows\\Temp"));
    payload.extend_from_slice(&0u16.to_le_bytes());
    frame(Inbound::Launch.opcode(), &payload)
}

// ---------------------------------------------------------------------------
// The scripted boundary for the controlled paths
// ---------------------------------------------------------------------------

/// One channel's bytes, plus what the READER actually took from it.
///
/// `consumed` is the field DoD 4 turns on: proving a byte never reached the
/// control path requires knowing what the control path READ, which no assertion
/// about the session's output can supply.
#[derive(Default)]
struct Tape {
    pending: Vec<u8>,
    read_at: usize,
    consumed: Vec<u8>,
    written: Vec<u8>,
}

impl Tape {
    fn holding(bytes: &[u8]) -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self { pending: bytes.to_vec(), ..Self::default() }))
    }

    fn consumed(tape: &Arc<Mutex<Self>>) -> Vec<u8> {
        tape.lock().expect("a tape lock is never poisoned").consumed.clone()
    }

    fn written(tape: &Arc<Mutex<Self>>) -> Vec<u8> {
        tape.lock().expect("a tape lock is never poisoned").written.clone()
    }
}

/// A [`ByteChannel`] that records both directions onto a shared [`Tape`].
struct Recorder {
    tape: Arc<Mutex<Tape>>,
}

impl Recorder {
    fn over(tape: &Arc<Mutex<Tape>>) -> Self {
        Self { tape: Arc::clone(tape) }
    }
}

impl ByteChannel for Recorder {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, u32> {
        let mut tape = self.tape.lock().expect("a tape lock is never poisoned");
        let available = tape.pending.len() - tape.read_at;
        let take = available.min(buffer.len());
        let from = tape.read_at;
        buffer[..take].copy_from_slice(&tape.pending[from..from + take]);
        tape.read_at += take;
        let taken = buffer[..take].to_vec();
        tape.consumed.extend_from_slice(&taken);
        Ok(take)
    }

    fn write(&mut self, bytes: &[u8]) -> Result<usize, u32> {
        self.tape.lock().expect("a tape lock is never poisoned").written.extend_from_slice(bytes);
        Ok(bytes.len())
    }
}

/// Every channel of one run, kept so each can be interrogated afterwards.
struct Wires {
    control: Arc<Mutex<Tape>>,
    status: Arc<Mutex<Tape>>,
    diagnostics: Arc<Mutex<Tape>>,
    provider_out: Arc<Mutex<Tape>>,
    provider_err: Arc<Mutex<Tape>>,
}

impl Wires {
    fn new(control: &[u8], provider: &[u8]) -> Self {
        Self {
            control: Tape::holding(control),
            status: Tape::holding(&[]),
            diagnostics: Tape::holding(&[]),
            provider_out: Tape::holding(provider),
            provider_err: Tape::holding(provider),
        }
    }

    fn wiring(&self) -> Wiring<Recorder> {
        Wiring {
            control: Recorder::over(&self.control),
            status: Recorder::over(&self.status),
            diagnostics: Recorder::over(&self.diagnostics),
            provider_out: Recorder::over(&self.provider_out),
            provider_err: Recorder::over(&self.provider_err),
        }
    }
}

/// Whether `haystack` contains `needle` anywhere in it.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

/// Records every boundary call, and answers accounting with a scripted poll.
struct ScriptedCalls {
    log: std::cell::RefCell<Vec<&'static str>>,
    accounting: std::cell::RefCell<Vec<u32>>,
    answers: std::cell::RefCell<Vec<u32>>,
    waits: std::cell::RefCell<Vec<WaitOutcome>>,
    next_handle: std::cell::Cell<isize>,
}

impl ScriptedCalls {
    /// The accounting script is 2 then 0, so `wait_until_job_is_empty` must POLL
    /// to reach zero. A single-sample implementation would report an empty Job
    /// on the first answer, which is exactly the defect the core's poll exists
    /// to avoid, and the recorded answers would then not end in 0.
    fn new(waits: Vec<WaitOutcome>) -> Self {
        Self {
            log: std::cell::RefCell::new(Vec::new()),
            accounting: std::cell::RefCell::new(vec![2, 0]),
            answers: std::cell::RefCell::new(Vec::new()),
            waits: std::cell::RefCell::new(waits),
            next_handle: std::cell::Cell::new(0x2000),
        }
    }

    fn arm(&self, name: &'static str) -> Result<(), NativeError> {
        self.log.borrow_mut().push(name);
        Ok(())
    }

    fn hand_out(&self) -> RawHandle {
        let value = self.next_handle.get();
        self.next_handle.set(value + 1);
        RawHandle::new(value)
    }

    fn count(&self, name: &str) -> usize {
        self.log.borrow().iter().filter(|entry| **entry == name).count()
    }

    /// Every accounting value the Job actually reported, in order, with the
    /// non-zero polls dropped — what remains is what the session OBSERVED as the
    /// settled answer. An empty vector means it never asked at all.
    fn accounting_answers(&self) -> Vec<u32> {
        self.answers.borrow().iter().copied().filter(|value| *value == 0).collect()
    }
}

impl Win32Calls for ScriptedCalls {
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
        let mut script = self.accounting.borrow_mut();
        let answer = if script.len() > 1 { script.remove(0) } else { *script.first().unwrap_or(&0) };
        self.answers.borrow_mut().push(answer);
        Ok(answer)
    }

    fn close_handle(&self, _handle: RawHandle) -> Result<(), NativeError> {
        self.arm("close")
    }
}

impl ProcessCalls for ScriptedCalls {
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
        _handles: [RawHandle; INHERITED_HANDLE_COUNT],
    ) -> Result<(), NativeError> {
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
        Ok(4_242)
    }

    fn creation_time(&self, _process: RawHandle) -> Result<u64, NativeError> {
        self.arm("creation-time")?;
        Ok(0x01DB_0000_0000_0007)
    }

    fn resume_thread(&self, _thread: RawHandle) -> Result<u32, NativeError> {
        self.arm("resume")?;
        Ok(1)
    }

    fn wait_for_process(&self, _p: RawHandle, _timeout: u32) -> Result<WaitOutcome, NativeError> {
        self.arm("wait")?;
        let mut waits = self.waits.borrow_mut();
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

/// Never asks the session to stop.
struct RunToCompletion;

impl ShutdownSignal for RunToCompletion {
    fn requested(&self) -> bool {
        false
    }
}

/// fd3, fd4 and fd5 — the provider trio the child would inherit.
const PROVIDERS: [RawHandle; INHERITED_HANDLE_COUNT] =
    [RawHandle::new(0x33), RawHandle::new(0x34), RawHandle::new(0x35)];

/// Runs one session: a launch, whatever else fd0 holds, and provider bytes on
/// BOTH fd4 and fd5.
fn run_session(
    calls: &ScriptedCalls,
    after_launch: &[u8],
    provider: &[u8],
    timeout_ms: u32,
) -> (Outcome, Wires) {
    let mut control = a_launch_frame();
    control.extend_from_slice(after_launch);
    let wires = Wires::new(&control, provider);
    let mut wiring = wires.wiring();
    let outcome = Session::new(calls, PROVIDERS, timeout_ms).run(&mut wiring, &RunToCompletion);
    (outcome, wires)
}

/// Runs one controlled session with nothing on the provider channels.
fn run_controlled(calls: &ScriptedCalls, after_launch: &[u8], timeout_ms: u32) -> Outcome {
    run_session(calls, after_launch, &[], timeout_ms).0
}
