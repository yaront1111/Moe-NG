/**
 * Real-process fixtures for the J1 loop e2e: a scratch project, the REAL daemon entry, the
 * REAL shipped seed, and the REAL agent wrapper, each as its own OS process.
 *
 * Nothing here is a stub. `e2e-process.ts` spawns `process.execPath` with inline `node -e`
 * bodies, which is the right shape for the crash-boundary journeys and the wrong shape for
 * this one: the value of this test IS the process boundary around the shipped entrypoints.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE: `e2e-harness.test.ts` scans every non-test module in
 * this directory for the four wall-clock/random needles it names, and that scan is a plain
 * SUBSTRING match — spelling the needles out here, even inside a comment, reddens it. Waits
 * are bounded by ATTEMPT COUNTS rather than deadlines, and scratch uniqueness comes from
 * `mkdtempSync`, which the OS makes unique without a random source of ours.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { AgentCredential } from "./agent-credential.js";
import { SEEDED_LOW_RISK_TASK } from "./foundation-fixtures.js";

/** Exactly what `stdio: ["ignore", "pipe", "pipe"]` produces: no stdin, both readers piped. */
export type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const IS_WINDOWS = process.platform === "win32";

/** The wrapper entry REQUIRES this flag on Windows (runbook, measured at b773de7). */
const TRANSFORM_TYPES = "--experimental-transform-types";
const DAEMON_MAIN = "apps/daemon/src/daemon-main.ts";
const DAEMON_DEPENDENCIES = "apps/daemon/src/daemon-store-dependencies.ts";
const SEED_MAIN = "apps/daemon/src/orchestrator/demo-seed-main.ts";
const WRAPPER_MAIN = "apps/daemon/src/orchestrator/agent-wrapper-main.ts";
const FAKE_AGENT = "tests/e2e/foundation/fake-agent.mjs";

/** Fixed, not minted: a random credential would be a random source in a scanned module. */
const OPERATOR_CREDENTIAL = "moe-e2e-j1-operator-credential";
const CSRF_TOKEN = "moe-e2e-j1-csrf";
/**
 * The exclusive identity comes FROM the fixture rather than being restated here.
 * Two literals that happen to agree today are two literals: the canary asserts
 * exclusivity against the fixture's identity, so a harness that seeded its own
 * node would be sampling something no journey ever claimed.
 */
const PROJECT_ID = SEEDED_LOW_RISK_TASK.projectId;
export const NODE_REF = SEEDED_LOW_RISK_TASK.nodeRef;

export type AgentArm = "complete" | "forge-credential" | "skip-review";

export interface J1Scratch {
  readonly agentPidFile: string;
  readonly credential: string;
  readonly projectId: string;
  readonly root: string;
  readonly specsDir: string;
  readonly storePath: string;
  readonly workspace: string;
}

/**
 * The scratch project: a store path, the operator-authored node spec the affordance surface
 * lists, and a workspace holding the test the DAEMON's verifier will run. `math.mjs` is
 * deliberately absent — the spawned agent has to write it, and the verifier's exit code is
 * the only thing that decides whether it did.
 */
export function createJ1Scratch(): J1Scratch {
  const root = mkdtempSync(join(tmpdir(), "moe-e2e-j1-"));
  const specsDir = join(root, "specs");
  const workspace = join(root, "workspace");
  mkdirSync(specsDir);
  mkdirSync(workspace);
  writeFileSync(join(specsDir, `${NODE_REF}.json`), JSON.stringify({
    instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
    nodeRef: NODE_REF,
    test: "node test.mjs",
    title: "Implement the math module",
    workspace: workspace.replaceAll("\\", "/"),
  }), "utf8");
  writeFileSync(join(workspace, "test.mjs"), [
    'import { add, multiply } from "./math.mjs";',
    'if (add(2, 3) !== 5) throw new Error("add is wrong");',
    'if (multiply(2, 3) !== 6) throw new Error("multiply is wrong");',
    'console.log("math.mjs passes");',
    "",
  ].join("\n"), "utf8");
  return {
    agentPidFile: join(root, "agent.pid"),
    credential: OPERATOR_CREDENTIAL,
    projectId: PROJECT_ID,
    root,
    specsDir,
    storePath: join(root, "store.sqlite"),
    workspace,
  };
}

/** The store trio plus the node spec directory: what every one of the three entries reads. */
function storeEnvironment(scratch: J1Scratch): Record<string, string> {
  return {
    MOE_DAEMON_CREDENTIAL: scratch.credential,
    MOE_NODE_SPECS_DIR: scratch.specsDir,
    MOE_PROJECT_ID: scratch.projectId,
    MOE_STORE_PATH: scratch.storePath,
  };
}

export interface ProcessRun {
  readonly code: number | null;
  readonly output: string;
  /** Recorded so the orphan check can name every process this run started. */
  readonly pid: number | undefined;
}

function collect(child: PipedChild, sink: { text: string }): void {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { sink.text += chunk; });
  child.stderr.on("data", (chunk: string) => { sink.text += chunk; });
}

function runToExit(
  file: string, args: readonly string[], environment: Record<string, string>,
): Promise<ProcessRun> {
  const child = spawn(file, [...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = { text: "" };
  const { pid } = child;
  collect(child, sink);
  return new Promise<ProcessRun>((resolve) => {
    child.once("error", (error) => resolve({
      code: null, output: `${sink.text}${String(error)}`, pid,
    }));
    child.once("close", (code) => resolve({ code, output: sink.text, pid }));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export interface DaemonHandle {
  readonly child: PipedChild;
  readonly origin: string;
  readonly pid: number;
  output(): string;
}

/**
 * Starts the REAL daemon on an EPHEMERAL port and reads the origin off its banner. A guessed
 * port would silently address another daemon on a developer's machine, so the banner is the
 * only accepted source and a miss fails with the captured output.
 */
export async function startDaemon(scratch: J1Scratch): Promise<DaemonHandle> {
  const child = spawn(process.execPath, [
    TRANSFORM_TYPES,
    join(REPOSITORY_ROOT, DAEMON_MAIN),
    `--dependencies=${join(REPOSITORY_ROOT, DAEMON_DEPENDENCIES)}`,
    "--port=0",
    `--csrf-token=${CSRF_TOKEN}`,
  ], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      ...storeEnvironment(scratch),
      MOE_APPROVAL_MODE: "SPEED",
      MOE_SPEED_MODE_DELAY_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = { text: "" };
  collect(child, sink);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const match = /listening on (http:\/\/\S+)/u.exec(sink.text);
    if (match?.[1] !== undefined) {
      return { child, origin: match[1], output: () => sink.text, pid: child.pid as number };
    }
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  await killTree(child);
  throw new Error(`the daemon never printed its origin: ${sink.text}`);
}

/** Runs the SHIPPED seed as a child. Its MOE_SEED_* refusal codes surface verbatim. */
export function runSeed(scratch: J1Scratch, origin: string): Promise<ProcessRun> {
  return runToExit(process.execPath, [TRANSFORM_TYPES, join(REPOSITORY_ROOT, SEED_MAIN)], {
    ...storeEnvironment(scratch),
    MOE_CSRF_TOKEN: CSRF_TOKEN,
    MOE_DAEMON_ORIGIN: origin,
  });
}

/**
 * The live `claude -p --bare` probe, run WITH the resolved credential injected and BEFORE any
 * journey starts. `--bare` reads no keychain, so this is the one call that can tell a missing
 * credential apart from an orchestration fault: without it a spawn failure inside the wrapper
 * would be reported as an agent process failure and read as a moe-next defect.
 */
export function probeBareAgent(command: string, credential: AgentCredential): Promise<ProcessRun> {
  // ONE SPACE-FREE ARGUMENT. Production spawns this CLI through cmd.exe with `shell: true`,
  // which concatenates argv unescaped (DEP0190), so a multi-word prompt arrives as separate
  // positional arguments and the child answers an EMPTY prompt while still exiting 0.
  const child = spawn(command, ["-p", "--bare", "ping"], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, [credential.deliveredAs]: credential.value },
    shell: IS_WINDOWS,
    stdio: ["ignore", "pipe", "pipe"],
  }) as PipedChild;
  const sink = { text: "" };
  const { pid } = child;
  collect(child, sink);
  return new Promise<ProcessRun>((resolve) => {
    child.once("error", (error) => resolve({
      code: null, output: `${sink.text}${String(error)}`, pid,
    }));
    child.once("close", (code) => resolve({ code, output: sink.text, pid }));
  });
}

export interface RealAgentRun {
  /** The command MOE_AGENT_COMMAND carries: the real CLI, never a shim. */
  readonly agentCommand: string;
  readonly credential: AgentCredential;
  readonly timeoutMs: number;
}

/**
 * The REAL wrapper staffing the exclusive node with the REAL `claude -p --bare` child.
 *
 * The credential reaches that child by production's own rule and not by a special case:
 * `agentEnvironment()` forwards the ANTHROPIC_ prefix from the wrapper's environment, so
 * injecting it here is exactly the inheritance a keyed operator shell would have provided.
 */
export function runRealAgentWrapper(scratch: J1Scratch, run: RealAgentRun): Promise<ProcessRun> {
  return runToExit(process.execPath, [TRANSFORM_TYPES, join(REPOSITORY_ROOT, WRAPPER_MAIN)], {
    ...storeEnvironment(scratch),
    [run.credential.deliveredAs]: run.credential.value,
    MOE_AGENT_COMMAND: run.agentCommand,
    MOE_AGENT_TIMEOUT_MS: String(run.timeoutMs),
    MOE_WRAPPER_MAX_AGENTS: "1",
    MOE_WRAPPER_ONCE: "1",
  });
}

/**
 * The `.cmd` shim MOE_AGENT_COMMAND points at, and the only channel the arm can travel on.
 *
 * `agentSpawnInvocation` quotes the COMMAND ITSELF for cmd.exe, so a multi-word
 * `MOE_AGENT_COMMAND` becomes one quoted token and cannot work; and `agentEnvironment()`
 * scrubs every non-allowlisted key and drops all `MOE_*`, so no env var reaches the agent.
 * The shim carries both facts: it names `node`, and it prepends this run's argv.
 */
export function writeAgentShim(scratch: J1Scratch, arm: AgentArm): string {
  const agent = join(REPOSITORY_ROOT, FAKE_AGENT);
  if (!IS_WINDOWS) {
    const path = join(scratch.root, `agent-${arm}.sh`);
    writeFileSync(path, [
      "#!/bin/sh",
      `exec node "${agent}" --arm ${arm} --pidfile "${scratch.agentPidFile}" "$@"`,
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o755 });
    return path;
  }
  const path = join(scratch.root, `agent-${arm}.cmd`);
  writeFileSync(path, [
    "@echo off",
    `node "${agent}" --arm ${arm} --pidfile "${scratch.agentPidFile}" %*`,
    "",
  ].join("\r\n"), "utf8");
  return path;
}

/** Runs the REAL wrapper for exactly one pass; it exits on its own in ONCE mode. */
export function runWrapper(scratch: J1Scratch, arm: AgentArm): Promise<ProcessRun> {
  return runToExit(process.execPath, [TRANSFORM_TYPES, join(REPOSITORY_ROOT, WRAPPER_MAIN)], {
    ...storeEnvironment(scratch),
    MOE_AGENT_COMMAND: writeAgentShim(scratch, arm),
    MOE_WRAPPER_MAX_AGENTS: "1",
    MOE_WRAPPER_ONCE: "1",
  });
}

function exited(child: PipedChild, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * Reaps the tree. `taskkill /T /F` is what actually reaps a Windows subtree; `child.kill` on
 * its own leaves grandchildren re-parented beyond any pid this process holds.
 */
export async function killTree(child: PipedChild): Promise<void> {
  if (child.pid === undefined) return;
  try {
    if (IS_WINDOWS) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch {
    // Already gone is success: taskkill exits nonzero on a pid that has exited.
    child.kill("SIGKILL");
  }
  await exited(child, 5_000);
}

/**
 * Whether the OS still has a row for this pid. `tasklist /FI "PID eq N"` prints an INFO line
 * and exits 0 when nothing matches, so the pid must be looked for in the output rather than
 * in the exit code.
 */
export function pidIsAlive(pid: number): boolean {
  if (!IS_WINDOWS) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const output = execFileSync("tasklist", ["/FI", `PID eq ${String(pid)}`], { encoding: "utf8" });
    return output.includes(String(pid));
  } catch {
    return false;
  }
}
