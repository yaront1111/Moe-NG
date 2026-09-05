use std::fs::{File, OpenOptions};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE};
use crate::approved_image::{valid_digest, ApprovedImageError as Error, ApprovedImageReason as Reason};
use crate::approved_image_hash::hash_file;

/// Read sharing permits Windows image loading; write/delete sharing is deliberately absent.
/// Every parent is held against rename, so CreateProcess resolves the path that was hashed.
pub struct ApprovedImageGuard { _handles: Vec<File> }
impl ApprovedImageGuard {
    pub fn acquire(path: &str, digest: &str) -> Result<Self, Error> {
        if !valid_digest(digest) || !valid_path(path) { return Err(Error::new(Reason::InvalidBinding, 0)); }
        let mut handles = Vec::new();
        // Lock root to leaf, never traversing an unlocked or reparse parent.
        let mut directory = path[..3].to_owned();
        handles.push(open_directory(&directory)?);
        let segments: Vec<&str> = path[3..].split('\\').collect();
        for segment in &segments[..segments.len() - 1] {
            if !directory.ends_with('\\') { directory.push('\\'); }
            directory.push_str(segment); handles.push(open_directory(&directory)?);
        }
        let mut image = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(open_error)?;
        let metadata = image.metadata().map_err(open_error)?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || metadata.len() == 0 || metadata.len() > 256 * 1024 * 1024 {
            return Err(Error::new(Reason::InvalidBinding, 0));
        }
        match final_path(&image)?.strip_prefix("\\\\?\\") {
            Some(actual) if actual.eq_ignore_ascii_case(path) => {},
            _ => return Err(Error::new(Reason::PathMismatch, 0)),
        }
        if hash_file(&mut image)? != digest { return Err(Error::new(Reason::DigestMismatch, 0)); }
        handles.push(image);
        Ok(Self { _handles: handles })
    }
}
fn valid_path(path: &str) -> bool {
    if path.len() < 4 || path.encode_utf16().count() > 260 || !path.as_bytes()[0].is_ascii_alphabetic()
        || &path.as_bytes()[1..3] != b":\\" || path.contains(['/', '\0']) { return false; }
    path[3..].split('\\').all(|part| !part.is_empty() && part != "." && part != ".."
        && !part.ends_with(['.', ' ']) && !part.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)))
}
fn open_directory(path: &str) -> Result<File, Error> {
    let file = OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS).open(path).map_err(open_error)?;
    let metadata = file.metadata().map_err(open_error)?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::new(Reason::PathMismatch, 0));
    }
    Ok(file)
}
fn final_path(file: &File) -> Result<String, Error> {
    let mut text = [0u16; 1024];
    // The live File owns the handle; the fixed buffer covers the bounded request plus prefix.
    let length = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), text.as_mut_ptr(), text.len() as u32, 0) };
    if length == 0 || length as usize >= text.len() { return Err(Error::new(Reason::PathMismatch, 0)); }
    String::from_utf16(&text[..length as usize]).map_err(|_| Error::new(Reason::PathMismatch, 0))
}
fn open_error(error: std::io::Error) -> Error { Error::new(Reason::OpenFailed, error.raw_os_error().unwrap_or(0) as u32) }
