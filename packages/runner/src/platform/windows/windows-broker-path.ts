import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unknownOutcome, type WindowsProcessUnknown } from "./windows-process-contract.js";

/**
 * Deterministic resolution of the built broker binary, and the loadability
 * check that stands in for DoD 5's "runtime-loadable".
 *
 * WHERE THE VERSION PIN ACTUALLY LIVES. The "native dependency" is the broker
 * BINARY produced by the pinned Rust toolchain, and that pin is already
 * upstream and committed: native/rust-toolchain.toml fixes rustc 1.96.0,
 * native/Cargo.lock is committed, and windows-sys is exact-pinned `=0.61.2`
 * (the leading `=` forbids 0.61.3, where a bare "0.61.2" would accept it). So
 * this module adds the two things that pin does NOT provide — finding the
 * artefact, and failing when it is absent.
 *
 * NO PREBUILT BINARY IS VENDORED. `dist/` is git-ignored (.gitignore:4), so the
 * artefact never enters a commit; it is produced by
 * `cargo build --locked --release --manifest-path <native>/Cargo.toml
 *  --target-dir dist/windows-job-native -p moe-windows-job-broker`.
 *
 * AN ABSENT BROKER FAILS. It does not fall back to a shell, to `taskkill`, or
 * to PID enumeration — none of those can prove a process tree dead, which is
 * the entire reason the broker exists.
 */

/** Relative to the workspace root, matching the gate's `--target-dir`. */
export const BROKER_RELATIVE_PATH = join(
  "dist",
  "windows-job-native",
  "release",
  "moe-windows-job-broker.exe",
);

/** The file that marks the workspace root. Searched for, never hop-counted. */
const ROOT_MARKER = "pnpm-workspace.yaml";

/** Enough to reach the root from anywhere in this repository, and no further. */
const MAX_ASCENT = 12;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // `stat` THROWS on a missing path rather than returning something falsy, so
    // the absent case has to be caught or it escapes as an exception from a
    // seam whose whole contract is to refuse rather than throw.
    return false;
  }
}

/**
 * Walks up looking for the root marker rather than counting directory hops.
 *
 * A fixed hop count is silently wrong the day this file moves: every assertion
 * over the smaller tree still passes, and the failure surfaces as "the broker
 * is missing" rather than "the root was wrong".
 */
export function findWorkspaceRoot(from: string): string | null {
  let at = resolve(from);
  for (let ascent = 0; ascent < MAX_ASCENT; ascent += 1) {
    if (isFile(join(at, ROOT_MARKER))) {
      return at;
    }
    const parent = dirname(at);
    if (parent === at) {
      return null;
    }
    at = parent;
  }
  return null;
}

function unresolved(message: string): WindowsProcessUnknown {
  return unknownOutcome(
    "PROCESS_BOUNDARY_BROKER_UNRESOLVED",
    "WINDOWS_PROCESS_RESOLUTION",
    message,
  );
}

/**
 * The absolute path of the built broker, or a typed UNKNOWN.
 *
 * `root` exists so a test can point at a directory that provably has no broker;
 * left out, the workspace root is discovered from this module's own location.
 */
export function resolveBrokerBinary(root?: string): string | WindowsProcessUnknown {
  const discovered = root ?? findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  if (discovered === null) {
    return unresolved("the workspace root could not be located from this module");
  }
  const binary = join(discovered, BROKER_RELATIVE_PATH);
  if (!isFile(binary)) {
    return unresolved("the release broker binary has not been built");
  }
  return binary;
}
