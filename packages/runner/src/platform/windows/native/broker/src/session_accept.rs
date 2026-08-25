//! The pre-authority control read for one session.

use crate::control::{AcceptState, Accepted, LaunchRequest};
use crate::diagnostics::DiagnosticNote;
use crate::frames::{read_frame, ByteChannel, ChannelKind};
use crate::protocol::{ProtocolError, ProtocolReason};
use crate::refusal::Refused;
use crate::session::{note, refuse_protocol, Wiring};

/// Reads fd0 for the one launch this session serves.
///
/// `Ok(None)` means fd0 ended before asking for anything. It writes no frame:
/// the absent peer violated no rule and could not receive a refusal anyway.
pub(crate) fn accept_launch<B: ByteChannel>(
    wiring: &mut Wiring<B>,
    accept: &mut AcceptState,
) -> Result<Option<LaunchRequest>, Refused> {
    let frame = match read_frame(&mut wiring.control, ChannelKind::Control) {
        Ok(frame) => frame,
        Err(error) if error.reason() == ProtocolReason::FrameTruncated => {
            note(wiring, DiagnosticNote::ChannelEnded, error.code());
            return Ok(None);
        }
        Err(error) => return Err(refuse_protocol(wiring, error)),
    };
    match accept.accept(&frame) {
        Ok(Accepted::Launch(request)) => {
            note(
                wiring,
                DiagnosticNote::FrameAccepted,
                u32::from(frame.opcode()),
            );
            Ok(Some(request))
        }
        Ok(Accepted::Cancel) => Err(refuse_protocol(
            wiring,
            ProtocolError::refused(ProtocolReason::FrameOutOfOrder),
        )),
        Err(error) => Err(refuse_protocol(wiring, error)),
    }
}
