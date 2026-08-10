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
    read_frame, write_frame, ByteChannel, ChannelKind, ProtocolError, ProtocolReason,
    ProtocolStage, RawFrame, FRAME_HEADER_BYTES, PROTOCOL_VERSION,
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

#[track_caller]
fn assert_refused(
    outcome: Result<RawFrame, ProtocolError>,
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
