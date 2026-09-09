//! Optional launch authority: a held, hashed executable and its non-reparse directory path.
//! Ordinary launches do not acquire this guard. No path or digest reaches refusal output.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovedImageReason { InvalidBinding, OpenFailed, PathMismatch, DigestMismatch, HashFailed }
impl ApprovedImageReason {
    pub const fn ordinal(self) -> u16 {
        match self { Self::InvalidBinding => 0, Self::OpenFailed => 1, Self::PathMismatch => 2,
            Self::DigestMismatch => 3, Self::HashFailed => 4 }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApprovedImageError { reason: ApprovedImageReason, code: u32 }
impl ApprovedImageError {
    pub const fn new(reason: ApprovedImageReason, code: u32) -> Self { Self { reason, code } }
    pub const fn reason(self) -> ApprovedImageReason { self.reason }
    pub const fn code(self) -> u32 { self.code }
}
pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(windows)]
pub use crate::approved_image_windows::ApprovedImageGuard;
#[cfg(not(windows))]
pub struct ApprovedImageGuard;
#[cfg(not(windows))]
impl ApprovedImageGuard {
    pub fn acquire(_path: &str, _digest: &str) -> Result<Self, ApprovedImageError> {
        Err(ApprovedImageError::new(ApprovedImageReason::OpenFailed, 0))
    }
}
