import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SqliteEventStore } from "@moe/store";

import { agentSpawnInvocation } from "./agent-spawn-invocation.js";
import { providerFor } from "./moe-up-credentials.js";
import {
  AGENT_VERSION_MAX_CHARS, SEAT_FACT_UNMEASURED, shapeAgentVersion,
} from "./seat-start-contracts.js";
import { recordSeatStart } from "./seat-start-ledger.js";

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

const execFileAsync = promisify(execFile);

/** Bounded on purpose: an unbounded probe would hang the first spawn of a wrapper's life. */
export const AGENT_VERSION_PROBE_TIMEOUT_MS = 10_000;

const PROBE_MAX_BUFFER = 64 * 1024;

/**
 * Raw stdout of `<command> --version`, or null for every way that can fail to answer: a missing
 * binary, a nonzero exit, output past the buffer, an argument the shell layer refuses, and the
 * TIMEOUT — `timeoutMs` is a parameter rather than a constant so a test can prove the bound with
 * a genuinely hanging child instead of asserting that a number exists.
 */
export async function probeAgentVersion(
  command: string, timeoutMs: number = AGENT_VERSION_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    // The seat's own invocation shape: on Windows the CLI is a `.cmd` shim that only a shell
    // resolves, and `agentSpawnInvocation` already refuses any command a shell could
    // reinterpret. Reused rather than re-derived so the probe cannot drift from the spawn.
    const invocation = agentSpawnInvocation(command, ["--version"]);
    const { stdout } = await execFileAsync(invocation.file, [...invocation.args], {
      killSignal: "SIGKILL", maxBuffer: PROBE_MAX_BUFFER, shell: invocation.shell,
      timeout: timeoutMs, windowsHide: true,
    });
    return typeof stdout === "string" ? stdout : null;
  } catch {
    return null;
  }
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
    try {
      const result = recordSeatStart(options.store, {
        agentVersion: await versionOf(command.trim()),
        projectId: options.projectId,
        provider,
        sessionId: seat.sessionId,
        startedAt: clock(),
      });
      if (!result.ok) log(`[wrapper] seat start not recorded: ${result.code}`);
    } catch (error) {
      log(`[wrapper] seat start not recorded: ${error instanceof Error ? error.message : "UNKNOWN"}`);
    }
  };
  return Object.freeze({ record });
}
