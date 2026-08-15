# A `cargo build` inside a `cargo test` deadlocks on the target directory

Found 2026-08-10 writing a test that must exercise the RELEASE binary (task-05bf0e0f).

## The situation
A test needs the release build of its own package — `cargo test` only produces the test
profile, so `CARGO_BIN_EXE_<name>` points at `<target>/debug/<name>.exe`, never `release/`.

The obvious move is to shell out to `cargo build --release` from inside the test. **It hangs.**
`cargo test` holds the build lock on its target directory for the whole run, so the nested
invocation blocks waiting for a lock its own parent will not release until it exits. It does
not fail with an error; it waits.

## The fix
Give the nested build a sibling target directory. No contention, and the binary lands
somewhere deterministic:

```rust
let test_bin = Path::new(env!("CARGO_BIN_EXE_my-package"));   // <target>/debug/my-package.exe
let target_root = test_bin.parent().and_then(Path::parent).unwrap();
let nested = target_root.join("node-loadability");
// cargo build --locked --release -p my-package --manifest-path <ws> --target-dir <nested>
let bin = nested.join("release").join("my-package.exe");
```

Deriving the target root from `CARGO_BIN_EXE_*` means the test needs no knowledge of
`--target-dir`, the workspace layout, or the current directory. Check the nested path is
covered by `.gitignore` (`git check-ignore -v`) — it is a second build tree.

## Why not just require the binary to exist
Because then the test's outcome depends on what someone ran beforehand, and the natural
"binary missing -> skip" turns a prerequisite failure into a green run. Build it and assert
the build's exit status; assert the file exists afterwards. Never skip.
