//! Store-lock contract and real-kernel contention.

use moe_windows_job_broker::{validate_store_path, StoreLockReason};

#[test]
fn store_lock_reason_vocabulary_is_closed_and_contention_is_stable() {
    assert_eq!(StoreLockReason::ALL.len(), 3);
    assert_eq!(StoreLockReason::PathRejected.ordinal(), 0);
    assert_eq!(StoreLockReason::Contended.ordinal(), 1);
    assert_eq!(StoreLockReason::OpenFailed.ordinal(), 2);
}

#[test]
fn local_drive_absolute_store_paths_are_admitted() {
    assert_eq!(
        validate_store_path("C:\\projects\\alpha\\store.sqlite"),
        Ok(())
    );
    let unicode = format!("C:\\{}", "é".repeat(121));
    assert_eq!(unicode.encode_utf16().count(), 124);
    assert_eq!(validate_store_path(&unicode), Ok(()));
}

#[test]
fn hostile_or_ambiguous_store_paths_are_refused_without_echo_fields() {
    for path in [
        "store.sqlite",
        "\\\\server\\share\\store.sqlite",
        "\\\\?\\C:\\projects\\store.sqlite",
        "C:/projects/store.sqlite",
        "C:\\projects\\..\\store.sqlite",
        "C:\\projects\\NUL.sqlite",
        "C:\\projects\\store.sqlite ",
    ] {
        let error = validate_store_path(path).expect_err("the path must be rejected");
        assert_eq!(error.reason(), StoreLockReason::PathRejected);
        assert_eq!(error.code(), 0);
        assert_eq!(
            size_of_val(&error),
            8,
            "the refusal cannot carry the supplied path"
        );
    }
}

#[cfg(windows)]
mod windows {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use moe_windows_job_broker::{StoreLockAuthority, StoreLockReason, SystemStoreLocks};

    const CHILD_STORE: &str = "MOE_STORE_LOCK_TEST_PATH";

    fn unique_store_path() -> String {
        let root = std::env::temp_dir().join(format!(
            "moe-store-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        std::fs::create_dir_all(&root).expect("create isolated parent");
        root.join("store.sqlite").to_string_lossy().into_owned()
    }

    #[test]
    fn real_windows_share_mode_zero_refuses_a_second_owner() {
        let path = unique_store_path();
        let locks = SystemStoreLocks;
        let first = locks.acquire(&path).expect("first exclusive owner");

        let refusal = match locks.acquire(&path) {
            Ok(_) => panic!("a second owner must be refused"),
            Err(error) => error,
        };
        assert_eq!(refusal.reason(), StoreLockReason::Contended);
        assert_eq!(
            refusal.code(),
            32,
            "ERROR_SHARING_VIOLATION is the measured contention"
        );

        drop(first);
        let _reopened = locks
            .acquire(&path)
            .expect("dropping the OS handle releases ownership");
    }

    #[test]
    fn existing_hard_link_aliases_are_refused_before_any_lock_is_opened() {
        let path = unique_store_path();
        std::fs::write(&path, b"sqlite bytes").expect("create store file");
        let alias = std::path::Path::new(&path).with_file_name("store-alias.sqlite");
        std::fs::hard_link(&path, &alias).expect("create real hard-link alias");
        let locks = SystemStoreLocks;

        for candidate in [&path, alias.to_str().expect("unicode alias path")] {
            let refusal = match locks.acquire(candidate) {
                Ok(_) => panic!("a multiply-linked store path must not acquire an adjacent lock"),
                Err(error) => error,
            };
            assert_eq!(refusal.reason(), StoreLockReason::PathRejected);
            assert_eq!(refusal.code(), 0);
        }
    }

    #[test]
    fn existing_symbolic_link_store_alias_is_refused() {
        use std::os::windows::fs::symlink_file;

        let path = unique_store_path();
        std::fs::write(&path, b"sqlite bytes").expect("create store file");
        let alias = std::path::Path::new(&path).with_file_name("store-symlink.sqlite");
        if let Err(error) = symlink_file(&path, &alias) {
            if error.raw_os_error() == Some(1314) {
                eprintln!("symlink privilege unavailable; hard-link alias test still exercises file identity");
                return;
            }
            panic!("create real symbolic-link alias: {error}");
        }

        let refusal = match SystemStoreLocks.acquire(alias.to_str().expect("unicode alias path")) {
            Ok(_) => panic!("a reparse-point store path must not acquire an adjacent lock"),
            Err(error) => error,
        };
        assert_eq!(refusal.reason(), StoreLockReason::PathRejected);
        assert_eq!(refusal.code(), 0);
    }

    #[test]
    fn store_lock_child() {
        let Ok(path) = std::env::var(CHILD_STORE) else {
            return;
        };
        let _guard = SystemStoreLocks
            .acquire(&path)
            .expect("child acquires lock");
        println!("LOCKED");
        std::io::stdout().flush().expect("announce lock");
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn killing_the_owner_releases_the_kernel_lock_without_stale_state() {
        let path = unique_store_path();
        let mut child = Command::new(std::env::current_exe().expect("test exe"))
            .args([
                "--exact",
                "windows::store_lock_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_STORE, &path)
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn lock holder");
        let mut child_output = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut ready = false;
        for _ in 0..8 {
            let mut line = String::new();
            child_output
                .read_line(&mut line)
                .expect("read child readiness");
            if line.contains("LOCKED") {
                ready = true;
                break;
            }
        }
        assert!(ready, "child must own the lock before contention");

        let locks = SystemStoreLocks;
        let refusal = match locks.acquire(&path) {
            Ok(_) => panic!("live child owns the lock"),
            Err(error) => error,
        };
        assert_eq!(refusal.reason(), StoreLockReason::Contended);
        child.kill().expect("kill lock holder");
        child.wait().expect("reap lock holder");

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match locks.acquire(&path) {
                Ok(_guard) => break,
                Err(error)
                    if error.reason() == StoreLockReason::Contended
                        && Instant::now() < deadline =>
                {
                    std::thread::yield_now()
                }
                Err(error) => panic!("kernel lock was not released: {error}"),
            }
        }
    }
}
