//! Exclusive per-store ownership for curated project-stack launches.
//!
//! The lock file may remain on disk; ownership is the Windows HANDLE opened
//! with share mode zero. Kernel handle teardown releases it on ordinary drop,
//! panic, process termination, and broker crash, so no stale lockfile can
//! preserve authority after its owner is gone.

/// The closed store-lock refusal vocabulary. No variant carries the path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StoreLockReason {
    PathRejected,
    Contended,
    OpenFailed,
}

impl StoreLockReason {
    pub const ALL: [StoreLockReason; 3] = [
        StoreLockReason::PathRejected,
        StoreLockReason::Contended,
        StoreLockReason::OpenFailed,
    ];

    pub fn ordinal(self) -> usize {
        Self::ALL
            .iter()
            .position(|reason| *reason == self)
            .unwrap_or(Self::ALL.len())
    }
}

/// Stable reason plus the numeric Windows code, and no caller text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoreLockError {
    reason: StoreLockReason,
    code: u32,
}

const _: () = assert!(size_of::<StoreLockError>() == 8);

impl StoreLockError {
    pub const fn new(reason: StoreLockReason, code: u32) -> Self {
        Self { reason, code }
    }

    pub const fn reason(&self) -> StoreLockReason {
        self.reason
    }

    pub const fn code(&self) -> u32 {
        self.code
    }
}

impl core::fmt::Display for StoreLockError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            formatter,
            "{:?} with Win32 error {}",
            self.reason, self.code
        )
    }
}

impl std::error::Error for StoreLockError {}

/// Injectable ownership boundary used by the session and real kernel tests.
pub trait StoreLockAuthority {
    type Guard;

    fn acquire(&self, store_path: &str) -> Result<Self::Guard, StoreLockError>;
}

/// Keeps the exclusive handle alive after the child session has settled, so
/// the broker can retain ownership through its own final descriptor teardown.
pub struct StoreLockedOutcome<G> {
    outcome: crate::Outcome,
    _guard: Option<G>,
}

impl<G> StoreLockedOutcome<G> {
    pub(crate) const fn new(outcome: crate::Outcome, guard: Option<G>) -> Self {
        Self {
            outcome,
            _guard: guard,
        }
    }

    pub const fn outcome(&self) -> crate::Outcome {
        self.outcome
    }
}

pub(crate) struct UnavailableStoreLocks;

impl StoreLockAuthority for UnavailableStoreLocks {
    type Guard = ();

    fn acquire(&self, _store_path: &str) -> Result<Self::Guard, StoreLockError> {
        Err(StoreLockError::new(StoreLockReason::OpenFailed, 0))
    }
}

/// Defense in depth for the native peer. TypeScript applies the same policy
/// before the broker is even resolved, but a hostile direct peer earns none of
/// that trust.
pub fn validate_store_path(path: &str) -> Result<(), StoreLockError> {
    if path.encode_utf16().count() > max_store_path_chars()
        || path.len() < 4
        || path.as_bytes().get(1) != Some(&b':')
        || path.as_bytes().get(2) != Some(&b'\\')
        || !path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        || path.contains(['/', '\0'])
    {
        return Err(rejected());
    }
    let tail = path.get(3..).ok_or_else(rejected)?;
    if tail.is_empty() || tail.split('\\').any(invalid_segment) {
        return Err(rejected());
    }
    Ok(())
}

fn invalid_segment(segment: &str) -> bool {
    if segment.is_empty()
        || matches!(segment, "." | "..")
        || segment.ends_with(['.', ' '])
        || segment
            .chars()
            .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        return true;
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CONIN$"
            | "CONOUT$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

const LOCK_SUFFIX: &str = ".moe-stack.lock";
const WINDOWS_MAX_PATH_CHARS: usize = 260;

const fn max_store_path_chars() -> usize {
    WINDOWS_MAX_PATH_CHARS - LOCK_SUFFIX.len() - 1
}

const fn rejected() -> StoreLockError {
    StoreLockError::new(StoreLockReason::PathRejected, 0)
}

#[cfg(windows)]
mod windows {
    use core::mem::MaybeUninit;
    use core::ptr;
    use std::io::ErrorKind;
    use std::os::windows::fs::MetadataExt;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
        OPEN_EXISTING,
    };

    use super::{
        validate_store_path, StoreLockAuthority, StoreLockError, StoreLockReason, LOCK_SUFFIX,
    };

    /// The production file-lock authority.
    pub struct SystemStoreLocks;

    /// Opaque by design: a raw handle or store path cannot be formatted.
    pub struct SystemStoreLock {
        handle: HANDLE,
    }

    fn validate_existing_store_identity(store_path: &str) -> Result<(), StoreLockError> {
        let metadata = match std::fs::symlink_metadata(store_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(StoreLockError::new(
                    StoreLockReason::OpenFailed,
                    error.raw_os_error().unwrap_or(0) as u32,
                ));
            }
        };
        // Adjacent path locks are sound only for one ordinary directory entry.
        // Reparse points can redirect elsewhere and hard links give the same
        // SQLite file multiple adjacent lock names, so both are refused.
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(super::rejected());
        }
        let path: Vec<u16> = store_path.encode_utf16().chain([0]).collect();
        // SAFETY: the path is NUL-terminated and live for the call. Zero access
        // plus full sharing observes identity without interfering with SQLite.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            // SAFETY: read immediately after the failed CreateFileW.
            let code = unsafe { GetLastError() };
            return Err(StoreLockError::new(StoreLockReason::OpenFailed, code));
        }
        let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        // SAFETY: the handle is live and the output points to writable storage.
        let observed = unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) };
        let observation_code = if observed == 0 {
            // SAFETY: read immediately after the failed observation.
            unsafe { GetLastError() }
        } else {
            0
        };
        // SAFETY: this function owns the observation handle on every success path.
        let _ = unsafe { CloseHandle(handle) };
        if observed == 0 {
            return Err(StoreLockError::new(StoreLockReason::OpenFailed, observation_code));
        }
        // SAFETY: a nonzero observation result initialized the whole structure.
        let information = unsafe { information.assume_init() };
        if information.nNumberOfLinks != 1 {
            return Err(super::rejected());
        }
        Ok(())
    }

    impl StoreLockAuthority for SystemStoreLocks {
        type Guard = SystemStoreLock;

        fn acquire(&self, store_path: &str) -> Result<Self::Guard, StoreLockError> {
            validate_store_path(store_path)?;
            validate_existing_store_identity(store_path)?;
            let path: Vec<u16> = format!("{store_path}{LOCK_SUFFIX}")
                .encode_utf16()
                .chain([0])
                .collect();
            // SAFETY: the path is NUL-terminated and live for the call. Share
            // mode zero is the exclusivity claim; OPEN_ALWAYS makes disk state
            // non-authoritative, because only this returned handle owns it.
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL,
                    ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                // SAFETY: read immediately after the failed CreateFileW.
                let code = unsafe { GetLastError() };
                let reason = if code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION {
                    StoreLockReason::Contended
                } else {
                    StoreLockReason::OpenFailed
                };
                return Err(StoreLockError::new(reason, code));
            }
            Ok(SystemStoreLock { handle })
        }
    }

    impl Drop for SystemStoreLock {
        fn drop(&mut self) {
            // SAFETY: this type is the sole owner and Drop runs at most once.
            let _ = unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(windows)]
pub use windows::{SystemStoreLock, SystemStoreLocks};
