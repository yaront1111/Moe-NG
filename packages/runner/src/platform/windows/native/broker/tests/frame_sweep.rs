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

use moe_windows_job_broker::{
    read_frame, write_frame, AcceptState, Accepted, ByteChannel, ChannelKind, Inbound,
    ProtocolError, ProtocolReason, ProtocolStage, RawFrame, FRAME_HEADER_BYTES, PROTOCOL_VERSION,
};

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

    let outcome = read_frame(&mut channel, ChannelKind::Control);

    let error = assert_refused(outcome, ProtocolReason::LengthOverLimit, ProtocolStage::Framing);
    assert_eq!(error.code(), 0, "our refusal, not the operating system's");
    assert_eq!(
        channel.bytes_read(),
        FRAME_HEADER_BYTES,
        "the header was read and nothing more: no payload was pulled, so nothing was sized to the declaration"
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
fn the_inbound_vocabulary_is_exactly_launch_and_cancel() {
    assert_eq!(Inbound::ALL.len(), 2);
    assert_eq!(Inbound::ALL, [Inbound::Launch, Inbound::Cancel]);
    // Pinned by hand: the opcode bytes are the frozen wire contract, not
    // whatever declaration order happens to produce.
    assert_eq!(Inbound::Launch.opcode(), 1);
    assert_eq!(Inbound::Cancel.opcode(), 2);
    // No open command space: every other byte maps to nothing at all.
    assert_eq!(Inbound::from_opcode(0), None);
    assert_eq!(Inbound::from_opcode(3), None);
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
        }
    }
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
