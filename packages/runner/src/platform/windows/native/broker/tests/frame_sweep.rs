//! The hostile-frame sweep: every malformed, truncated, reordered, duplicate,
//! extra and over-limit frame the broker's wire protocol can be handed, each
//! refused with its OWN stable reason code and at a pinned layer.
//!
//! PURE. No pipe, no process, no Job, no Windows. Every test drives the shipped
//! codec over a scripted byte channel, so short reads, partial writes and
//! channel failures are all reachable without an operating system.
//!
//! WHY THE CHANNEL IS SCRIPTED RATHER THAN A `Cursor`. A real pipe hands back
//! short reads and accepts short writes, and a codec that silently assumed
//! otherwise would pass against `Cursor` and corrupt frames in production. The
//! double serves bytes in configurable chunks precisely so that assumption
//! cannot survive.

use core::task::Poll;
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};

use moe_windows_job_broker::{
    parse_descriptor_block, read_frame, write_frame, AcceptState, Accepted, ByteChannel,
    ChannelKind, Completed, Diagnostic, DiagnosticNote, Inbound, Outbound, ProtocolError,
    ProtocolReason, ProtocolStage, RefusalLayer, Refused, Started, Status, FRAME_HEADER_BYTES,
    PROTOCOL_VERSION,
};
use moe_windows_job_core::{NativeError, NativeOp, UnknownExit};

/// Bytes handed out by the allocator since this binary started.
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

/// Counts every allocation and then delegates.
///
/// WHY THIS EXISTS. DoD 2 requires an over-limit frame to be refused WITHOUT
/// allocating to its declared size, and "how many bytes did the channel serve"
/// cannot show that: a codec that sized a buffer from the declaration and only
/// THEN bounds-checked reads nothing extra and returns the right reason, so it
/// passes every other assertion here while committing four gigabytes. Counting
/// the allocator is the only way to assert the thing the DoD actually asks for.
struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATED.fetch_add(new_size, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static COUNTING_ALLOCATOR: Counting = Counting;

/// A byte channel with a written script: exact bytes in, chunk sizes for both
/// directions, injectable failures, and a record of every byte written.
struct Scripted {
    inbound: Vec<u8>,
    read_at: usize,
    read_chunk: usize,
    write_chunk: usize,
    read_error: Option<u32>,
    write_error: Option<u32>,
    written: Vec<u8>,
}

impl Scripted {
    /// Serves `inbound` in one piece per read.
    fn serving(inbound: Vec<u8>) -> Self {
        Self {
            inbound,
            read_at: 0,
            read_chunk: usize::MAX,
            write_chunk: usize::MAX,
            read_error: None,
            write_error: None,
            written: Vec::new(),
        }
    }

    /// Serves at most `chunk` bytes per read — a real pipe's short read.
    fn in_chunks_of(mut self, chunk: usize) -> Self {
        self.read_chunk = chunk;
        self
    }

    /// Accepts at most `chunk` bytes per write — a real pipe's partial write.
    fn accepting_writes_of(mut self, chunk: usize) -> Self {
        self.write_chunk = chunk;
        self
    }

    fn failing_reads_with(mut self, code: u32) -> Self {
        self.read_error = Some(code);
        self
    }

    fn failing_writes_with(mut self, code: u32) -> Self {
        self.write_error = Some(code);
        self
    }

    /// How many bytes the codec actually pulled.
    ///
    /// THE OVER-LIMIT PROOF LEANS ON THIS. A codec that allocated to a declared
    /// length before bounding it would also have tried to READ that many bytes;
    /// pinning the count to the header size proves the refusal happened before
    /// either.
    fn bytes_read(&self) -> usize {
        self.read_at
    }
}

impl ByteChannel for Scripted {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, u32> {
        if let Some(code) = self.read_error {
            return Err(code);
        }
        let available = self.inbound.len() - self.read_at;
        let take = available.min(buffer.len()).min(self.read_chunk);
        buffer[..take].copy_from_slice(&self.inbound[self.read_at..self.read_at + take]);
        self.read_at += take;
        Ok(take)
    }

    /// A prepared script has no waiting in it: every byte this channel will ever
    /// hold is there from the start, so readiness answers exactly what `read`
    /// answers and a drained script is an end of stream rather than a silent open
    /// channel. This file sweeps the BLOCKING decoder; the method is here because
    /// the trait requires it of every channel.
    fn poll_read(&mut self, buffer: &mut [u8]) -> Result<Poll<usize>, u32> {
        self.read(buffer).map(Poll::Ready)
    }

    fn write(&mut self, bytes: &[u8]) -> Result<usize, u32> {
        if let Some(code) = self.write_error {
            return Err(code);
        }
        let take = bytes.len().min(self.write_chunk);
        self.written.extend_from_slice(&bytes[..take]);
        Ok(take)
    }
}

/// A frame header, built by hand so the tests state the wire layout rather than
/// asking the encoder what it happens to emit.
fn header(version: u8, opcode: u8, declared: u32) -> Vec<u8> {
    let mut bytes = vec![version, opcode];
    bytes.extend_from_slice(&declared.to_le_bytes());
    bytes
}

/// A well-formed frame of this version.
fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = header(PROTOCOL_VERSION, opcode, payload.len() as u32);
    bytes.extend_from_slice(payload);
    bytes
}

/// A `u16`-length-prefixed string, written by hand so the tests state the
/// payload layout instead of asking the encoder what it happens to emit.
fn text(value: &str) -> Vec<u8> {
    let mut bytes = (value.len() as u16).to_le_bytes().to_vec();
    bytes.extend_from_slice(value.as_bytes());
    bytes
}

/// A launch payload, also hand-built. This is the independent statement of the
/// format that the production decoder is measured against.
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

fn a_launch_frame() -> Vec<u8> {
    frame(Inbound::Launch.opcode(), &launch_payload("C:\\w\\t.exe", &["--x"], "C:\\w", &[("K", "V")]))
}

fn a_cancel_frame() -> Vec<u8> {
    frame(Inbound::Cancel.opcode(), &[])
}

/// Reads one frame off a scripted channel and offers it to the accept state.
///
/// THE `expect` IS THE LAYER PIN, not convenience. Every caller below is testing
/// a CONTROL refusal, so the framing layer must have ACCEPTED the frame first.
/// Without this the framing layer could start answering these cases and every
/// reason-code assertion would keep passing while testing the wrong subject.
fn offer(state: &mut AcceptState, bytes: Vec<u8>) -> Result<Accepted, ProtocolError> {
    let mut channel = Scripted::serving(bytes);
    let raw = read_frame(&mut channel, ChannelKind::Control)
        .expect("framing must accept this frame: the case under test is a control-layer refusal");
    state.accept(&raw)
}

#[track_caller]
fn assert_refused<T>(
    outcome: Result<T, ProtocolError>,
    reason: ProtocolReason,
    stage: ProtocolStage,
) -> ProtocolError {
    match outcome {
        Ok(_) => panic!("expected a refusal with {reason:?}, but a frame was accepted"),
        Err(error) => {
            assert_eq!(error.reason(), reason, "refused, but for the wrong reason");
            // The literal stage, not `reason.stage()` — this pins the mapping
            // table itself, so moving a check between layers reddens here.
            assert_eq!(error.stage(), stage, "refused at the wrong layer");
            error
        }
    }
}

#[test]
fn the_protocol_version_is_frozen_at_one() {
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(FRAME_HEADER_BYTES, 6);
}

#[test]
fn a_declared_length_near_u32_max_is_refused_before_the_payload_is_read() {
    // ~4 GiB declared, six bytes supplied. A codec that sized a buffer from the
    // declaration would attempt that allocation and then read against it; both
    // are excluded below.
    let declared = u32::MAX - 8;
    let mut channel = Scripted::serving(header(PROTOCOL_VERSION, 1, declared));

    let before = ALLOCATED.load(Ordering::Relaxed);
    let outcome = read_frame(&mut channel, ChannelKind::Control);
    let allocated = ALLOCATED.load(Ordering::Relaxed) - before;

    let error = assert_refused(outcome, ProtocolReason::LengthOverLimit, ProtocolStage::Framing);
    assert_eq!(error.code(), 0, "our refusal, not the operating system's");
    assert_eq!(
        channel.bytes_read(),
        FRAME_HEADER_BYTES,
        "the header was read and nothing more: no payload was pulled"
    );
    // THE ALLOCATION BOUND, which is what DoD 2 actually asks for. The counter is
    // process-wide and the suite runs threaded, so this is an upper bound rather
    // than an exact figure: 1 MiB is orders of magnitude above anything any other
    // test in this binary allocates, and four thousand times below the ~4 GiB a
    // codec that trusted the declaration would commit.
    assert!(
        allocated < 1024 * 1024,
        "refusing an over-limit frame allocated {allocated} bytes against a declared {declared}"
    );
}

#[test]
fn a_frame_cut_mid_header_reports_truncated() {
    let mut channel = Scripted::serving(header(PROTOCOL_VERSION, 1, 4)[..3].to_vec());

    let outcome = read_frame(&mut channel, ChannelKind::Control);

    assert_refused(outcome, ProtocolReason::FrameTruncated, ProtocolStage::Framing);
}

#[test]
fn a_frame_cut_mid_payload_reports_truncated() {
    let mut bytes = header(PROTOCOL_VERSION, 1, 8);
    bytes.extend_from_slice(&[7, 7, 7]);
    let mut channel = Scripted::serving(bytes);

    let outcome = read_frame(&mut channel, ChannelKind::Control);

    assert_refused(outcome, ProtocolReason::FrameTruncated, ProtocolStage::Framing);
    assert_eq!(channel.bytes_read(), FRAME_HEADER_BYTES + 3, "every byte offered was consumed");
}

#[test]
fn a_channel_that_is_empty_reports_truncated_rather_than_an_empty_frame() {
    let mut channel = Scripted::serving(Vec::new());

    let outcome = read_frame(&mut channel, ChannelKind::Control);

    assert_refused(outcome, ProtocolReason::FrameTruncated, ProtocolStage::Framing);
}

#[test]
fn a_wrong_version_byte_reports_version_mismatch() {
    let mut channel = Scripted::serving(header(PROTOCOL_VERSION + 1, 1, 0));

    let outcome = read_frame(&mut channel, ChannelKind::Control);

    assert_refused(outcome, ProtocolReason::VersionMismatch, ProtocolStage::Framing);
}

#[test]
fn a_frame_that_is_both_wrong_version_and_over_limit_reports_the_version_reason() {
    // THE ORDERING TRAP. Wrong version, an opcode no vocabulary defines, and a
    // declared length ~4 GiB, all at once. Only a codec that checks the version
    // FIRST can answer VersionMismatch; any other order reports LengthOverLimit
    // or UnknownOpcode and leaves a future re-layout indistinguishable from
    // garbage.
    let mut channel = Scripted::serving(header(PROTOCOL_VERSION + 7, 0xEE, u32::MAX - 8));

    let outcome = read_frame(&mut channel, ChannelKind::Control);

    assert_refused(outcome, ProtocolReason::VersionMismatch, ProtocolStage::Framing);
}

#[test]
fn a_frame_served_one_byte_at_a_time_still_decodes() {
    let mut channel = Scripted::serving(frame(1, b"hello")).in_chunks_of(1);

    let decoded = read_frame(&mut channel, ChannelKind::Control).expect("short reads are not an error");

    assert_eq!(decoded.opcode(), 1);
    assert_eq!(decoded.payload(), b"hello");
}

#[test]
fn a_read_failure_is_reported_as_channel_failed_carrying_its_numeric_code() {
    const ERROR_BROKEN_PIPE: u32 = 109;
    let mut channel = Scripted::serving(frame(1, b"x")).failing_reads_with(ERROR_BROKEN_PIPE);

    let outcome = read_frame(&mut channel, ChannelKind::Control);

    let error = assert_refused(outcome, ProtocolReason::ChannelFailed, ProtocolStage::Framing);
    assert_eq!(error.code(), ERROR_BROKEN_PIPE, "the operating system's code, carried through");
}

#[test]
fn a_write_accepted_in_pieces_still_emits_every_byte_in_order() {
    let mut channel = Scripted::serving(Vec::new()).accepting_writes_of(1);

    write_frame(&mut channel, ChannelKind::Status, 2, b"abcd").expect("partial writes are not an error");

    assert_eq!(channel.written, frame(2, b"abcd"));
}

#[test]
fn a_write_failure_is_reported_as_channel_failed_carrying_its_numeric_code() {
    const ERROR_NO_DATA: u32 = 232;
    let mut channel = Scripted::serving(Vec::new()).failing_writes_with(ERROR_NO_DATA);

    let outcome = write_frame(&mut channel, ChannelKind::Status, 2, b"abcd");

    let error = outcome.expect_err("a failing channel cannot have emitted the frame");
    assert_eq!(error.reason(), ProtocolReason::ChannelFailed);
    assert_eq!(error.code(), ERROR_NO_DATA);
    assert!(channel.written.is_empty(), "nothing may be recorded as sent when the write failed");
}

#[test]
fn writing_a_payload_over_the_channel_cap_is_refused_rather_than_emitted() {
    let oversized = vec![0u8; ChannelKind::Diagnostic.max_payload() + 1];
    let mut channel = Scripted::serving(Vec::new());

    let outcome = write_frame(&mut channel, ChannelKind::Diagnostic, 1, &oversized);

    let error = outcome.expect_err("an over-cap payload must not reach the wire");
    assert_eq!(error.reason(), ProtocolReason::LengthOverLimit);
    assert!(channel.written.is_empty(), "not one byte of an over-cap frame may be emitted");
}

#[test]
fn each_of_the_three_channels_bounds_its_own_frames_at_its_own_cap() {
    // fd0 control, fd1 status, fd2 diagnostics. DoD 2 requires all three bounded,
    // and the caps are deliberately DIFFERENT: a payload legal on fd0 is refused
    // on fd2, which is what proves the cap is per channel rather than global.
    assert_eq!(ChannelKind::ALL.len(), 3);
    let control = ChannelKind::Control.max_payload();
    let diagnostic = ChannelKind::Diagnostic.max_payload();
    assert!(
        diagnostic < ChannelKind::Status.max_payload() && ChannelKind::Status.max_payload() < control,
        "the caps must be strictly ordered fd2 < fd1 < fd0 for the cross-channel case below to mean anything"
    );

    let just_over_diagnostics = u32::try_from(diagnostic + 1).expect("cap fits a u32");
    for kind in ChannelKind::ALL {
        let mut channel = Scripted::serving(header(PROTOCOL_VERSION, 1, just_over_diagnostics));
        let outcome = read_frame(&mut channel, kind);
        if kind == ChannelKind::Diagnostic {
            assert_refused(outcome, ProtocolReason::LengthOverLimit, ProtocolStage::Framing);
            assert_eq!(channel.bytes_read(), FRAME_HEADER_BYTES);
        } else {
            // Under this channel's cap, so it is a truncation, not an over-limit:
            // the length was accepted and the payload simply was not supplied.
            assert_refused(outcome, ProtocolReason::FrameTruncated, ProtocolStage::Framing);
        }
    }
}

#[test]
fn the_inbound_vocabulary_includes_the_curated_project_stack_launch() {
    assert_eq!(Inbound::ALL.len(), 3);
    // Pinned by hand: the opcode bytes are the frozen wire contract, not
    // whatever declaration order happens to produce.
    assert_eq!(Inbound::Launch.opcode(), 1);
    assert_eq!(Inbound::Cancel.opcode(), 2);
    assert!(Inbound::from_opcode(3).is_some(), "opcode 3 must name the locked project launch");
    // No open command space: every other byte maps to nothing at all.
    assert_eq!(Inbound::from_opcode(0), None);
    assert_eq!(Inbound::from_opcode(4), None);
    assert_eq!(Inbound::from_opcode(u8::MAX), None);
    // Every command must be REACHABLE from the wire. Without this, adding a
    // variant would compile (ALL forces the listing, but `from_opcode`'s byte
    // arm does not) and the new command would decode to nothing forever.
    for command in Inbound::ALL {
        assert_eq!(Inbound::from_opcode(command.opcode()), Some(command));
    }
}

#[test]
fn a_launch_frame_decodes_to_every_field_it_carried() {
    let bytes = frame(
        Inbound::Launch.opcode(),
        &launch_payload("C:\\w\\t.exe", &["--a", "--b"], "C:\\w", &[("K", "V"), ("L", "")]),
    );

    let accepted = offer(&mut AcceptState::new(), bytes).expect("a well-formed launch is accepted");

    match accepted {
        Accepted::Cancel => panic!("a launch frame must not decode to a cancel"),
        Accepted::Launch(request) => {
            let argv: Vec<&str> = request.argv().iter().map(String::as_str).collect();
            let environment: Vec<(&str, &str)> =
                request.environment().iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            assert_eq!(request.executable(), "C:\\w\\t.exe");
            assert_eq!(argv, ["--a", "--b"]);
            assert_eq!(request.cwd(), "C:\\w");
            assert_eq!(environment, [("K", "V"), ("L", "")]);
            assert_eq!(request.store_path(), None, "ordinary launch never claims a store lock");
        }
    }
}

#[test]
fn a_project_stack_launch_decodes_its_store_lock_path_before_the_launch() {
    let mut payload = text("C:\\projects\\alpha\\store.sqlite");
    payload.extend_from_slice(&launch_payload(
        "C:\\node.exe",
        &["--experimental-transform-types", "C:\\project-stack-host-main.ts"],
        "C:\\moe",
        &[("MOE_STORE_PATH", "C:\\projects\\alpha\\store.sqlite")],
    ));
    let accepted = offer(&mut AcceptState::new(), frame(3, &payload))
        .expect("the curated project-stack frame is accepted");

    match accepted {
        Accepted::Cancel => panic!("a project launch must not decode to cancel"),
        Accepted::Launch(request) => {
            assert_eq!(request.store_path(), Some("C:\\projects\\alpha\\store.sqlite"));
            assert_eq!(request.executable(), "C:\\node.exe");
            assert_eq!(request.argv().len(), 2);
            assert_eq!(request.environment().len(), 1);
        }
    }
}

#[test]
fn a_project_stack_launch_without_a_complete_store_path_is_refused_in_control() {
    let bytes = frame(3, &[12, 0, b'C', b':', b'\\']);
    let outcome = offer(&mut AcceptState::new(), bytes);

    assert_refused(outcome, ProtocolReason::PayloadMalformed, ProtocolStage::Control);
}

#[test]
fn a_cancel_after_a_launch_is_accepted() {
    let mut state = AcceptState::new();
    offer(&mut state, a_launch_frame()).expect("launch first");

    let accepted = offer(&mut state, a_cancel_frame()).expect("cancel after launch is legal");

    assert_eq!(accepted, Accepted::Cancel);
}

#[test]
fn a_cancel_before_any_launch_is_refused_as_out_of_order() {
    let mut state = AcceptState::new();

    let outcome = offer(&mut state, a_cancel_frame());

    assert_refused(outcome, ProtocolReason::FrameOutOfOrder, ProtocolStage::Control);
}

#[test]
fn a_second_launch_is_refused_as_a_duplicate_and_does_not_disturb_the_first() {
    let mut state = AcceptState::new();
    offer(&mut state, a_launch_frame()).expect("launch first");

    let outcome = offer(&mut state, a_launch_frame());

    assert_refused(outcome, ProtocolReason::DuplicateLaunch, ProtocolStage::Control);
    // A refused frame must not advance the state: cancel is still legal, which
    // it would not be had the duplicate reset the channel to expecting-launch.
    assert_eq!(offer(&mut state, a_cancel_frame()).expect("still launched"), Accepted::Cancel);
}

#[test]
fn a_frame_after_the_terminal_cancel_is_refused_as_frame_after_terminal() {
    let mut state = AcceptState::new();
    offer(&mut state, a_launch_frame()).expect("launch first");
    offer(&mut state, a_cancel_frame()).expect("cancel is terminal");

    let after_cancel = offer(&mut state, a_cancel_frame());
    let after_launch = offer(&mut state, a_launch_frame());

    assert_refused(after_cancel, ProtocolReason::FrameAfterTerminal, ProtocolStage::Control);
    assert_refused(after_launch, ProtocolReason::FrameAfterTerminal, ProtocolStage::Control);
}

#[test]
fn an_opcode_no_vocabulary_defines_is_refused_at_the_control_layer() {
    let outcome = offer(&mut AcceptState::new(), frame(0xEE, &[]));

    assert_refused(outcome, ProtocolReason::UnknownOpcode, ProtocolStage::Control);
}

#[test]
fn a_launch_payload_whose_field_runs_past_its_end_is_malformed() {
    // Declares a 300-byte executable and supplies four bytes of it.
    let mut payload = 300u16.to_le_bytes().to_vec();
    payload.extend_from_slice(b"C:\\w");
    let outcome = offer(&mut AcceptState::new(), frame(Inbound::Launch.opcode(), &payload));

    assert_refused(outcome, ProtocolReason::PayloadMalformed, ProtocolStage::Control);
}

#[test]
fn a_launch_payload_that_ends_early_is_malformed() {
    // Executable only: no argv count, no cwd, no environment count.
    let outcome =
        offer(&mut AcceptState::new(), frame(Inbound::Launch.opcode(), &text("C:\\w\\t.exe")));

    assert_refused(outcome, ProtocolReason::PayloadMalformed, ProtocolStage::Control);
}

#[test]
fn an_executable_that_is_not_valid_utf8_is_malformed() {
    let mut payload = 2u16.to_le_bytes().to_vec();
    payload.extend_from_slice(&[0xFF, 0xFE]);
    payload.extend_from_slice(&0u16.to_le_bytes());
    payload.extend_from_slice(&text("C:\\w"));
    payload.extend_from_slice(&0u16.to_le_bytes());
    let outcome = offer(&mut AcceptState::new(), frame(Inbound::Launch.opcode(), &payload));

    assert_refused(outcome, ProtocolReason::PayloadMalformed, ProtocolStage::Control);
}

#[test]
fn a_launch_payload_with_bytes_left_over_reports_trailing_bytes() {
    // EXTRA, MEANING ONE: a complete, well-formed launch payload followed by
    // bytes nothing in the format accounts for. Distinct from a frame arriving
    // after the terminal one, which has its own reason.
    let mut payload = launch_payload("C:\\w\\t.exe", &[], "C:\\w", &[]);
    payload.extend_from_slice(b"leftover");
    let outcome = offer(&mut AcceptState::new(), frame(Inbound::Launch.opcode(), &payload));

    assert_refused(outcome, ProtocolReason::TrailingBytes, ProtocolStage::Control);
}

#[test]
fn a_cancel_carrying_a_payload_reports_trailing_bytes() {
    // THE LAUNCH IS LOAD-BEARING. A cancel on a fresh state is refused as
    // FrameOutOfOrder by the sequence guard, which sits BEFORE the payload
    // check — so without it this test would pass while never reaching its
    // subject. The first draft of it did exactly that.
    let mut state = AcceptState::new();
    offer(&mut state, a_launch_frame()).expect("the sequence guard must not answer this case");

    let outcome = offer(&mut state, frame(Inbound::Cancel.opcode(), b"why"));

    assert_refused(outcome, ProtocolReason::TrailingBytes, ProtocolStage::Control);
}

/// Emits one status through the SHIPPED writer and returns the bytes that
/// reached the wire.
fn emitted(status: &Status) -> Vec<u8> {
    let mut channel = Scripted::serving(Vec::new());
    status.emit(&mut channel).expect("a status frame is within its channel's cap");
    channel.written
}

#[test]
fn the_outbound_vocabulary_is_exactly_started_completed_and_refused() {
    assert_eq!(Outbound::ALL.len(), 3);
    assert_eq!(Outbound::ALL, [Outbound::Started, Outbound::Completed, Outbound::Refused]);
    assert_eq!(Outbound::Started.opcode(), 1);
    assert_eq!(Outbound::Completed.opcode(), 2);
    assert_eq!(Outbound::Refused.opcode(), 3);
    assert_eq!(Outbound::from_opcode(0), None);
    assert_eq!(Outbound::from_opcode(4), None);
    for status in Outbound::ALL {
        assert_eq!(Outbound::from_opcode(status.opcode()), Some(status));
    }
}

#[test]
fn the_refusal_layers_include_store_lock_as_its_own_authority() {
    assert_eq!(RefusalLayer::ALL.len(), 4);
    assert_eq!(RefusalLayer::Descriptor.wire(), 1);
    assert_eq!(RefusalLayer::Protocol.wire(), 2);
    assert_eq!(RefusalLayer::Native.wire(), 3);
    assert_eq!(RefusalLayer::from_wire(4).map(RefusalLayer::wire), Some(4));
    assert_eq!(RefusalLayer::from_wire(0), None);
    assert_eq!(RefusalLayer::from_wire(5), None);
    for layer in RefusalLayer::ALL {
        assert_eq!(RefusalLayer::from_wire(layer.wire()), Some(layer));
    }
}

#[test]
fn a_started_frame_encodes_to_exactly_these_bytes() {
    // BYTE-EXACT AGAINST A HAND-WRITTEN LITERAL. Encoding and then decoding our
    // own output would only prove two functions agree with each other.
    let status = Status::Started(Started::new(4321, 0x0102_0304_0506_0708));

    assert_eq!(
        emitted(&status),
        vec![
            1, // version
            1, // opcode: STARTED
            12, 0, 0, 0, // declared length
            0xE1, 0x10, 0, 0, // pid 4321, little-endian
            8, 7, 6, 5, 4, 3, 2, 1, // creation time, little-endian
        ]
    );
}

#[test]
fn a_completed_frame_encodes_to_exactly_these_bytes_for_both_a_known_and_an_unknown_exit() {
    assert_eq!(
        emitted(&Status::Completed(Completed::Exited(7))),
        vec![1, 2, 5, 0, 0, 0, 1, 7, 0, 0, 0]
    );
    // An exit that is NOT knowable must be representable, or a caller would be
    // forced to invent an exit code for it.
    assert_eq!(
        emitted(&Status::Completed(Completed::Unknown(UnknownExit::StillRunning))),
        vec![1, 2, 5, 0, 0, 0, 2, 2, 0, 0, 0]
    );
}

#[test]
fn a_refused_frame_encodes_to_exactly_these_bytes() {
    let refusal = Refused::protocol(ProtocolError::refused(ProtocolReason::VersionMismatch));

    assert_eq!(
        emitted(&Status::Refused(refusal)),
        vec![
            1, // version
            3, // opcode: REFUSED
            7, 0, 0, 0, // declared length
            2, // layer: protocol
            0, 0, // reason ordinal within THAT layer's vocabulary
            0, 0, 0, 0, // numeric code: ours, so zero
        ]
    );
}

#[test]
fn two_layers_refusing_with_the_same_ordinal_are_still_told_apart_on_the_wire() {
    // BOTH are ordinal 0 in their own vocabulary: DescriptorReason::BlockAbsent
    // and ProtocolReason::VersionMismatch. A refusal frame carrying only a
    // number could not distinguish them, which is what the layer byte is for.
    let descriptor = parse_descriptor_block(&[], 0).expect_err("an absent block is refused");
    let from_descriptor = Refused::descriptor(descriptor);
    let from_protocol =
        Refused::protocol(ProtocolError::refused(ProtocolReason::VersionMismatch));

    assert_eq!(from_descriptor.reason(), from_protocol.reason(), "the same ordinal, deliberately");
    assert_eq!(from_descriptor.layer(), RefusalLayer::Descriptor);
    assert_eq!(from_protocol.layer(), RefusalLayer::Protocol);
    assert_ne!(
        emitted(&Status::Refused(from_descriptor)),
        emitted(&Status::Refused(from_protocol)),
        "the wire must distinguish them even though the ordinals collide"
    );
}

#[test]
fn a_native_refusal_carries_the_cores_own_operation_and_code() {
    // Rail 4: import the core's vocabulary, never restate it. 9 is CreateProcess's
    // position in NativeOp::ALL and is the frozen wire value; if the core
    // reorders its operations this reddens, which is correct — that is a wire
    // break, not a refactor.
    let refusal = Refused::native(NativeError::new(NativeOp::CreateProcess, 5));

    assert_eq!(refusal.layer(), RefusalLayer::Native);
    assert_eq!(refusal.reason(), 9);
    assert_eq!(refusal.code(), 5);
    assert_eq!(
        emitted(&Status::Refused(refusal)),
        vec![1, 3, 7, 0, 0, 0, 3, 9, 0, 5, 0, 0, 0]
    );
}

#[test]
fn a_diagnostic_frame_encodes_to_exactly_these_bytes() {
    let note = Diagnostic::new(DiagnosticNote::FrameRefused, 42);

    let mut channel = Scripted::serving(Vec::new());
    note.emit(&mut channel).expect("a diagnostic is within fd2's cap");

    assert_eq!(channel.written, vec![1, 1, 5, 0, 0, 0, 1, 42, 0, 0, 0]);
}

#[test]
fn a_diagnostic_frame_offered_to_the_control_decoder_never_becomes_a_command() {
    // fd2 is NON-AUTHORITATIVE. Even read as control — which nothing in the
    // crate does — its payload cannot decode to a launch request.
    let mut channel = Scripted::serving(Vec::new());
    Diagnostic::new(DiagnosticNote::FrameRefused, 42).emit(&mut channel).expect("emitted");

    let outcome = offer(&mut AcceptState::new(), channel.written);

    assert_refused(outcome, ProtocolReason::PayloadMalformed, ProtocolStage::Control);
}

// ---------------------------------------------------------------------------
// THE SWEEP
// ---------------------------------------------------------------------------

/// The six hostile classes the parent DoD names, plus channel loss.
///
/// The parent's six come FIRST and `PARENT_CLASSES` pins them by name, so a
/// rename or a removal is a test failure rather than a quietly narrower sweep.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum HostileClass {
    Malformed,
    Truncated,
    Reordered,
    Duplicate,
    Extra,
    OverLimit,
    /// Not one of the parent's six: the channel itself failing is not a
    /// property of any byte sequence. Carried so the sweep can reach every
    /// reason in the production vocabulary rather than excusing one.
    ChannelLoss,
}

impl HostileClass {
    const ALL: [HostileClass; 7] = [
        HostileClass::Malformed,
        HostileClass::Truncated,
        HostileClass::Reordered,
        HostileClass::Duplicate,
        HostileClass::Extra,
        HostileClass::OverLimit,
        HostileClass::ChannelLoss,
    ];
}

const PARENT_CLASSES: [HostileClass; 6] = [
    HostileClass::Malformed,
    HostileClass::Truncated,
    HostileClass::Reordered,
    HostileClass::Duplicate,
    HostileClass::Extra,
    HostileClass::OverLimit,
];

/// One hostile case: what must be accepted first, the bytes, and the EXACT
/// reason and layer it must produce.
struct Hostile {
    name: &'static str,
    class: HostileClass,
    prior: Vec<Vec<u8>>,
    bytes: Vec<u8>,
    read_error: Option<u32>,
    reason: ProtocolReason,
    stage: ProtocolStage,
}

impl Hostile {
    fn new(
        name: &'static str,
        class: HostileClass,
        bytes: Vec<u8>,
        reason: ProtocolReason,
        stage: ProtocolStage,
    ) -> Self {
        Self { name, class, prior: Vec::new(), bytes, read_error: None, reason, stage }
    }

    fn after(mut self, prior: Vec<Vec<u8>>) -> Self {
        self.prior = prior;
        self
    }

    fn with_read_error(mut self, code: u32) -> Self {
        self.read_error = Some(code);
        self
    }

    /// Drives this case through the SHIPPED path, both layers.
    ///
    /// Framing and control refusals are funnelled into one `Result` on purpose:
    /// nothing here forces which layer answers, so the per-case `stage`
    /// assertion is a real measurement rather than a consequence of the harness.
    fn run(&self) -> Result<Accepted, ProtocolError> {
        let mut state = AcceptState::new();
        for setup in &self.prior {
            offer(&mut state, setup.clone())
                .expect("a case's setup frames must be accepted, or it never reaches its subject");
        }
        let mut channel = Scripted::serving(self.bytes.clone());
        if let Some(code) = self.read_error {
            channel = channel.failing_reads_with(code);
        }
        let raw = read_frame(&mut channel, ChannelKind::Control)?;
        state.accept(&raw)
    }
}

/// GENERATED: every strict prefix of one well-formed launch frame.
///
/// A real generator rather than a hand-listed pair, so a cut anywhere in the
/// header or anywhere in the payload is covered without anyone choosing which
/// offsets are interesting.
fn generated_truncations() -> Vec<Hostile> {
    let whole = a_launch_frame();
    (0..whole.len())
        .map(|cut| {
            Hostile::new(
                "a well-formed launch frame cut short",
                HostileClass::Truncated,
                whole[..cut].to_vec(),
                ProtocolReason::FrameTruncated,
                ProtocolStage::Framing,
            )
        })
        .collect()
}

fn hostile_cases() -> Vec<Hostile> {
    let mut cases = generated_truncations();

    // OVER-LIMIT
    cases.push(Hostile::new(
        "a declared length near u32::MAX",
        HostileClass::OverLimit,
        header(PROTOCOL_VERSION, Inbound::Launch.opcode(), u32::MAX - 8),
        ProtocolReason::LengthOverLimit,
        ProtocolStage::Framing,
    ));
    cases.push(Hostile::new(
        "a declared length one byte over the control cap",
        HostileClass::OverLimit,
        header(
            PROTOCOL_VERSION,
            Inbound::Launch.opcode(),
            u32::try_from(ChannelKind::Control.max_payload() + 1).expect("the cap fits a u32"),
        ),
        ProtocolReason::LengthOverLimit,
        ProtocolStage::Framing,
    ));

    // MALFORMED
    cases.push(Hostile::new(
        "a version this build does not speak",
        HostileClass::Malformed,
        header(PROTOCOL_VERSION + 1, Inbound::Launch.opcode(), 0),
        ProtocolReason::VersionMismatch,
        ProtocolStage::Framing,
    ));
    cases.push(Hostile::new(
        "wrong version AND an undefined opcode AND over-limit, at once",
        HostileClass::Malformed,
        header(PROTOCOL_VERSION + 7, 0xEE, u32::MAX - 8),
        ProtocolReason::VersionMismatch,
        ProtocolStage::Framing,
    ));
    cases.push(Hostile::new(
        "an opcode outside the closed vocabulary",
        HostileClass::Malformed,
        frame(0xEE, &[]),
        ProtocolReason::UnknownOpcode,
        ProtocolStage::Control,
    ));
    cases.push(Hostile::new(
        "a launch field whose declared length runs past the payload",
        HostileClass::Malformed,
        {
            let mut payload = 300u16.to_le_bytes().to_vec();
            payload.extend_from_slice(b"C:\\w");
            frame(Inbound::Launch.opcode(), &payload)
        },
        ProtocolReason::PayloadMalformed,
        ProtocolStage::Control,
    ));
    cases.push(Hostile::new(
        "a launch payload that ends before its environment",
        HostileClass::Malformed,
        frame(Inbound::Launch.opcode(), &text("C:\\w\\t.exe")),
        ProtocolReason::PayloadMalformed,
        ProtocolStage::Control,
    ));
    cases.push(Hostile::new(
        "an executable that is not valid UTF-8",
        HostileClass::Malformed,
        {
            let mut payload = 2u16.to_le_bytes().to_vec();
            payload.extend_from_slice(&[0xFF, 0xFE]);
            payload.extend_from_slice(&0u16.to_le_bytes());
            payload.extend_from_slice(&text("C:\\w"));
            payload.extend_from_slice(&0u16.to_le_bytes());
            frame(Inbound::Launch.opcode(), &payload)
        },
        ProtocolReason::PayloadMalformed,
        ProtocolStage::Control,
    ));

    // REORDERED
    cases.push(Hostile::new(
        "a cancel before any launch",
        HostileClass::Reordered,
        a_cancel_frame(),
        ProtocolReason::FrameOutOfOrder,
        ProtocolStage::Control,
    ));

    // DUPLICATE
    cases.push(
        Hostile::new(
            "a second launch on a channel that already launched",
            HostileClass::Duplicate,
            a_launch_frame(),
            ProtocolReason::DuplicateLaunch,
            ProtocolStage::Control,
        )
        .after(vec![a_launch_frame()]),
    );

    // EXTRA, MEANING ONE: extra bytes INSIDE a well-formed frame.
    cases.push(Hostile::new(
        "bytes left over after a complete launch payload",
        HostileClass::Extra,
        {
            let mut payload = launch_payload("C:\\w\\t.exe", &[], "C:\\w", &[]);
            payload.extend_from_slice(b"leftover");
            frame(Inbound::Launch.opcode(), &payload)
        },
        ProtocolReason::TrailingBytes,
        ProtocolStage::Control,
    ));
    cases.push(
        Hostile::new(
            "a cancel carrying a payload it has no field for",
            HostileClass::Extra,
            frame(Inbound::Cancel.opcode(), b"why"),
            ProtocolReason::TrailingBytes,
            ProtocolStage::Control,
        )
        .after(vec![a_launch_frame()]),
    );
    // EXTRA, MEANING TWO: an additional frame AFTER the terminal one. A distinct
    // reason, because a reader that cannot tell these apart cannot tell a
    // malformed payload from a peer that kept talking.
    cases.push(
        Hostile::new(
            "another frame after the terminal cancel",
            HostileClass::Extra,
            a_launch_frame(),
            ProtocolReason::FrameAfterTerminal,
            ProtocolStage::Control,
        )
        .after(vec![a_launch_frame(), a_cancel_frame()]),
    );

    // CHANNEL LOSS
    cases.push(
        Hostile::new(
            "the channel failing instead of delivering the frame",
            HostileClass::ChannelLoss,
            a_launch_frame(),
            ProtocolReason::ChannelFailed,
            ProtocolStage::Framing,
        )
        .with_read_error(109),
    );

    cases
}

#[test]
fn the_sweep_generates_exactly_the_expected_number_of_cases() {
    // NONZERO AND EXACT. A generator that silently produced nothing would pass
    // every assertion below it, which is the defect epic rail 6 names.
    let generated = generated_truncations();
    assert_eq!(a_launch_frame().len(), 39, "the frame the truncations are cut from");
    assert_eq!(generated.len(), 39, "one case per strict prefix, header and payload alike");
    assert!(!generated.is_empty());

    let cases = hostile_cases();
    assert_eq!(cases.len(), 53);

    // Per-class counts, hand-written. A table cannot police its own generator,
    // so these numbers are stated here and nowhere else.
    let counted = |class: HostileClass| cases.iter().filter(|case| case.class == class).count();
    assert_eq!(counted(HostileClass::Truncated), 39);
    assert_eq!(counted(HostileClass::Malformed), 6);
    assert_eq!(counted(HostileClass::OverLimit), 2);
    assert_eq!(counted(HostileClass::Extra), 3);
    assert_eq!(counted(HostileClass::Reordered), 1);
    assert_eq!(counted(HostileClass::Duplicate), 1);
    assert_eq!(counted(HostileClass::ChannelLoss), 1);
    assert_eq!(cases.len(), HostileClass::ALL.iter().map(|class| counted(*class)).sum::<usize>());
}

#[test]
fn all_six_hostile_classes_the_parent_names_are_covered() {
    let cases = hostile_cases();

    for class in PARENT_CLASSES {
        assert!(
            cases.iter().any(|case| case.class == class),
            "hostile class {class:?} has no case at all"
        );
    }
    // The parent's six are the first six of the local enum, so adding a seventh
    // cannot quietly displace one of them.
    assert_eq!(PARENT_CLASSES[..], HostileClass::ALL[..6]);
}

#[test]
fn every_hostile_case_refuses_with_its_own_exact_reason_at_its_own_layer() {
    let cases = hostile_cases();
    let mut accepted = Vec::new();

    for case in &cases {
        match case.run() {
            // THE AUTHORITY PROOF, DoD item 4. `Accepted::Launch(LaunchRequest)`
            // is the ONLY value in this crate that could ever reach a process
            // launch, and `AcceptState::accept` is its only constructor. So the
            // absence of an `Ok` here is a stronger statement than an empty core
            // call log: a call log can be satisfied by code that simply has not
            // called yet, whereas this value cannot be brought into existence at
            // all. See the completion notes for why the literal call-log form
            // would have been vacuous in this task.
            Ok(_) => accepted.push(case.name),
            Err(error) => {
                assert_eq!(error.reason(), case.reason, "wrong reason for: {}", case.name);
                assert_eq!(error.stage(), case.stage, "wrong layer for: {}", case.name);
            }
        }
    }

    assert_eq!(accepted, Vec::<&str>::new(), "hostile frames that produced an Accepted value");
}

#[test]
fn the_sweep_reaches_every_reason_in_the_production_vocabulary() {
    // CROSS-CHECKED AGAINST THE PRODUCTION ENUM, never against the sweep's own
    // case list. Deleting an entry from ProtocolReason::ALL reddens this even
    // though every individual case still passes.
    let produced: BTreeSet<ProtocolReason> =
        hostile_cases().iter().filter_map(|case| case.run().err()).map(|e| e.reason()).collect();
    let vocabulary: BTreeSet<ProtocolReason> = ProtocolReason::ALL.iter().copied().collect();

    assert_eq!(vocabulary.len(), 10, "the vocabulary this sweep claims to cover");
    assert_eq!(produced, vocabulary);
}
