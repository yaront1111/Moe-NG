/**
 * INPUTS for the Foundation Preview canary. Inputs only.
 *
 * A fixture here may supply what a journey is given — a scratch project
 * repository, one seeded low-risk task, a pinned Claude runtime observation. It
 * may NEVER stand in for a component under certification. Substituting a fake
 * daemon, store, review flow or reconciliation service would turn this suite
 * into an elaborate tautology that certifies a cutover which never happened, so
 * nothing in this file constructs a test double of anything the canary is
 * supposed to prove.
 *
 * The production import below is deliberate and is on the input side: the
 * runtime observation is DISCOVERED by the real adapter rather than hand-rolled,
 * so the fixture cannot drift from the shape production produces, and cannot
 * name a runtime of its own choosing. Re-implementing that shape in test code is
 * the defect epic rail 6 names.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  ProviderRuntimeObservation,
} from "../../../packages/runner/src/providers/claude/claude-observation.js";
import {
  discoverInstalledClaudeRuntime,
  type DiscoverInstalledClaudeRuntimeResult,
} from "../../../packages/runner/src/providers/claude/claude-runtime-discovery.js";

import { type E2eRun } from "./e2e-harness.js";

const run = promisify(execFile);

/**
 * The single exclusive low-risk task the self-host claim is proved on (DoD 3).
 *
 * `exclusive` is the load-bearing field: the duplicate-authority assertion in
 * step 9 is only meaningful if exactly one worker may ever hold this task.
 */
export const SEEDED_LOW_RISK_TASK = Object.freeze({
  taskId: "moe-e2e-foundation-task-0001",
  title: "Correct the off-by-one in the Tuesday bug reproduction",
  riskTier: "LOW",
  exclusive: true,
  causalBugCount: 1,
  expectedExecutionBearingNodes: 1,
  /**
   * The identity the SHIPPED seed actually installs, named here so the canary
   * has ONE exclusive identity rather than two that merely look alike. The
   * duplicate-authority sampling asserts against these, and a run that seeded a
   * different node would otherwise sample a node no journey ever claimed.
   */
  projectId: "moe-e2e-j1",
  nodeRef: "node-code-1",
} as const);

/** The seeded causal bug: one wrong comparison, one failing assertion. */
const SEEDED_SOURCE = `export function lastIndex(items) {\n  return items.length;\n}\n`;
const SEEDED_TEST = `import { lastIndex } from "./bug.js";\nif (lastIndex([1, 2, 3]) !== 2) {\n  throw new Error("lastIndex is off by one");\n}\n`;

async function initializeGitRepository(directory: string): Promise<void> {
  await run("git", ["init", "--quiet"], { cwd: directory });
  await run("git", ["config", "user.email", "canary@moe-next.invalid"], { cwd: directory });
  await run("git", ["config", "user.name", "Foundation Canary"], { cwd: directory });
}

/**
 * Creates a scratch project repository seeded with one causal bug.
 *
 * Cleanup is registered on the run BEFORE any content is written, so a failure
 * halfway through still removes the directory. `rm` is given retries because a
 * child process on Windows keeps handles briefly after exit, and the resulting
 * `EBUSY` would be reported by the NEXT case instead of this one.
 */
export async function createScratchProjectRepository(e2eRun: E2eRun): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "moe-e2e-foundation-"));
  e2eRun.registerCleanup(`scratch:${directory}`, async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "moe-e2e-canary-project", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(directory, "bug.js"), SEEDED_SOURCE, "utf8");
  await writeFile(join(directory, "bug.test.js"), SEEDED_TEST, "utf8");
  await initializeGitRepository(directory);
  return directory;
}

/**
 * Codes this gate — and only this gate — may mint.
 *
 * Two authorities answer on the host-evidence path and they keep separate
 * vocabularies. `discoverInstalledClaudeRuntime` refuses with the RUNTIME
 * layer's own codes, and those travel out untouched under `runtimeCode`;
 * the codes below are the CANARY refusing an observation the runtime already
 * accepted. Restamping either as the other would erase which layer refused,
 * which is exactly the fact a journey needs when a host is wrong.
 */
export const HOST_RUNTIME_EVIDENCE_ERROR_CODES = Object.freeze([
  "CANARY_HOST_RUNTIME_CLOSURE_EMPTY",
  "CANARY_HOST_RUNTIME_DIGEST_MISMATCH",
  "CANARY_HOST_RUNTIME_DISCOVERY_REFUSED",
  "CANARY_HOST_RUNTIME_PLATFORM_MISMATCH",
  "CANARY_HOST_RUNTIME_UNPROVEN",
  "CANARY_HOST_RUNTIME_VERSION_MISMATCH",
] as const);

export type HostRuntimeEvidenceErrorCode = (typeof HOST_RUNTIME_EVIDENCE_ERROR_CODES)[number];

export interface HostRuntimeEvidence {
  readonly ok: true;
  readonly installedRoot: string;
  readonly observation: ProviderRuntimeObservation;
}

export interface HostRuntimeEvidenceRefusal {
  readonly ok: false;
  readonly code: HostRuntimeEvidenceErrorCode;
  /** The refusing authority's OWN code when discovery answered; null when this gate refused. */
  readonly runtimeCode: string | null;
  readonly message: string;
}

export type HostRuntimeEvidenceResult = HostRuntimeEvidence | HostRuntimeEvidenceRefusal;

/**
 * What THIS host says about the closure right now, read independently of the
 * observation being checked. Independence is the whole point: comparing an
 * observation against itself would pass on any host, including one where the
 * binary was replaced between the probe and the run.
 */
export interface HostRuntimeReadings {
  /** sha256 of each closure path as read here; null when the path is unreadable. */
  readonly digests: ReadonlyMap<string, string | null>;
  /** First line of the resolved executable's own `--version`; null when unreadable. */
  readonly version: string | null;
}

const EMPTY_READINGS: HostRuntimeReadings = Object.freeze({
  digests: new Map<string, string | null>(),
  version: null,
});

const refuse = (
  code: HostRuntimeEvidenceErrorCode, message: string, runtimeCode: string | null = null,
): HostRuntimeEvidenceRefusal => Object.freeze({ ok: false as const, code, message, runtimeCode });

const codeOf = (value: unknown): string | null =>
  typeof value === "object" && value !== null && "code" in value
  && typeof (value as { code: unknown }).code === "string"
    ? (value as { code: string }).code
    : null;

/**
 * Accepts a discovery answer as HOST EVIDENCE, or refuses with the exact code.
 *
 * Pure and total, so every refusal arm is reachable from a hand-authored case
 * rather than from a host nobody can produce on demand. It never re-derives what
 * the runtime already decided — it asks the narrower question the runtime cannot:
 * does this observation still describe the bytes and version this host has NOW.
 */
export function acceptHostRuntimeEvidence(
  found: DiscoverInstalledClaudeRuntimeResult, readings: HostRuntimeReadings,
): HostRuntimeEvidenceResult {
  if (!("ok" in found && found.ok === true)) {
    return refuse(
      "CANARY_HOST_RUNTIME_DISCOVERY_REFUSED",
      "installed runtime discovery refused, so there is no host observation to accept",
      codeOf(found),
    );
  }
  const { observation } = found;
  if (observation.truthClass !== "PROVEN") {
    return refuse("CANARY_HOST_RUNTIME_UNPROVEN", "the host observation is not PROVEN");
  }
  if (observation.platformIdentity.os !== "win32") {
    return refuse("CANARY_HOST_RUNTIME_PLATFORM_MISMATCH", "the canary certifies win32 only");
  }
  if (observation.resolvedRuntimeClosure.length === 0) {
    return refuse("CANARY_HOST_RUNTIME_CLOSURE_EMPTY", "the observed closure names no file");
  }
  for (const entry of observation.resolvedRuntimeClosure) {
    const reading = readings.digests.get(entry.path) ?? null;
    if (reading === null || reading.toLowerCase() !== entry.sha256.toLowerCase()) {
      return refuse(
        "CANARY_HOST_RUNTIME_DIGEST_MISMATCH",
        "a closure entry does not match the bytes this host holds",
      );
    }
  }
  if (readings.version === null || readings.version !== observation.reportedVersion) {
    return refuse(
      "CANARY_HOST_RUNTIME_VERSION_MISMATCH",
      "the observed version is not the version this host's executable reports",
    );
  }
  return Object.freeze({
    ok: true as const, installedRoot: found.installedRoot, observation,
  });
}

const sha256OfFile = async (path: string): Promise<string | null> => {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
};

const EXECUTABLE_KIND = "EXECUTABLE";

/** The host's own answer, read through the executable the observation names. */
async function readHostReadings(
  observation: ProviderRuntimeObservation, installedRoot: string,
): Promise<HostRuntimeReadings> {
  const digests = new Map<string, string | null>();
  for (const entry of observation.resolvedRuntimeClosure) {
    digests.set(entry.path, await sha256OfFile(entry.path));
  }
  const executable = observation.resolvedRuntimeClosure.find(
    (entry) => entry.kind === EXECUTABLE_KIND,
  );
  if (executable === undefined) return { digests, version: null };
  try {
    const probe = await run(executable.path, ["--version"], { cwd: installedRoot });
    return { digests, version: probe.stdout.split("\n")[0]?.trim() ?? null };
  } catch {
    return { digests, version: null };
  }
}

/**
 * THE observation the canary runs against: this host's real installed Claude.
 *
 * No argument, because a caller able to name the runtime is a caller able to
 * hand the canary a synthetic one — the previous fixture pinned a literal
 * `C:/pinned/claude/claude.exe` with placeholder digests, and that is precisely
 * what a self-host claim may not rest on. Production's own discovery answers
 * WHICH runtime; this function only decides whether the answer is still true of
 * the host, and returns a refusal rather than a fallback when it is not.
 */
export async function observeHostClaudeRuntime(): Promise<HostRuntimeEvidenceResult> {
  const found = await discoverInstalledClaudeRuntime();
  if (!("ok" in found && found.ok === true)) return acceptHostRuntimeEvidence(found, EMPTY_READINGS);
  return acceptHostRuntimeEvidence(found, await readHostReadings(found.observation, found.installedRoot));
}
