/**
 * HOSTILE FIXTURES for the evidence/workspace/supervision group of the runtime-provider axis.
 *
 * NOT a `*.security.ts` file: the lane collects that suffix and a fixture module registering as
 * a suite with no cases would fail `passWithNoTests: false`.
 *
 * IT DECIDES NOTHING. It builds hostile inputs and injectable ports; every expected code and
 * layer is written at the case, taken from the boundary's own exported constant. The ports
 * below THROW on any call the gate under test must not reach, so a fixture that got further
 * than intended fails loudly instead of passing quietly.
 */

import type { ArtifactFsPort } from "../../packages/runner/src/artifacts/artifact-contract.js";
import type { ProcessLauncher } from "../../packages/runner/src/evidence/verifier-process-launcher.js";
import type { RunVerifierProcessInput } from "../../packages/runner/src/evidence/verifier-process-contract.js";

export const POISON_PATH = "D:\\forged\\artifacts\\objects";
export const POISON_DIGEST = "b".repeat(64);
export const EVIDENCE_SECRETS: readonly string[] = Object.freeze([POISON_PATH, POISON_DIGEST]);

/**
 * THE CONTAINMENT ESCAPE FAMILY, hand-written and labelled. Every member is a distinct way a
 * filesystem can reinterpret a path into something outside the root, and each case that sweeps
 * this list asserts a POSITIVE member count first — a family that silently emptied would make
 * every loop over it pass while testing nothing.
 *
 * The THIRD tuple element is the exact code the scope canonicaliser must answer with. Asserting
 * only "it refused" would stay green if a rule were removed: `observeScope` would fall through
 * to the git observer, which this fixture makes throw, and refuse with a different code. Pinning
 * the code per member is what makes a removed rule redden.
 *
 * THE THIRD TUPLE ELEMENT is the exact code the scope canonicaliser must answer with. Asserting
 * only "it refused" would stay green if a rule were removed: `observeScope` would fall through
 * to the git observer, which `scopeInput` makes throw, and refuse with a different code. Pinning
 * the code per member is what makes a removed canonicalisation rule redden.
 *
 * A symlink target is NOT in this list: it cannot be expressed as a literal, so the cases build
 * a real one under a realpath'd temp root and assert containment AFTER canonicalisation. That
 * ordering is load-bearing on macOS, where `tmpdir()` is the symlink `/var` over `/private/var`
 * and a naive string comparison reads a legitimate root as an escape.
 */
export const ESCAPE_FAMILY: readonly (readonly [string, string, string])[] = Object.freeze([
  ["dot-dot traversal", "../escape.txt", "RUNNER_SCOPE_PATH_DOT_SEGMENT"],
  ["embedded traversal", "src/../../escape.txt", "RUNNER_SCOPE_PATH_DOT_SEGMENT"],
  ["single dot segment", "./escape.txt", "RUNNER_SCOPE_PATH_DOT_SEGMENT"],
  ["posix absolute", "/etc/passwd", "RUNNER_SCOPE_PATH_ABSOLUTE"],
  ["windows drive qualified", "C:/Windows/System32/cmd.exe", "RUNNER_SCOPE_PATH_DRIVE_QUALIFIED"],
  ["backslash separator", "src\\escape.txt", "RUNNER_SCOPE_PATH_BACKSLASH"],
  ["reserved device name", "src/nul", "RUNNER_SCOPE_PATH_RESERVED_DEVICE"],
  ["trailing space", "src/escape.txt ", "RUNNER_SCOPE_PATH_TRAILING_DOT_OR_SPACE"],
  ["embedded NUL", "src/escape\u0000.txt", "RUNNER_SCOPE_OBSERVATION_FAILED"],
]);

/** An artifact filesystem port. `list: null` removes the listing capability entirely, which is
 *  a DIFFERENT fact from a directory that could not be read — the two answer at two layers. */
export function artifactFs(options: {
  exists?: boolean;
  list?: null;
  throws?: boolean;
}): ArtifactFsPort {
  const port: Record<string, unknown> = {
    exists: () => options.exists ?? true,
    readBytes: () => {
      throw new Error("no byte read may be reached past the enumeration gate");
    },
  };
  if (options.list !== null) {
    port["listDirectory"] = (): never[] => {
      if (options.throws === true) throw new Error("io");
      return [];
    };
  }
  return port as unknown as ArtifactFsPort;
}

/**
 * A verifier launch input. The launcher RECORDS into `spawns` and then throws, so a case can
 * prove no child was created by asserting the array is empty AND know immediately if the gate
 * ever let one through.
 */
export function verifierInput(
  spawns: string[],
  over: Record<string, unknown>,
): RunVerifierProcessInput {
  const launcher: ProcessLauncher = {
    launch: (spec): never => {
      spawns.push(spec.file);
      throw new Error("the launch gate must refuse before any child is created");
    },
  };
  return {
    recipe: { sha256: POISON_DIGEST, argv: ["node", "--version"] },
    inputManifest: { sha256: POISON_DIGEST, baseIdentity: "base" },
    candidateBaseIdentity: "base",
    activation: { intent: null, attempt: null, grant: null },
    wrapperIdentity: "wrapper",
    candidateRoot: "D:\\candidate",
    runtimeObservation: {},
    outputs: [],
    launcher,
    clock: () => 0,
    baseEnvironment: {},
    timeoutMs: 500,
    ...over,
  } as unknown as RunVerifierProcessInput;
}

/** A scope observation request whose scalars are all valid, so the path rules — and only the
 *  path rules — are what a case under test can be answered by. */
export function scopeInput(over: Record<string, unknown>): Record<string, unknown> {
  return {
    observerVersion: "moe-scope-observer/1",
    baseIdentity: "a".repeat(40),
    worktreeRoot: "D:\\candidate",
    observedAt: "2026-08-16T00:00:00.000Z",
    declaredScopePaths: ["src/a.ts"],
    gitObserver: {
      headCommit: () => {
        throw new Error("no git call may be reached past the path rules");
      },
    },
    pathObserver: {},
    ...over,
  };
}
