import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { SqliteEventStore } from "@moe/store";

import { agentEnvironment } from "./agent-spawn-environment.js";
import { agentSpawnInvocation } from "./agent-spawn-invocation.js";
import type { AgentSpawnInvocation } from "./agent-spawn-invocation.js";
import { providerFor } from "./moe-up-credentials.js";
import {
  AGENT_VERSION_MAX_CHARS, SEAT_FACT_UNMEASURED, shapeAgentVersion,
} from "./seat-start-contracts.js";
import { recordSeatStart } from "./seat-start-ledger.js";
import { spawnWindowsTreeKill } from "./seat-tree-kill.js";

/**
 * THE WRAPPER HALF: measure a seat's agent CLI once, and write down what it was started with.
 *
 * WHY THE WRAPPER AND NOT THE DAEMON. The daemon cannot see the binary a seat is running — they
 * are separate processes — so a daemon-side `--version` would measure the DAEMON's PATH and
 * publish it as the seat's. This runs in the process that actually spawns the child, through
 * the SAME `agentSpawnInvocation` the spawner uses, so the reading is of the image the seat
 * gets and not of some other resolution of the same name.
 *
 * WHY ONCE PER PROVIDER AND NOT ONCE PER SEAT. A child process on the hot path of every spawn
 * would cost every seat a probe for a value that cannot change between spawns inside one
 * wrapper process. The memo is keyed by the resolved COMMAND, so a wrapper serving claude and
 * codex probes twice, not once and not once per seat.
 *
 * NOTHING HERE THROWS AND NOTHING HERE BLOCKS A SPAWN. A probe that fails, times out or prints
 * something unreadable resolves to `SEAT_FACT_UNMEASURED`; a ledger write that refuses is
 * logged and dropped. A seat must never fail to start because its version could not be read.
 */

/** Bounded on purpose: an unbounded probe would hang the first spawn of a wrapper's life. */
export const AGENT_VERSION_PROBE_TIMEOUT_MS = 10_000;

/** How long a timed-out probe waits to SEE its tree dead before answering null regardless. */
const PROBE_KILL_GRACE_MS = 5_000;

const PROBE_MAX_BUFFER = 64 * 1024;

/**
 * The probed child's stdout, or null once it has timed out, overflowed, failed or exited nonzero.
 *
 * TERMINATION IS THE SEAT SPAWNER'S, NOT `execFile`'s. On Windows the invocation is
 * `cmd.exe /c "<shim> --version"`, and `execFile`'s own `timeout` kills that direct child alone:
 * the real `node claude.js --version` behind the shim kept running after the probe had answered
 * (measured 2026-09-13: a grandchild heartbeat 654 ms after the null resolved). So the timed-out
 * arm runs `taskkill /T /F` through the same helper the spawner uses (POSIX: the process group,
 * since the child is spawned detached), and answers only once the tree is witnessed dead AND the
 * child has closed - the spawner's own rule - with a bounded grace so an unwitnessed kill can
 * still never hang the first spawn of a wrapper's life.
 */
function probeOutput(
  child: ChildProcess, environment: NodeJS.ProcessEnv, timeoutMs: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let closed = false;
    let settled = false;
    let terminating = false;
    let treeContained = false;
    let killer: ChildProcess | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      if (killer !== undefined) { try { killer.kill("SIGKILL"); } catch { /* already gone */ } }
      resolve(value);
    };
    const killDirect = (): void => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    const finishIfContained = (): void => { if (treeContained && closed) settle(null); };
    const containTree = (): void => {
      if (child.pid === undefined) {
        killDirect();
        treeContained = true;
        finishIfContained();
        return;
      }
      if (process.platform === "win32") {
        killer = spawnWindowsTreeKill({
          childClosed: () => closed, environment,
          onConfirmed: () => { treeContained = true; finishIfContained(); },
          onFailed: () => { killDirect(); treeContained = true; finishIfContained(); },
          pid: child.pid, spawn: nodeSpawn,
        });
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        // ESRCH is the group already gone, the state the signal was sent to reach.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") killDirect();
      }
      treeContained = true;
      finishIfContained();
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      grace = setTimeout(() => { settle(null); }, PROBE_KILL_GRACE_MS);
      if (typeof grace.unref === "function") grace.unref();
      containTree();
    };
    const timer = setTimeout(terminate, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > PROBE_MAX_BUFFER) { terminate(); return; }
      chunks.push(chunk);
    });
    child.once("error", () => { killDirect(); settle(null); });
    child.once("close", (code) => {
      closed = true;
      if (terminating) { finishIfContained(); return; }
      settle(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

/**
 * Raw stdout of `<command> --version`, or null for every way that can fail to answer: a missing
 * binary, a nonzero exit, output past the buffer, an argument the shell layer refuses, and the
 * TIMEOUT — `timeoutMs` is a parameter rather than a constant so a test can prove the bound with
 * a genuinely hanging child instead of asserting that a number exists.
 */
export async function probeAgentVersion(
  command: string, timeoutMs: number = AGENT_VERSION_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  // The seat's own invocation shape: on Windows the CLI is a `.cmd` shim that only a shell
  // resolves, and `agentSpawnInvocation` already refuses any command a shell could
  // reinterpret. Reused rather than re-derived so the probe cannot drift from the spawn.
  let invocation: AgentSpawnInvocation;
  try {
    invocation = agentSpawnInvocation(command, ["--version"]);
  } catch {
    return null;
  }
  // THE SEAT'S ENVIRONMENT, FROM THE SEAT'S OWN BUILDER, ONE ARGUMENT LIKE THE CODING-SEAT
  // SPAWNER. Without `env` the child inherited the wrapper's whole process.env - measured
  // 2026-09-13 through a `.cmd` printing MOE_DAEMON_CREDENTIAL, MOE_STORE_PATH and
  // MOE_PROJECT_ID back - the very variables the spawner scrubs for the same binary.
  const environment = agentEnvironment(process.env);
  let child: ChildProcess;
  try {
    child = nodeSpawn(invocation.file, [...invocation.args], {
      // Detached off Windows so the shell leads its own group and the group kill above reaches
      // the binary behind a shim; on Windows the tree kill does that job.
      detached: process.platform !== "win32", env: environment, shell: invocation.shell,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
  } catch {
    return null;
  }
  return probeOutput(child, environment, timeoutMs);
}

export type AgentVersionProbe = (command: string) => Promise<string | null>;

/**
 * One SHAPED reading per distinct command, for the lifetime of this process.
 *
 * The PROMISE is memoised, not the value: two seats starting at once share one child process
 * instead of racing two. A failed probe is memoised too — retrying a missing binary on every
 * spawn is the same hot-path cost the memo exists to avoid, and its answer would not change.
 */
export function createAgentVersionMemo(probe: AgentVersionProbe = probeAgentVersion):
(command: string) => Promise<string> {
  const readings = new Map<string, Promise<string>>();
  return (command: string): Promise<string> => {
    const memoised = readings.get(command);
    if (memoised !== undefined) return memoised;
    const reading = probe(command)
      .then(shapeAgentVersion, () => SEAT_FACT_UNMEASURED);
    readings.set(command, reading);
    return reading;
  };
}

export interface SeatStartRecorderOptions {
  readonly clock?: () => string;
  readonly log?: (line: string) => void;
  readonly probe?: AgentVersionProbe;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface SeatStartRecorder {
  /**
   * Writes what this seat was started with. Returns a promise so a test can await the write;
   * production fires and forgets, because a spawn must not wait on a ledger commit.
   */
  readonly record: (
    seat: Readonly<{ provider?: string | undefined; sessionId: string }>,
  ) => Promise<void>;
}

/**
 * The provider NAME to write down: the roster leaf where the command maps to a known provider
 * (`C:\tools\codex.exe` is `codex`), and the command VERBATIM where it does not — the same rule
 * `/sessions/read` uses for its project-scoped disclosure, so the two never disagree about what
 * to call the same command. A command too long to be a name is not shortened into one: the
 * record refuses and the seat reads the stated unknown instead of a truncated path.
 */
function providerName(command: string): string | null {
  const name = providerFor(command)?.leaf ?? command;
  return name.length > 0 && name.length <= AGENT_VERSION_MAX_CHARS ? name : null;
}

export function createSeatStartRecorder(options: SeatStartRecorderOptions): SeatStartRecorder {
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const log = options.log ?? ((): void => undefined);
  const versionOf = createAgentVersionMemo(options.probe ?? probeAgentVersion);
  const record = async (
    seat: Readonly<{ provider?: string | undefined; sessionId: string }>,
  ): Promise<void> => {
    // A seat spawned through the spawner's own chain names no command here, so there is
    // nothing to attribute a version to. NO RECORD is written: the read then publishes the
    // same stated unknown it publishes for a seat that predates this ledger. One unknown.
    const command = seat.provider ?? "";
    const provider = command.trim().length === 0 ? null : providerName(command.trim());
    if (provider === null) return;
    // SAMPLED BEFORE THE PROBE, not after it. The first seat of a provider waits on a `--version`
    // that can take the whole bound plus the kill grace to answer, and every seat sharing the
    // memoised promise waits with it. The row says when the seat STARTED, not when it was written.
    const startedAt = clock();
    try {
      const result = recordSeatStart(options.store, {
        agentVersion: await versionOf(command.trim()),
        projectId: options.projectId,
        provider,
        sessionId: seat.sessionId,
        startedAt,
      });
      if (!result.ok) log(`[wrapper] seat start not recorded: ${result.code}`);
    } catch (error) {
      log(`[wrapper] seat start not recorded: ${error instanceof Error ? error.message : "UNKNOWN"}`);
    }
  };
  return Object.freeze({ record });
}
