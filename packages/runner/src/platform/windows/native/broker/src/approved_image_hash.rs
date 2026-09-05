//! SHA-256 over the held file, using the operating system's versioned crypto implementation.
use std::fs::File;
use std::io::Read;
use windows_sys::Win32::Security::Cryptography::{BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash,
    BCryptHashData, BCRYPT_HASH_HANDLE, BCRYPT_SHA256_ALG_HANDLE};
use crate::approved_image::{ApprovedImageError as Error, ApprovedImageReason as Reason};
struct Hash(BCRYPT_HASH_HANDLE);
impl Drop for Hash { fn drop(&mut self) { unsafe { BCryptDestroyHash(self.0); } } }
fn checked(status: i32) -> Result<(), Error> {
    if status < 0 { Err(Error::new(Reason::HashFailed, status as u32)) } else { Ok(()) }
}
pub(crate) fn hash_file(file: &mut File) -> Result<String, Error> {
    let mut handle = std::ptr::null_mut();
    // Null object storage asks CNG to own its bounded internal hash state.
    checked(unsafe { BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &mut handle, std::ptr::null_mut(), 0,
        std::ptr::null(), 0, 0) })?;
    let hash = Hash(handle); let mut buffer = [0u8; 65536]; let mut total = 0usize;
    loop {
        let length = file.read(&mut buffer).map_err(|_| Error::new(Reason::HashFailed, 0))?;
        if length == 0 { break; }
        total += length;
        if total > 256 * 1024 * 1024 { return Err(Error::new(Reason::InvalidBinding, 0)); }
        checked(unsafe { BCryptHashData(hash.0, buffer.as_ptr(), length as u32, 0) })?;
    }
    let mut digest = [0u8; 32];
    checked(unsafe { BCryptFinishHash(hash.0, digest.as_mut_ptr(), digest.len() as u32, 0) })?;
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
