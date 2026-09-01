//! Store-lock contract and real-kernel contention.

use moe_windows_job_broker::{
    validate_store_path, RefusalLayer, Refused, StoreLockError, StoreLockReason,
};

#[test]
fn store_lock_reason_vocabulary_is_closed_and_contention_is_stable() {
    // THE ORDER IS A CROSS-LANGUAGE CONTRACT, not an implementation detail.
    // task-a341bfb6 committed the TypeScript side against these exact numbers:
    //
    //   packages/runner/src/platform/windows/windows-project-stack-boundary.test.ts
    //     brokerReason: { layer: "BROKER_STORE_LOCK", reason: 1, code: 32 }
    //
    // `reason: 1` IS Contended's ordinal, and nothing on the TypeScript side
    // reads the name. Reordering StoreLockReason::ALL would leave this crate
    // compiling and silently re-point that decoded value at a different
    // refusal, so the ordinals are pinned BY VALUE here: a reorder has to break
    // both sides at once instead of drifting past one of them.
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

    // THE LONGEST ADMISSIBLE PATH, asserted at the boundary rather than near
    // it. The budget is not MAX_PATH: the authority appends ".moe-stack.lock"
    // and a NUL to build the adjacent lock name, so the store path itself may
    // only use 260 - 15 - 1 = 244 UTF-16 units.
    let longest = format!("C:\\{}", "a".repeat(241));
    assert_eq!(longest.encode_utf16().count(), 244);
    assert_eq!(validate_store_path(&longest), Ok(()));
}

#[test]
fn store_paths_outside_the_length_boundary_are_refused() {
    // One unit past the admitted maximum above, and the degenerate empty path.
    // Both are PathRejected with code 0 — no Win32 call is ever made, so there
    // is no OS code to carry.
    let over_long = format!("C:\\{}", "a".repeat(242));
    assert_eq!(over_long.encode_utf16().count(), 245);

    for path in ["", over_long.as_str()] {
        let error = validate_store_path(path).expect_err("the path must be rejected");
        assert_eq!(error.reason(), StoreLockReason::PathRejected);
        assert_eq!(error.code(), 0);
    }
}

#[test]
fn hostile_or_ambiguous_store_paths_are_refused_without_echo_fields() {
    let cases = [
        "store.sqlite",
        "\\\\server\\share\\store.sqlite",
        "\\\\?\\C:\\projects\\store.sqlite",
        "C:/projects/store.sqlite",
        "C:\\projects\\..\\store.sqlite",
        "C:\\projects\\NUL.sqlite",
        "C:\\projects\\store.sqlite ",
        // Drive-absolute and correctly prefixed, so only the forward-slash
        // clause refuses it. Without this case that clause has no witness of
        // its own: every other slash-bearing case above fails an earlier test.
        "C:\\projects/store.sqlite",
        "C:\\projects\\sto\0re.sqlite",
        // An NTFS 8.3 alias is a SECOND name for one file, and the lock is
        // adjacent-by-name, so admitting it would hand out two locks for one
        // store. Refused by name alone, with no privilege and no filesystem.
        "C:\\projects\\STORE~1.SQL",
    ];
    // A swept case set that silently produces zero cases passes vacuously.
    assert_eq!(cases.len(), 10, "every hostile case must actually be swept");

    for path in cases {
        // NAMED, not `expect_err`. A swept assertion that fails anonymously
        // tells you the sweep broke but not which input broke it, and with ten
        // cases guarding five different clauses that is the difference between
        // a diagnosis and a bisect. The path is a test-local literal, so
        // printing it leaks nothing.
        let error = match validate_store_path(path) {
            Ok(()) => panic!("the path must be rejected: {path:?}"),
            Err(error) => error,
        };
        assert_eq!(
            error.reason(),
            StoreLockReason::PathRejected,
            "wrong reason for {path:?}"
        );
        assert_eq!(error.code(), 0, "wrong code for {path:?}");
        assert_eq!(
            size_of_val(&error),
            8,
            "the refusal cannot carry the supplied path"
        );
    }
}

#[test]
fn a_store_lock_refusal_carries_no_caller_text_in_its_debug_output() {
    // size_of == 8 proves the error cannot STORE a path. It does not prove the
    // Debug OUTPUT carries none — a formatter is free to interpolate anything
    // it can reach. This asserts the rendered string exactly.
    let rejected = StoreLockError::new(StoreLockReason::PathRejected, 0);
    assert_eq!(
        format!("{rejected:?}"),
        "StoreLockError { reason: PathRejected, code: 0 }"
    );

    // Two DIFFERENT hostile paths, one carrying a distinctive project name,
    // must be INDISTINGUISHABLE once refused. Equality of the errors is the
    // security property: a refusal that differs by input leaks the input.
    let named = validate_store_path("C:\\projects\\..\\alpha-secret-customer.sqlite")
        .expect_err("the traversal path must be rejected");
    let bare = validate_store_path("store.sqlite").expect_err("the relative path must be rejected");
    assert_eq!(named, bare);
    assert_eq!(format!("{named:?}"), format!("{bare:?}"));
    assert!(
        !format!("{named:?}").contains("alpha-secret-customer"),
        "the refusal must not echo the store path"
    );
}

#[test]
fn a_store_lock_refusal_reaches_the_wire_as_layer_four() {
    // The exact refusal the TypeScript consumer decodes. Contention on a
    // Windows store is ERROR_SHARING_VIOLATION, so this is the real pair the
    // boundary carries rather than a synthetic one.
    let refused = Refused::store_lock(StoreLockError::new(StoreLockReason::Contended, 32));

    assert_eq!(refused.layer(), RefusalLayer::StoreLock);
    assert_eq!(refused.reason(), 1);
    assert_eq!(refused.code(), 32);

    // The STATUS payload byte-for-byte: layer wire, then reason and code both
    // little-endian. This is what windows-project-stack-boundary.test.ts reads
    // back as `brokerReason: { layer: "BROKER_STORE_LOCK", reason: 1, code: 32 }`.
    let payload = refused.payload();
    assert_eq!(payload, [4, 1, 0, 32, 0, 0, 0]);
    assert_eq!(
        RefusalLayer::from_wire(payload[0]),
        Some(RefusalLayer::StoreLock),
        "the emitted layer byte must round-trip back to StoreLock BY NAME"
    );
}

#[cfg(windows)]
mod windows {
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use moe_windows_job_broker::{StoreLockAuthority, StoreLockReason, SystemStoreLocks};

    const CHILD_STORE: &str = "MOE_STORE_LOCK_TEST_PATH";

    fn unique_store_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "moe-store-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos(),
        ));
        std::fs::create_dir_all(&root).expect("create isolated parent");
        root
    }

    fn unique_store_path() -> String {
        unique_store_root()
            .join("store.sqlite")
            .to_string_lossy()
            .into_owned()
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
    fn a_directory_at_the_store_path_is_refused_as_a_path_rejection() {
        // The sole witness for the `!metadata.is_file()` half of the identity
        // check: a directory is neither a reparse point nor multiply linked,
        // so no other clause would refuse it.
        let root = unique_store_root();
        let path = root.join("store.sqlite");
        std::fs::create_dir(&path).expect("create a directory AT the store path");

        let refusal = match SystemStoreLocks.acquire(path.to_str().expect("unicode store path")) {
            Ok(_) => panic!("a directory must not acquire an adjacent lock"),
            Err(error) => error,
        };
        assert_eq!(refusal.reason(), StoreLockReason::PathRejected);
        assert_eq!(refusal.code(), 0);
    }

    #[test]
    fn an_absent_parent_directory_reports_open_failed_with_the_windows_code() {
        // OpenFailed's only real-code witness. The identity probe returns Ok
        // for a store that does not exist, so this reaches CreateFileW on the
        // adjacent lock name and fails there with a genuine Win32 code.
        let path = unique_store_root().join("missing").join("store.sqlite");

        let refusal = match SystemStoreLocks.acquire(path.to_str().expect("unicode store path")) {
            Ok(_) => panic!("a store under an absent directory cannot be locked"),
            Err(error) => error,
        };
        assert_eq!(refusal.reason(), StoreLockReason::OpenFailed);
        assert_eq!(
            refusal.code(),
            3,
            "ERROR_PATH_NOT_FOUND, forwarded unflattened"
        );
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
    fn an_eight_dot_three_short_name_alias_is_refused() {
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

        let root = unique_store_root();
        let path = root.join("store.sqlite");
        std::fs::write(&path, b"sqlite bytes").expect("create store file");
        let long = path.to_str().expect("unicode store path").to_owned();

        let wide: Vec<u16> = long.encode_utf16().chain([0]).collect();
        let mut buffer = [0u16; 260];
        // SAFETY: the input is NUL-terminated and live for the call, and the
        // output buffer's declared length describes it exactly.
        let written =
            unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
        assert_ne!(written, 0, "GetShortPathNameW must answer for a real file");
        let short =
            String::from_utf16(&buffer[..written as usize]).expect("the short name is UTF-16");

        if short == long {
            // Announced rather than silent. A skip that prints nothing is
            // indistinguishable from a pass, which is the failure mode this
            // whole file exists to avoid.
            eprintln!(
                "SKIPPED an_eight_dot_three_short_name_alias_is_refused: 8.3 short names are \
                 disabled on this volume. The privilege-free witness is the STORE~1.SQL case in \
                 hostile_or_ambiguous_store_paths_are_refused_without_echo_fields."
            );
            return;
        }

        let _guard = SystemStoreLocks
            .acquire(&long)
            .expect("the long name acquires the lock");
        let refusal = match SystemStoreLocks.acquire(&short) {
            Ok(_) => panic!("an 8.3 alias must not acquire a second adjacent lock"),
            Err(error) => error,
        };
        assert_eq!(refusal.reason(), StoreLockReason::PathRejected);
        assert_eq!(refusal.code(), 0);

        let locks: Vec<_> = std::fs::read_dir(&root)
            .expect("read the isolated parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".moe-stack.lock")
            })
            .collect();
        assert_eq!(
            locks.len(),
            1,
            "one store may own exactly one adjacent lock"
        );
    }

    #[test]
    #[ignore = "needs SeCreateSymbolicLinkPrivilege or Developer Mode; run with --ignored from an elevated shell"]
    fn existing_symbolic_link_store_alias_is_refused() {
        use std::os::windows::fs::symlink_file;

        let path = unique_store_path();
        std::fs::write(&path, b"sqlite bytes").expect("create store file");
        let alias = std::path::Path::new(&path).with_file_name("store-symlink.sqlite");
        // No privilege fallback. Previously this arm caught error 1314, printed
        // a note and returned, so on an unprivileged host it reported `ok`
        // while asserting nothing — a vacuous pass wearing a green tick. It is
        // now #[ignore]d, so a host that cannot run it says so.
        symlink_file(&path, &alias).expect("create real symbolic-link alias");

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
