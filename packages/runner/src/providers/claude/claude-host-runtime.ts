import { arch, release } from "node:os";

import { readHostIdentity, snapshotExactRecord } from "../../platform/platform-contract.js";
import { openWindowsProcessBoundary } from "../../platform/windows/windows-boundary.js";
import type { WindowsProcessUnknown } from "../../platform/windows/windows-process-contract.js";
import { isBoundedLabel, type ClaudeCapabilityProfile, type ClaudeProbeReport } from "./claude-capabilities.js";
import { MAX_RUNTIME_TEXT_CHARS, type ClaudeFailure, type ClaudeObservationErrorCode,
  type PlatformIdentity, type ProviderRuntimeObservation } from "./claude-observation.js";
import { probeClaudeRuntime } from "./claude-probe.js";
import { refuse, type ClaudeRuntimePinErrorCode, type ClaudeRuntimePinFailure }
  from "./claude-runtime-pin-closure.js";
import { createNodeClaudeRuntimeFs } from "./claude-runtime-pin-fs.js";
import type { ClaudeRuntimeFacts } from "./claude-runtime-pin.js";
import { inspectSources, pathShapeRejection, snapshotSourceCandidates,
  type SourceEntry } from "./claude-runtime-source.js";

/**
 * The production Windows host adapter: fresh facts about the runtime that is
 * really installed on THIS machine.
 *
 * Its input is bounded plain data and nothing else. No filesystem, clock, probe
 * port or process seam appears on the surface, because an injectable seam here
 * would let a caller decide what the host "observed" — which is exactly the gap
 * this module was created to close. Every capability it cannot prove stays
 * UNSUPPORTED, and every refusal keeps the code AND the layer of whichever
 * authority answered instead of being restamped into one flat vocabulary.
 *
 * Consumers: task-75ee4a84bdd14d06b672abb18ed48cba (pin-request hydration) and
 * ultimately task-6cbff01023b14b26a78fc5e3eb1dd8a9.
 */
export interface InstalledClaudeRuntimeInput {
  readonly installedRoot: string;
  readonly executablePath: string;
  readonly versionTimeoutMs?: number;
}

export interface ObservedInstalledClaudeRuntime {
  readonly ok: true;
  readonly observation: ProviderRuntimeObservation;
  readonly facts: ClaudeRuntimeFacts;
  readonly profile: ClaudeCapabilityProfile;
}

export type ObserveInstalledClaudeRuntimeResult =
  | ObservedInstalledClaudeRuntime
  | ClaudeRuntimePinFailure
  | ClaudeFailure<ClaudeObservationErrorCode>
  | WindowsProcessUnknown;

/** A version probe is a sub-second question; the boundary's own default is 30 minutes. */
const DEFAULT_VERSION_TIMEOUT_MS = 10_000;
const MAX_VERSION_TIMEOUT_MS = 600_000;
const VERSION_ARGUMENT = "--version";
/** `2.1.233 (Claude Code)` — a leading `v`, a word, or empty output is NOT this shape. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?(?:\s+\(.{1,100}\))?$/u;
const INPUT_KEYS = Object.freeze(["installedRoot", "executablePath", "versionTimeoutMs"] as const);
const REQUIRED_KEYS = Object.freeze(["installedRoot", "executablePath"] as const);
/** Bounded, allowlisted, and never echoed back out of a failure path. */
const PASSED_ENVIRONMENT = Object.freeze(["SYSTEMROOT", "PATH"] as const);

interface HostRequest {
  readonly installedRoot: string;
  readonly executablePath: string;
  readonly timeoutMs: number;
}

const invalid = (reason: string): ClaudeRuntimePinFailure =>
  refuse("CLAUDE_RUNTIME_OBSERVATION_INVALID", `installed runtime request ${reason}`);

/**
 * Hardens hostile input into a frozen plain snapshot BEFORE any I/O, so nothing
 * the caller still holds can change a path that has already been validated.
 */
function snapshotRequest(input: unknown): HostRequest | ClaudeRuntimePinFailure {
  const snapshot = snapshotExactRecord(input, INPUT_KEYS) ?? snapshotExactRecord(input, REQUIRED_KEYS);
  if (snapshot === null) {
    return invalid("is not an exact record of installedRoot, executablePath and an optional timeout");
  }
  const timeout = snapshot["versionTimeoutMs"] ?? DEFAULT_VERSION_TIMEOUT_MS;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout)
    || timeout <= 0 || timeout > MAX_VERSION_TIMEOUT_MS) {
    return invalid("carries a timeout that is not a positive safe integer of bounded milliseconds");
  }
  for (const key of REQUIRED_KEYS) {
    if (typeof snapshot[key] !== "string") return invalid(`carries a ${key} that is not text`);
  }
  const installedRoot = snapshot["installedRoot"] as string;
  const executablePath = snapshot["executablePath"] as string;
  for (const value of [installedRoot, executablePath]) {
    const shape = pathShapeRejection(value);
    if (shape !== null) return refuse("CLAUDE_RUNTIME_PATH_INVALID", `an installed runtime path ${shape}`);
  }
  return Object.freeze({ installedRoot, executablePath, timeoutMs: timeout });
}

/**
 * The inspector builds its prose from `JSON.stringify(candidate.path)`, so
 * forwarding it verbatim publishes the installed path (task rail 2). Keeps the
 * authority's code and layer — which carry the reason — replacing only prose.
 */
const closureRefusal = (code: ClaudeRuntimePinErrorCode): ClaudeRuntimePinFailure =>
  refuse(code, "the declared runtime closure could not be verified");

/** The supported v1 closure is the ONE named native executable, never a walk. */
async function inspectClosure(
  fs: ReturnType<typeof createNodeClaudeRuntimeFs>,
  request: HostRequest,
  realRoot: string,
): Promise<readonly SourceEntry[] | ClaudeRuntimePinFailure> {
  const candidates = snapshotSourceCandidates([{ kind: "EXECUTABLE", path: request.executablePath }]);
  if ("code" in candidates) return closureRefusal(candidates.code);
  const quoted = candidates.map((candidate) => ({ ...candidate, expectedSha256: null }));
  const inspected = await inspectSources(fs, quoted, realRoot);
  return "code" in inspected ? closureRefusal(inspected.code) : inspected;
}

function environmentSnapshot(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of PASSED_ENVIRONMENT) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return environment;
}

/**
 * The shell-free bounded observation. The Job-object broker is the only process
 * seam in this package; `child_process`, a shell, or a `.cmd` indirection would
 * each be a second, unproven one.
 */
async function probeVersionText(
  request: HostRequest,
): Promise<string | ClaudeRuntimePinFailure | WindowsProcessUnknown> {
  const boundary = openWindowsProcessBoundary({
    executable: request.executablePath,
    argv: [VERSION_ARGUMENT],
    cwd: request.installedRoot,
    environment: environmentSnapshot(),
  }, { timeoutMs: request.timeoutMs });
  // Synchronous on the refusal path on purpose: there is no boundary to close
  // because no process was ever created. Returned unchanged so the Windows layer
  // that answered stays visible instead of being restamped as a RUNTIME code.
  if (!("providerStdout" in boundary)) return boundary;
  let text = "";
  try {
    boundary.providerStdout.setEncoding("utf8");
    boundary.providerStdout.on("data", (chunk: string) => {
      if (text.length < MAX_RUNTIME_TEXT_CHARS) text += chunk;
    });
    boundary.providerStderr.resume();
    const outcome = await boundary.completed;
    if (outcome.truthClass !== "PROVEN") return outcome;
    if (outcome.exitCode !== 0) {
      return invalid("probe did not exit cleanly, so no version was observed");
    }
  } finally {
    // Every exit path, including a throw: a broker that is never closed outlives
    // the observation it was opened for.
    await boundary.close();
  }
  return text.split("\n")[0]?.trim() ?? "";
}

/** A shape this provider does not report is a refusal, never a guessed string. */
function reportedVersionOf(text: string): string | ClaudeRuntimePinFailure {
  return isBoundedLabel(text) && VERSION_PATTERN.test(text)
    ? text
    : invalid("probe printed output that is not the version shape this provider reports");
}

function hostPlatformIdentity(): PlatformIdentity | ClaudeRuntimePinFailure {
  const identity = readHostIdentity({ os: process.platform, arch: arch(), osVersion: release() });
  return identity === null ? invalid("host identity is not bounded normalized os, arch and osVersion") : identity;
}

/**
 * A version-only probe proves the version and the pin method, and NOTHING else.
 * Every other field is explicitly null so the assessor records a definite
 * negative rather than inferring one from an absent field.
 */
function versionOnlyReport(closure: readonly SourceEntry[], reportedVersion: string): ClaudeProbeReport {
  return Object.freeze({
    resolvedRuntimeClosure: closure.map((entry) =>
      Object.freeze({ kind: entry.kind, path: entry.canonicalPath, sha256: entry.sha256 }),
    ),
    reportedVersion,
    pinningMethod: "CONTENT_ADDRESSED_COPY" as const,
    schemaVersion: null, structuredSample: null, rawSampleBase64: null, cancelObservation: null,
    processTreeObservation: null, runEnumeration: null, tokenizer: null,
    declaredContextLimit: null, helpText: null, resumeClaim: null,
  });
}

const digestsOf = (entries: readonly SourceEntry[]): string =>
  entries.map((entry) => `${entry.relativePath}:${entry.sha256}`).join("\n");

/**
 * Observes the installed Claude runtime, or refuses with the exact code and
 * layer of the authority that refused. Nothing here upgrades UNKNOWN.
 */
export async function observeInstalledClaudeRuntime(input: unknown): Promise<ObserveInstalledClaudeRuntimeResult> {
  // FIRST, before any path is read or any process seam is touched.
  if (process.platform !== "win32") {
    return refuse("CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", "the installed runtime host adapter requires win32");
  }
  const request = snapshotRequest(input);
  if ("ok" in request) return request;

  const fs = createNodeClaudeRuntimeFs();
  let realRoot: string;
  try {
    realRoot = await fs.realpath(request.installedRoot);
  } catch {
    return refuse("CLAUDE_RUNTIME_PATH_MISSING", "the installed root could not be resolved");
  }
  const before = await inspectClosure(fs, request, realRoot);
  if ("ok" in before) return before;

  const text = await probeVersionText(request);
  if (typeof text !== "string") return text;

  // Inspected AGAIN, after the probe, and judged BEFORE the output is read. One
  // pass cannot tell a stable installation from one swapped underneath the
  // observation while the probe ran, and output from bytes that no longer exist
  // must not be classified at all — not even as a bad version.
  const after = await inspectClosure(fs, request, realRoot);
  if ("ok" in after) return after;
  if (digestsOf(before) !== digestsOf(after)) {
    return refuse("CLAUDE_RUNTIME_PIN_SOURCE_DRIFT", "the closure changed while the version probe ran");
  }
  const reportedVersion = reportedVersionOf(text);
  if (typeof reportedVersion !== "string") return reportedVersion;

  const platformIdentity = hostPlatformIdentity();
  if ("ok" in platformIdentity) return platformIdentity;
  // The bytes that survived the probe window are the bytes reported.
  const probed = probeClaudeRuntime({
    port: { report: () => versionOnlyReport(after, reportedVersion) },
    clock: { observedAt: () => new Date().toISOString() },
    platformIdentity,
  });
  if (!probed.ok) return probed;
  const facts: ClaudeRuntimeFacts = Object.freeze({
    platformIdentity,
    reportedVersion: probed.observation.reportedVersion,
    adapterCapabilitySchemaDigest: probed.profile.capabilitySchemaDigest,
  });
  return Object.freeze({ ok: true as const, observation: probed.observation, facts, profile: probed.profile });
}
