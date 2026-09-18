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
 *
 * CPU is evidence, never a threshold (human ruling 2026-09-18, task-eca3780d comment-6d395077).
 * Measured on this host through this probe, in ms of tree CPU per ~60 s (comment-a96f4b63): a hung
 * `claude -p` burns 125-547; a working one with no tool child burns 219-1219. The bands overlap,
 * so any growth counts as activity, and a hung seat that still burns CPU is bounded only by the
 * absolute cap. A wasted wait is recoverable; a killed working seat loses its context.
 */
import { describeThrownForProbe, isProbeFailure, probeFailure } from "./seat-liveness-probe.js";
import type { SeatActivityProbe, SeatProbeAnswer } from "./seat-liveness-probe.js";

export interface SeatLivenessOptions {
  readonly now: () => number;
  readonly pid: number | undefined;
  /**
   * Absent means the tree is unobserved this tick (same as a missing pid). A silence kill needs a
   * whole window of ticks that SAW the tree still; a tick that could not see it is neither activity
   * nor silence, and it restarts the count (epic rail 4: unverifiable evidence gains no authority).
   * A probe that fails on every tick, or at least once in every window, leaves only the absolute
   * cap; one transient failure delays a kill by at most one window.
   */
  readonly probe: SeatActivityProbe | undefined;
}

export interface SeatLivenessTick {
  /** What this tick saw, e.g. `no output; 1 tool child alive; cpu +1.3s`. */
  readonly detail: string;
  /**
   * Set when the probe could not see the tree this tick: the bounded reason (timeout, exit code
   * and stderr tail, thrown message). Unobserved is neither activity nor silence: it restarts the
   * observed-silence count. The spawner warns once.
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

/** Sub-second growth as whole ms rounded UP so a real quantum never reads as zero; else `N.Ns`. */
function formatCpuGrowth(ms: number): string {
  if (ms < 1_000) return `${String(Math.ceil(ms))}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

export function createSeatLiveness(options: SeatLivenessOptions): SeatLiveness {
  const startedAt = options.now();
  let lastActivityAt = startedAt;
  let lastUnobservedAt = startedAt;
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
      // Unobserved: neither activity nor silence. Restarts the observed-silence count.
      lastUnobservedAt = at;
      parts.push("no activity probe");
    } else if (isProbeFailure(answer)) {
      lastUnobservedAt = at;
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
      else if (cpuDelta > 0) parts.push(`cpu +${formatCpuGrowth(cpuDelta)}`);
      else if (cpuDelta < 0) parts.push("cpu rebased (a process left the tree)");
      else parts.push("cpu unchanged");
      // A live tool child outranks CPU as the named activity: it is what an operator looks for.
      if (toolChildren > 0) {
        lastActivityAt = at;
        lastActivityKind = parts[1]!;
      } else if (cpuDelta !== undefined && cpuDelta !== 0) {
        lastActivityAt = at;
        lastActivityKind = parts[2]!;
      }
    }
    stillness = parts.join(", ");
    const silenceAnchor = Math.max(lastActivityAt, lastUnobservedAt);
    return Object.freeze({
      detail: parts.join("; "), probeFailure: failure, quietMs: at - lastOutputAt, silentMs: at - silenceAnchor,
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
    stillness: () => `${stillness} since ${formatClock(Math.max(lastActivityAt, lastUnobservedAt))}`,
    tick,
  });
}
