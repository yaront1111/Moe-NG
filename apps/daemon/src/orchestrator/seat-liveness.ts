/**
 * The seat's LIVENESS VERDICT: turns output bytes and liveness-probe samples into "when was this
 * seat last seen doing anything, and what was it".
 *
 * "Activity" is any one of: bytes on stdout/stderr; at least one live TOOL CHILD; or the tree's
 * CPU time growing since the previous tick. The spawner kills a seat on SILENCE (no activity for
 * MOE_AGENT_SILENCE_MS) and, separately, at the ABSOLUTE cap (MOE_AGENT_TIMEOUT_MS) whatever it
 * is doing — see agent-spawner.ts. This file never kills; it only measures and describes.
 *
 * TOOL CHILDREN ARE COUNTED ABOVE THE LAUNCHER CHAIN. The probe reports every descendant of the
 * seat pid, and that pid is not the model: on win32 the seat is spawned through cmd.exe (a `.cmd`
 * shim needs a shell), so the model process is itself a descendant, and a codex seat adds one
 * more (`codex.cmd` -> node -> the native codex binary). Rather than name each provider's chain,
 * the smallest descendant count ever observed for THIS seat is taken as its launcher chain: a
 * seat with no tool open shows exactly that chain, and every process above it is a tool child.
 * The one blind spot is a seat that has had a tool child open at every tick since its first —
 * that seat is judged on CPU growth and output alone, which is exactly the judgement a tool child
 * that has burned no CPU for the whole silence window deserves.
 */
import { describeThrownForProbe, isProbeFailure, probeFailure } from "./seat-liveness-probe.js";
import type { SeatActivityProbe, SeatProbeAnswer } from "./seat-liveness-probe.js";

/**
 * An idle Node event loop accrues single-digit milliseconds of CPU per minute (timers, GC); a CLI
 * parsing a streamed model response, or any tool child doing work, accrues hundreds. Growth below
 * this floor per tick is "unchanged", so a hung seat cannot keep itself alive on housekeeping.
 *
 * UNMEASURED against a working `claude -p` turn that has no tool child (a long model response
 * being streamed and parsed): the figure is the idle-loop number with a margin, not a reading
 * from such a turn. TO CALIBRATE on a live seat: read that seat's `[wrapper] <item> seat quiet:`
 * lines (the wrapper console, or `<project>/.moe/logs` where the SEAT_LINE records land). The
 * tick runs every min(MOE_WRAPPER quiet notice 60 s, MOE_AGENT_SILENCE_MS), so each line's cpu
 * field is the tree's CPU growth over ONE tick, judged against this floor: `cpu +N.Ns` is at or
 * above it, `cpu unchanged` is below it. Compare the lines whose tick saw `no tool child` during
 * a turn known to be working (the seat later delivers) with the lines from a known hang: a
 * working turn must read `cpu +…` on every tick and a hang `cpu unchanged` on every tick. If a
 * working no-tool-child tick ever reads `cpu unchanged`, run the probe's own command
 * (WINDOWS_TREE_SCRIPT in PowerShell, or `ps -A -o pid=,ppid=,time=`) twice, one tick apart,
 * sum the seat tree's CPU each time, and lower this floor below the smallest working delta seen
 * while keeping it above the idle figure. The value is deliberately not changed here.
 */
export const CPU_ACTIVITY_FLOOR_MS = 250;

export interface SeatLivenessOptions {
  readonly cpuActivityFloorMs?: number;
  readonly now: () => number;
  readonly pid: number | undefined;
  /** Absent means the wrapper judges on output alone, and says so in every notice. */
  readonly probe: SeatActivityProbe | undefined;
}

export interface SeatLivenessTick {
  /** What this tick saw, e.g. `no output; 1 tool child alive; cpu +1.3s`. */
  readonly detail: string;
  /**
   * Set when the probe could not see the tree this tick: the bounded reason (timeout, exit code
   * and stderr tail, thrown message). No liveness was granted for it; the spawner warns once.
   */
  readonly probeFailure: string | undefined;
  /** Since the last OUTPUT byte; what the quiet notice reports. */
  readonly quietMs: number;
  /** Since the last ACTIVITY of any kind; what the silence kill is measured against. */
  readonly silentMs: number;
}

export interface SeatLiveness {
  /** The last activity of any kind, e.g. `1 tool child alive at 15:01:02Z`. */
  readonly lastActivity: () => string;
  readonly noteOutput: (bytes: number) => void;
  /** The last tick's findings joined for a kill line: `no output, no tool child, cpu unchanged`. */
  readonly stillness: () => string;
  /** Synchronous when the probe answers synchronously (or is absent), so a fake clock can drive it. */
  readonly tick: () => Promise<SeatLivenessTick> | SeatLivenessTick;
}

/** `2h0m`, `20m0s`, `59s`, `800ms` — the shape the kill and notice lines carry. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m${String(seconds)}s`;
  return `${String(seconds)}s`;
}

/** Wall-clock `HH:MM:SSZ` of an epoch instant, so a kill line can be matched to other logs. */
export function formatClock(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 19)}Z`;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

export function createSeatLiveness(options: SeatLivenessOptions): SeatLiveness {
  const floor = options.cpuActivityFloorMs ?? CPU_ACTIVITY_FLOOR_MS;
  const startedAt = options.now();
  let lastActivityAt = startedAt;
  let lastActivityKind = "seat start";
  let lastOutputAt = startedAt;
  let bytesSinceTick = 0;
  let launcherChain: number | undefined;
  let previousCpuMs: number | undefined;
  let stillness = "no output, not yet probed";

  const noteOutput = (bytes: number): void => {
    const at = options.now();
    bytesSinceTick += bytes;
    lastOutputAt = at;
    lastActivityAt = at;
    lastActivityKind = `output ${String(bytes)} bytes`;
  };

  /** `answer` is undefined when there is no probe (or no pid); a failed probe carries its reason. */
  const settle = (at: number, bytes: number, answer: SeatProbeAnswer | undefined): SeatLivenessTick => {
    const parts: string[] = [bytes > 0 ? `output ${String(bytes)} bytes` : "no output"];
    let failure: string | undefined;
    if (answer === undefined) {
      parts.push("no activity probe");
    } else if (isProbeFailure(answer)) {
      // FAIL-CLOSED: an unobserved tree grants no liveness, and the reason rides in every line.
      failure = answer.reason;
      parts.push(`tree unobserved: ${failure}`);
    } else {
      const sample = answer;
      launcherChain = Math.min(launcherChain ?? sample.descendants, sample.descendants);
      const toolChildren = sample.descendants - launcherChain;
      parts.push(toolChildren > 0
        ? `${String(toolChildren)} tool ${toolChildren === 1 ? "child" : "children"} alive`
        : "no tool child");
      const cpuDelta = previousCpuMs === undefined ? undefined : sample.cpuMs - previousCpuMs;
      previousCpuMs = sample.cpuMs;
      if (cpuDelta === undefined) parts.push("cpu baseline taken");
      else if (cpuDelta >= floor) parts.push(`cpu +${(cpuDelta / 1_000).toFixed(1)}s`);
      else if (cpuDelta < 0) parts.push("cpu rebased (a process left the tree)");
      else parts.push("cpu unchanged");
      // A live tool child outranks CPU as the named activity: it is what an operator looks for.
      if (toolChildren > 0) {
        lastActivityAt = at;
        lastActivityKind = parts[1]!;
      } else if (cpuDelta !== undefined && (cpuDelta >= floor || cpuDelta < 0)) {
        lastActivityAt = at;
        lastActivityKind = parts[2]!;
      }
    }
    stillness = parts.join(", ");
    return Object.freeze({
      detail: parts.join("; "), probeFailure: failure, quietMs: at - lastOutputAt, silentMs: at - lastActivityAt,
    });
  };

  // A probe that THROWS (or rejects) is a failed probe with the thrown message as its reason.
  const threw = (error: unknown): SeatProbeAnswer => probeFailure(`probe threw: ${describeThrownForProbe(error)}`);

  const tick = (): Promise<SeatLivenessTick> | SeatLivenessTick => {
    const at = options.now();
    const bytes = bytesSinceTick;
    bytesSinceTick = 0;
    if (options.probe === undefined || options.pid === undefined) return settle(at, bytes, undefined);
    let answer: ReturnType<SeatActivityProbe>;
    try {
      answer = options.probe(options.pid);
    } catch (error) {
      return settle(at, bytes, threw(error));
    }
    if (isThenable(answer)) {
      return Promise.resolve(answer).then(
        (sample) => settle(at, bytes, sample),
        (error: unknown) => settle(at, bytes, threw(error)),
      );
    }
    return settle(at, bytes, answer);
  };

  return Object.freeze({
    lastActivity: () => `${lastActivityKind} at ${formatClock(lastActivityAt)}`,
    noteOutput,
    stillness: () => `${stillness} since ${formatClock(lastActivityAt)}`,
    tick,
  });
}
