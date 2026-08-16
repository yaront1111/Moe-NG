import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, win32 } from "node:path";

import type { WindowsProcessUnknown } from "../../platform/windows/windows-process-contract.js";
import type {
  ClaudeFailure,
  ClaudeObservationErrorCode,
  ProviderRuntimeObservation,
} from "./claude-observation.js";
import { observeInstalledClaudeRuntime } from "./claude-host-runtime.js";
import { refuse, type ClaudeRuntimePinFailure } from "./claude-runtime-pin-closure.js";
import { fold, pathShapeRejection } from "./claude-runtime-source.js";

/**
 * The other half of the asymmetry `createClaudeRuntimePinRequest` created.
 *
 * That factory validates a caller's `quotedObservation` against one the runner
 * makes itself, and it compares exactly `reportedVersion`,
 * `adapterCapabilitySchemaDigest` and `platformIdentity` — three facts no
 * consumer can mint, because the capability digest and the version can only come
 * from an observation this package performed. So a quote a caller assembled, even
 * one whose closure hashes and paths are all TRUE, is refused
 * `CLAUDE_RUNTIME_OBSERVATION_CHANGED`. That is correct and stays correct.
 *
 * What was missing was any way to OBTAIN a quote. This module is it, and it does
 * not re-open the seam `observeInstalledClaudeRuntime` is withheld to close: the
 * steerability that function is dangerous for lives in its `executablePath`
 * ARGUMENT, not in the fact that it returns an observation. Discovery takes NO
 * argument at all. A consumer gets an observation of THE installed runtime
 * without any way to say WHICH runtime gets observed — the host answers that,
 * and this module is the only thing that may hold that argument.
 *
 * Consumers: task-6cbff01023b14b26a78fc5e3eb1dd8a9 (dispatch), the Foundation
 * ingress chain (task-a9fd91c373c244c78df97945965a8038) and
 * task-44d4873eb9f746b1a978e97ff9743dc4.
 */
export interface DiscoveredClaudeRuntime {
  readonly ok: true;
  /** Quotable as-is: `createClaudeRuntimePinRequest` accepts exactly this. */
  readonly observation: ProviderRuntimeObservation;
  /**
   * The directory the resolved executable really lives in. Published because the
   * pin request needs it and deriving it would make every consumer reimplement
   * the same dirname; it discloses nothing the observation's own closure entry
   * does not already carry.
   */
  readonly installedRoot: string;
}

/**
 * Four authorities can answer here and each keeps its OWN code and layer.
 * Flattening them into a discovery vocabulary would erase which one refused,
 * which is the fact a caller most needs — `ClaudeFailure` deliberately declares
 * no layer at all, and inventing one for it would be a fabricated attribution.
 */
export type DiscoverInstalledClaudeRuntimeResult =
  | DiscoveredClaudeRuntime
  | ClaudeRuntimePinFailure
  | ClaudeFailure<ClaudeObservationErrorCode>
  | WindowsProcessUnknown;

const EXECUTABLE_NAME = "claude.exe";
/**
 * A ceiling on the host search path, and it REFUSES rather than truncating.
 * Silently scanning a prefix would hand back the steering lever this module
 * exists to remove: pad the search path and the real install falls off the end,
 * leaving one shadowing candidate to win uncontested.
 */
const MAX_SEARCH_ENTRIES = 512;
/**
 * The platform's known install location, and deliberately just the one this
 * runtime actually ships to. A speculative list is not host configuration, and
 * every extra directory is another place a shadowing binary could turn a working
 * host into an ambiguity refusal.
 */
const KNOWN_INSTALL_SEGMENTS = Object.freeze([".local", "bin"] as const);

/** Path-free by construction: the code is the reason, never the host's layout. */
const discoveryRefusal = (
  code: "CLAUDE_RUNTIME_PATH_MISSING" | "CLAUDE_RUNTIME_PATH_DUPLICATE"
    | "CLAUDE_RUNTIME_PATH_INVALID" | "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
  message: string,
): ClaudeRuntimePinFailure => refuse(code, message);

/**
 * The host's own configuration and nothing else: its search path, plus the one
 * install location this runtime ships to.
 *
 * There is deliberately NO hint, override or dedicated environment variable a
 * caller could set to choose a binary. A caller who can influence this set can
 * only ADD to it, and adding turns one candidate into two, which refuses — the
 * lever moves the host to a fail-closed answer instead of to a chosen one.
 */
function searchDirectories(): readonly string[] | ClaudeRuntimePinFailure {
  const declared = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry.length > 0);
  if (declared.length > MAX_SEARCH_ENTRIES) {
    return discoveryRefusal(
      "CLAUDE_RUNTIME_PATH_INVALID",
      "the host search path declares more entries than discovery will scan",
    );
  }
  let home = "";
  try {
    home = homedir();
  } catch {
    // A host with no resolvable home simply contributes no known location.
    home = "";
  }
  return home.length === 0
    ? declared
    : [...declared, win32.join(home, ...KNOWN_INSTALL_SEGMENTS)];
}

/**
 * Canonicalises before counting, so one binary reachable two ways — listed twice
 * on the search path, or found both there and at the known install location — is
 * ONE candidate rather than a false ambiguity. Folded because Windows path
 * identity is case-insensitive.
 */
async function canonicalCandidate(directory: string): Promise<string | null> {
  const candidate = win32.join(directory, EXECUTABLE_NAME);
  if (pathShapeRejection(candidate) !== null) return null;
  let resolved: string;
  try {
    // `stat` THROWS on a missing entry rather than answering falsy, so the guard
    // has to live inside the catch's reach.
    if (!(await stat(candidate)).isFile()) return null;
    resolved = await realpath(candidate);
  } catch {
    return null;
  }
  return pathShapeRejection(resolved) === null ? resolved : null;
}

async function resolveCandidates(): Promise<readonly string[] | ClaudeRuntimePinFailure> {
  const directories = searchDirectories();
  if (!Array.isArray(directories)) return directories as ClaudeRuntimePinFailure;
  const found = new Map<string, string>();
  for (const directory of directories as readonly string[]) {
    const resolved = await canonicalCandidate(directory);
    if (resolved !== null) found.set(fold(resolved), resolved);
  }
  return [...found.values()];
}

/**
 * Answers a quoted `ProviderRuntimeObservation` for the runtime that is really
 * installed on THIS host, or the refusal of whichever authority declined.
 *
 * Takes no argument, and that absence is the deliverable rather than an
 * omission: a parameter is what a caller would steer with, and a runtime
 * rejection of one would be a single refactor away from being relaxed.
 *
 * Refuses ambiguity in BOTH directions. Zero candidates is a refusal because
 * there is nothing to observe; more than one is a refusal because picking would
 * let anyone able to shadow a binary on the search path decide what the host
 * "observed". Neither arm ever names a path it searched.
 */
export async function discoverInstalledClaudeRuntime(): Promise<DiscoverInstalledClaudeRuntimeResult> {
  // FIRST, before any directory is read: resolution looks for a Windows
  // executable, and the observer behind it is win32-only. Scanning a POSIX host
  // would answer "nothing found", which is a different and misleading reason.
  if (process.platform !== "win32") {
    return discoveryRefusal(
      "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
      "installed runtime discovery requires win32",
    );
  }
  const candidates = await resolveCandidates();
  if (!Array.isArray(candidates)) return candidates as ClaudeRuntimePinFailure;
  const resolved = candidates as readonly string[];
  if (resolved.length === 0) {
    return discoveryRefusal(
      "CLAUDE_RUNTIME_PATH_MISSING",
      "no installed claude runtime resolved from this host's own configuration",
    );
  }
  if (resolved.length > 1) {
    return discoveryRefusal(
      "CLAUDE_RUNTIME_PATH_DUPLICATE",
      "more than one installed claude runtime resolved, and discovery does not choose between them",
    );
  }
  const executablePath = resolved[0] as string;
  const installedRoot = win32.dirname(executablePath);
  // The ONLY call site in this package that may hand `observeInstalledClaudeRuntime`
  // an `executablePath`, and it hands it one no caller chose.
  const observed = await observeInstalledClaudeRuntime({ installedRoot, executablePath });
  if (!("ok" in observed && observed.ok === true)) {
    // Unchanged, with its own code and its own layer. Four authorities can
    // answer here; restamping would erase which of them did.
    return observed;
  }
  return Object.freeze({
    ok: true as const,
    observation: observed.observation,
    installedRoot,
  });
}
