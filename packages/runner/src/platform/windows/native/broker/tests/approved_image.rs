#![cfg(windows)]

use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use moe_windows_job_broker::{ApprovedImageGuard, ApprovedImageReason};

static NEXT: AtomicU64 = AtomicU64::new(0);
const ABC_SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
struct Fixture { root: PathBuf, parent: PathBuf, program: PathBuf }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("moe-approved-image-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let parent = root.join("bin"); fs::create_dir_all(&parent).unwrap();
        let program = parent.join("check.exe"); fs::write(&program, b"abc").unwrap();
        Self { root, parent, program }
    }
}
impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.root).unwrap(); } }

#[test]
fn approved_image_and_its_directory_path_cannot_be_swapped_while_the_guard_is_held() {
    let f = Fixture::new();
    let guard = ApprovedImageGuard::acquire(f.program.to_str().unwrap(), ABC_SHA).unwrap();
    assert!(OpenOptions::new().write(true).open(&f.program).is_err(), "in-place writes must be excluded");
    assert!(fs::rename(&f.program, f.parent.join("original.exe")).is_err(), "image replacement must be excluded");
    assert!(fs::rename(&f.parent, f.root.join("moved")).is_err(), "ancestor replacement must be excluded");
    drop(guard);
    fs::rename(&f.program, f.parent.join("original.exe")).unwrap();
    fs::write(&f.program, b"different bytes").unwrap();
    let error = ApprovedImageGuard::acquire(f.program.to_str().unwrap(), ABC_SHA).err().unwrap();
    assert_eq!(error.reason(), ApprovedImageReason::DigestMismatch);
    fs::remove_file(&f.program).unwrap();
    fs::rename(f.parent.join("original.exe"), &f.program).unwrap();
    assert!(ApprovedImageGuard::acquire(f.program.to_str().unwrap(), ABC_SHA).is_ok());
}

#[test]
fn a_preexisting_writer_and_malformed_digest_are_refused_before_any_launch() {
    let f = Fixture::new();
    let writer = OpenOptions::new().write(true).open(&f.program).unwrap();
    assert_eq!(ApprovedImageGuard::acquire(f.program.to_str().unwrap(), ABC_SHA).err().unwrap().reason(), ApprovedImageReason::OpenFailed);
    drop(writer);
    assert_eq!(ApprovedImageGuard::acquire(f.program.to_str().unwrap(), &"A".repeat(64)).err().unwrap().reason(), ApprovedImageReason::InvalidBinding);
}
