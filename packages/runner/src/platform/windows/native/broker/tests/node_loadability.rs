//! The RELEASE broker binary, launched by REAL Node with six real pipes.
//!
//! THIS TEST RUNS. No `#[ignore]`, no `cfg` gate, no stub. Every other test in
//! this crate hands the parser bytes it wrote itself, which proves the
//! arithmetic and proves the windows-sys calls COMPILE — never that a real
//! parent populates `lpReserved2` the way the parser assumes. This file is the
//! only thing that closes that seam.
//!
//! IT NEVER SKIPS. If Node is missing, is the wrong version, is the wrong
//! platform, or the release binary cannot be produced, it FAILS with a message
//! naming what was missing. A skip that reports success is exactly the vacuous
//! pass the DoD forbids, and it is the failure mode this file is most at risk
//! of, because every one of those conditions is easy to write as an early
//! `return`.
//!
//! IT ASSERTS THE INVENTORY, NOT THE EXIT CODE ALONE. A binary that exits 0
//! without looking at anything would satisfy an exit-code assertion. The broker
//! prints what it verified and this test reads that line.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The host the DoD pins. A different build is not this evidence.
const REQUIRED_NODE: &str = "v24.16.0";
const REQUIRED_PLATFORM: &str = "win32 x64";

/// What the broker prints on fd1 when all six descriptors verified.
const EXPECTED_INVENTORY: &str = "descriptors ready 6 of 6";

#[test]
fn real_node_hands_the_release_broker_six_pipes_and_it_verifies_all_of_them() {
    require_node();
    let broker = release_broker();

    let script = r#"
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.env.MOE_BROKER_EXE, [], {
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  encoding: 'utf8',
});
process.stdout.write('spawn-error=' + (result.error ? result.error.message : 'none') + '\n');
process.stdout.write('status=' + result.status + '\n');
process.stdout.write('signal=' + result.signal + '\n');
process.stdout.write('report=' + JSON.stringify(result.stdout) + '\n');
"#;

    let run = Command::new("node")
        .args(["-e", script])
        .env("MOE_BROKER_EXE", &broker)
        .output()
        .expect("node must be runnable to spawn the broker");

    let out = String::from_utf8_lossy(&run.stdout).into_owned();
    assert!(
        run.status.success(),
        "the node harness itself failed: {}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert!(out.contains("spawn-error=none"), "node could not spawn the release broker: {out}");
    assert!(out.contains("signal=null"), "the broker was killed rather than exiting: {out}");
    assert!(
        out.contains("status=0"),
        "the broker refused the six pipes real Node gave it: {out}"
    );
    // THE INVENTORY, not the exit code: the broker must say it verified six.
    assert!(
        out.contains(EXPECTED_INVENTORY),
        "the broker did not report all six descriptors verified as pipes: {out}"
    );
}

/// Refuses to run against anything but the pinned host.
///
/// Every branch here PANICS rather than returning, so there is no path on which
/// a missing prerequisite turns into a green test.
fn require_node() {
    let version = Command::new("node")
        .arg("--version")
        .output()
        .expect("node must be on PATH: this test cannot be satisfied without it");
    let version = String::from_utf8_lossy(&version.stdout).trim().to_owned();
    assert_eq!(version, REQUIRED_NODE, "the DoD pins Node {REQUIRED_NODE}, found {version}");

    let platform = Command::new("node")
        .args(["-p", "process.platform + ' ' + process.arch"])
        .output()
        .expect("node must report its platform");
    let platform = String::from_utf8_lossy(&platform.stdout).trim().to_owned();
    assert_eq!(platform, REQUIRED_PLATFORM, "the DoD pins {REQUIRED_PLATFORM}, found {platform}");
}

/// Builds and returns the RELEASE broker binary.
///
/// RESOLVED, NOT GUESSED. `CARGO_BIN_EXE_*` is an absolute path to this
/// package's binary under the target directory cargo was actually given, so the
/// target root is two components up from it and needs no knowledge of `dist/`,
/// the workspace layout, or the current directory.
///
/// BUILT INTO A NESTED TARGET DIRECTORY ON PURPOSE. `cargo test` holds the build
/// lock on its target directory for the whole run, so a nested `cargo build`
/// against the same directory would deadlock rather than fail. A sibling
/// directory has no such contention. The alternative — requiring the release
/// binary to already exist — makes the test's outcome depend on what someone ran
/// beforehand, which is how it would come to pass vacuously.
fn release_broker() -> PathBuf {
    let test_binary = Path::new(env!("CARGO_BIN_EXE_moe-windows-job-broker"));
    let target_root = test_binary
        .parent()
        .and_then(Path::parent)
        .expect("a cargo binary always sits two levels inside the target directory");
    let nested = target_root.join("node-loadability");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the broker package always sits inside its workspace root")
        .join("Cargo.toml");

    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let status = Command::new(cargo)
        .args(["build", "--locked", "--release", "-p", "moe-windows-job-broker"])
        .arg("--manifest-path")
        .arg(&manifest)
        .arg("--target-dir")
        .arg(&nested)
        .status()
        .expect("cargo must be runnable to produce the release broker");
    assert!(status.success(), "the release build of the broker failed");

    let broker = nested.join("release").join("moe-windows-job-broker.exe");
    assert!(broker.is_file(), "the release broker binary was not produced where cargo puts it");
    broker
}
