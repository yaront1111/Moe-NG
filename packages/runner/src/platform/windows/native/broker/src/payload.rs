//! A bounded reader over a payload the framing layer has already capped.
//!
//! SCOPE. Cursor arithmetic and nothing else: no vocabulary, no sequence rules,
//! no channel. Crate-internal, so it adds no public surface.
//!
//! EVERY LENGTH AND EVERY COUNT IN A PAYLOAD IS ALSO ATTACKER INPUT, exactly as
//! the frame's declared length is. Two consequences are load-bearing here:
//!
//! * NOTHING IS EVER SIZED FROM A DECLARED COUNT. A list is pushed one element
//!   at a time, so a payload declaring 65535 entries and supplying none refuses
//!   on the first missing element rather than reserving for 65535. There is no
//!   `Vec::with_capacity` in this file, and there must not be one.
//! * NO INDEXING, NO SLICING BY RANGE, NO `unwrap`, NO `expect`. Every read goes
//!   through [`Cursor::take`], which is checked, so no byte sequence can panic
//!   this decoder.

use crate::protocol::{ProtocolError, ProtocolReason};

/// Every field length and count in a payload is a little-endian `u16`.
const LENGTH_FIELD_BYTES: usize = 2;

/// A refusal for a payload that does not match the shape its opcode names.
const fn malformed() -> ProtocolError {
    ProtocolError::refused(ProtocolReason::PayloadMalformed)
}

/// A checked reader over one frame's payload.
pub(crate) struct Cursor<'b> {
    bytes: &'b [u8],
    at: usize,
}

impl<'b> Cursor<'b> {
    pub(crate) const fn new(bytes: &'b [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    /// Consumes exactly `count` bytes, or refuses.
    ///
    /// `checked_add` rather than `+`: `at + count` with a `u16`-sized count
    /// cannot realistically wrap, but a bounds proof that depends on "cannot
    /// realistically" is not a bounds check.
    fn take(&mut self, count: usize) -> Result<&'b [u8], ProtocolError> {
        let end = self.at.checked_add(count).ok_or_else(malformed)?;
        let slice = self.bytes.get(self.at..end).ok_or_else(malformed)?;
        self.at = end;
        Ok(slice)
    }

    /// A little-endian `u16` length or element count.
    fn u16(&mut self) -> Result<u16, ProtocolError> {
        let bytes = self.take(LENGTH_FIELD_BYTES)?;
        let bytes = <[u8; LENGTH_FIELD_BYTES]>::try_from(bytes).map_err(|_| malformed())?;
        Ok(u16::from_le_bytes(bytes))
    }

    /// A `u16`-length-prefixed UTF-8 string.
    ///
    /// The allocation is `to_owned` over bytes ALREADY PRESENT in the payload,
    /// never a reservation for a length that was merely declared.
    pub(crate) fn text(&mut self) -> Result<String, ProtocolError> {
        let length = usize::from(self.u16()?);
        let bytes = self.take(length)?;
        core::str::from_utf8(bytes).map(str::to_owned).map_err(|_| malformed())
    }

    /// A `u16` count followed by that many strings.
    pub(crate) fn list(&mut self) -> Result<Vec<String>, ProtocolError> {
        let count = self.u16()?;
        let mut items = Vec::new();
        for _ in 0..count {
            items.push(self.text()?);
        }
        Ok(items)
    }

    /// A `u16` count followed by that many key/value string pairs.
    pub(crate) fn pairs(&mut self) -> Result<Vec<(String, String)>, ProtocolError> {
        let count = self.u16()?;
        let mut items = Vec::new();
        for _ in 0..count {
            let key = self.text()?;
            items.push((key, self.text()?));
        }
        Ok(items)
    }

    /// Asserts the payload was consumed exactly.
    ///
    /// Its own reason, distinct from [`malformed`]: bytes left over after a
    /// payload that otherwise decoded are EXTRA data, and the sweep has to be
    /// able to tell that apart from a payload that never made sense.
    pub(crate) fn finish(self) -> Result<(), ProtocolError> {
        if self.at == self.bytes.len() {
            Ok(())
        } else {
            Err(ProtocolError::refused(ProtocolReason::TrailingBytes))
        }
    }
}
