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
 * The one production import below is deliberate and is on the input side: the
 * pinned runtime observation is built by the real adapter builder rather than
 * hand-rolled, so the fixture cannot drift from the shape production produces.
 * Re-implementing that shape in test code is the defect epic rail 6 names.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildProviderRuntimeObservation,
  type ProviderRuntimeObservation,
} from "../../../packages/runner/src/providers/claude/claude-observation.js";

import { createLogicalClock, type E2eRun } from "./e2e-harness.js";

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

/** A fixed 64-hex literal. Real digests arrive from the probe in the journey half. */
const PINNED_CLOSURE_SHA256 =
  "1111111111111111111111111111111111111111111111111111111111111111";
const PINNED_CAPABILITY_SCHEMA_DIGEST =
  "2222222222222222222222222222222222222222222222222222222222222222";

/**
 * The pinned Claude runtime observation the canary runs against.
 *
 * Built through the production `buildProviderRuntimeObservation`, so a change to
 * the observation contract surfaces here as a build refusal rather than as a
 * fixture that silently no longer matches production. A refusal is thrown with
 * its own reason code attached, never swallowed into a default observation.
 */
export function pinnedClaudeRuntimeObservation(): ProviderRuntimeObservation {
  const result = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [
      { kind: "EXECUTABLE", path: "C:/pinned/claude/claude.exe", sha256: PINNED_CLOSURE_SHA256 },
    ],
    reportedVersion: "claude-code/2.0.0",
    adapterCapabilitySchemaDigest: PINNED_CAPABILITY_SCHEMA_DIGEST,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
    clock: createLogicalClock(),
  });
  if (result.ok !== true) {
    throw new Error(`pinned Claude observation refused with ${result.code}: ${result.message}`);
  }
  return result.observation;
}
