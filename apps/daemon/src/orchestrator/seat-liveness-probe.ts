/**
 * The seat's LIVENESS PROBE: what the wrapper can observe about a seat that prints nothing.
 *
 * `claude -p` (and `codex exec -`) write NOTHING until they finish: the final report is the whole
 * of stdout. So bytes-on-stdout, the only activity signal the wrapper had, reads 0 for the seat's
 * entire life, and the wall-clock cap was the only thing that ever ended a hung seat — which also
 * ended working ones. UnAI 2026-09-18: node 6 was killed at exactly 30 min ("agent exceeded
 * 1800000ms; killing") while a bash tool child of claude.exe was alive; node 5 finished with 59 s
 * to spare; every quiet notice in between read "0 bytes seen".
 *
 * WHY NOT `--output-format stream-json`: it would make the seat speak as it works, but it changes
 * how the wrapper reads the seat's FINAL REPORT (the bounded tail the exit classifier and the
 * ledger fold read), so that switch is OUT OF SCOPE here. This probe looks at the OS instead: the
 * seat's process tree (a tool child is a descendant) and the tree's cumulative CPU time. ONE
 * process spawn per tick at the liveness cadence, never per event. seat-liveness.ts turns the
 * samples into a verdict; this file only measures.
 */
import { execFile } from "node:child_process";
import { win32 } from "node:path";

export interface SeatActivitySample {
  /** Processes below the seat pid at any depth; the seat itself is not counted. */
  readonly descendants: number;
  /** Cumulative CPU time (user + kernel) of the seat and every descendant, in ms. */
  readonly cpuMs: number;
}

/**
 * The probe could not see the tree, and SAYS WHY: a PowerShell timeout, a non-zero exit with
 * its stderr tail, a missing `ps`, or whatever was thrown. The reason reaches the quiet notice
 * and a once-per-seat warning. Unobserved ticks count no silence; only the absolute cap can
 * end the seat until a tick sees the tree again.
 */
export interface SeatProbeFailure {
  readonly ok: false;
  /** Bounded, single-line text (PROBE_REASON_MAX_CHARS). */
  readonly reason: string;
}

export type SeatProbeAnswer = SeatActivitySample | SeatProbeFailure;

/** A synchronous answer is allowed so a test can drive the spawner's tick under fake timers. */
export type SeatActivityProbe = (pid: number) => Promise<SeatProbeAnswer> | SeatProbeAnswer;

export const PROBE_REASON_MAX_CHARS = 200;
/** The stderr tail a command failure carries: the LAST bytes, where the error is, with room for its prefix. */
const STDERR_TAIL_CHARS = 120;

export const isProbeFailure = (answer: SeatProbeAnswer): answer is SeatProbeFailure =>
  "ok" in answer && answer.ok === false;

/** One line, at most PROBE_REASON_MAX_CHARS: a reason travels inside log lines, never as a dump. */
export function boundProbeReason(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat === "") return "no detail";
  return flat.length <= PROBE_REASON_MAX_CHARS ? flat : `${flat.slice(0, PROBE_REASON_MAX_CHARS - 1)}…`;
}

export const probeFailure = (reason: string): SeatProbeFailure =>
  Object.freeze({ ok: false as const, reason: boundProbeReason(reason) });

/** The thrown value's message, or its string form, bounded: what a failing probe reports. */
export function describeThrownForProbe(error: unknown): string {
  if (error instanceof Error) return boundProbeReason(error.message);
  return boundProbeReason(typeof error === "string" ? error : String(error));
}

/**
 * What `execFile` handed back, as one reason: a timeout names the budget, a non-zero exit names
 * the code and the stderr tail, a spawn errno (ENOENT, EACCES) names itself, anything else its
 * message. The stderr tail is what tells `ps: illegal option` from `Get-CimInstance : Access denied`.
 */
export function describeProbeCommandFailure(
  error: unknown, stderr: string, timeoutMs: number,
): string {
  const facts = (typeof error === "object" && error !== null ? error : {}) as {
    readonly code?: unknown; readonly killed?: unknown; readonly message?: unknown; readonly signal?: unknown;
  };
  const tail = boundProbeReason(stderr.slice(-STDERR_TAIL_CHARS));
  if (facts.killed === true) {
    return boundProbeReason(`timed out after ${String(timeoutMs)}ms (${String(facts.signal ?? "killed")})`
      + (stderr.trim() === "" ? "" : `: ${tail}`));
  }
  if (typeof facts.code === "number") {
    return boundProbeReason(`exit ${String(facts.code)}${stderr.trim() === "" ? "" : `: ${tail}`}`);
  }
  if (typeof facts.code === "string") {
    return boundProbeReason(`${facts.code}: ${typeof facts.message === "string" ? facts.message : "spawn failed"}`);
  }
  return describeThrownForProbe(error);
}

export interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly cpuMs: number;
}

/** Walks the tree under `rootPid`; `null` when the root is not in the table. */
export function sampleProcessTree(
  rows: readonly ProcessRow[], rootPid: number,
): SeatActivitySample | null {
  const byPid = new Map<number, ProcessRow>();
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = children.get(row.parentPid);
    if (siblings === undefined) children.set(row.parentPid, [row]);
    else siblings.push(row);
  }
  const root = byPid.get(rootPid);
  if (root === undefined) return null;
  // A reused parent pid can make the table cyclic; every pid is visited once.
  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  let descendants = 0;
  let cpuMs = root.cpuMs;
  for (let head = 0; head < queue.length; head += 1) {
    for (const child of children.get(queue[head]!) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      queue.push(child.pid);
      descendants += 1;
      cpuMs += child.cpuMs;
    }
  }
  return Object.freeze({ cpuMs, descendants });
}

/** One `pid|ppid|cpu100ns` line per process, as WINDOWS_TREE_SCRIPT prints them. */
export function parseWindowsProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const [pid, parentPid, cpu] = line.trim().split("|");
    const row = { cpuMs: Number(cpu ?? "") / 10_000, parentPid: Number(parentPid ?? ""), pid: Number(pid ?? "") };
    if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parentPid)
      || !Number.isFinite(row.cpuMs) || line.trim() === "") continue;
    rows.push(Object.freeze(row));
  }
  return rows;
}

/** `ps` TIME as `[[dd-]hh:]mm:ss[.cc]` (Linux and macOS spellings), in ms; `null` when malformed. */
export function parsePsCpuTime(field: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(field.trim());
  if (match === null) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  const total = Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(total) ? Math.round(total * 1_000) : null;
}

/** One `pid ppid time` line per process, as `ps -A -o pid=,ppid=,time=` prints them. */
export function parsePosixProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const [pid, parentPid, time] = line.trim().split(/\s+/u);
    const cpuMs = parsePsCpuTime(time ?? "");
    const row = { cpuMs: cpuMs ?? 0, parentPid: Number(parentPid ?? ""), pid: Number(pid ?? "") };
    if (cpuMs === null || !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parentPid)) continue;
    rows.push(Object.freeze(row));
  }
  return rows;
}

export type ProbeCommand = (file: string, args: readonly string[]) => Promise<string>;

/** Every process, because the tree is walked here: CIM has no descendant query of its own. */
export const WINDOWS_TREE_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object {"
  + " [Console]::Out.WriteLine(\"$($_.ProcessId)|$($_.ParentProcessId)|$($_.KernelModeTime+$_.UserModeTime)\") }";
export const POSIX_TREE_ARGS = Object.freeze(["-A", "-o", "pid=,ppid=,time="] as const);

const PROBE_COMMAND_TIMEOUT_MS = 30_000;

/** Rejects with an Error whose message is already the bounded reason the notice will carry. */
const runCommand: ProbeCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: PROBE_COMMAND_TIMEOUT_MS, windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error === null) resolve(stdout);
    else reject(new Error(`${win32.basename(file)} ${describeProbeCommandFailure(error, stderr, PROBE_COMMAND_TIMEOUT_MS)}`));
  });
});

function windowsPowerShell(environment: NodeJS.ProcessEnv): string {
  return win32.join(environment["SystemRoot"] ?? environment["SYSTEMROOT"] ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The real probe for one platform. It never throws: a throwing or timing-out command, a table
 * without the seat, or a nonsense pid answers `{ ok: false, reason }`, and the caller reports
 * the tree as unobserved WITH that reason. Unobserved ticks count no silence (epic rail 4).
 */
export function createSeatActivityProbe(
  platform: NodeJS.Platform = process.platform,
  run: ProbeCommand = runCommand,
  environment: NodeJS.ProcessEnv = process.env,
): SeatActivityProbe {
  return async (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return probeFailure(`pid ${String(pid)} is not a positive integer`);
    let rows: ProcessRow[];
    try {
      if (platform === "win32") {
        rows = parseWindowsProcessRows(await run(windowsPowerShell(environment),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_SCRIPT]));
      } else {
        rows = parsePosixProcessRows(await run("ps", POSIX_TREE_ARGS));
      }
    } catch (error) {
      return probeFailure(describeThrownForProbe(error));
    }
    if (rows.length === 0) return probeFailure("process table read empty (no parseable rows)");
    return sampleProcessTree(rows, pid) ?? probeFailure(`pid ${String(pid)} not in the process table`);
  };
}
