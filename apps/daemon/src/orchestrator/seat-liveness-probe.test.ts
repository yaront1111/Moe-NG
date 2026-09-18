import { describe, expect, it } from "vitest";

import {
  POSIX_TREE_ARGS, PROBE_REASON_MAX_CHARS, WINDOWS_TREE_SCRIPT, boundProbeReason, createSeatActivityProbe,
  describeProbeCommandFailure, parsePosixProcessRows, parsePsCpuTime, parseWindowsProcessRows,
  sampleProcessTree,
} from "./seat-liveness-probe.js";
import type { ProcessRow } from "./seat-liveness-probe.js";

const row = (pid: number, parentPid: number, cpuMs = 0): ProcessRow => ({ cpuMs, parentPid, pid });

describe("sampleProcessTree", () => {
  it("counts every descendant at any depth and sums the tree's CPU, seat included", () => {
    // cmd.exe(100) -> claude.exe(200) -> bash.exe(300) -> node.exe(400); an unrelated 500.
    const rows = [row(100, 1, 10), row(200, 100, 1_500), row(300, 200, 20), row(400, 300, 3_000), row(500, 1, 999)];
    expect(sampleProcessTree(rows, 100)).toEqual({ cpuMs: 4_530, descendants: 3 });
    expect(sampleProcessTree(rows, 200)).toEqual({ cpuMs: 4_520, descendants: 2 });
    expect(sampleProcessTree(rows, 400)).toEqual({ cpuMs: 3_000, descendants: 0 });
  });

  it("answers null when the seat is not in the table, which is how a dead seat reads", () => {
    expect(sampleProcessTree([row(100, 1)], 4242)).toBeNull();
    expect(sampleProcessTree([], 4242)).toBeNull();
  });

  it("survives a reused parent pid that makes the table cyclic", () => {
    const rows = [row(100, 300, 1), row(200, 100, 1), row(300, 200, 1)];
    expect(sampleProcessTree(rows, 100)).toEqual({ cpuMs: 3, descendants: 2 });
  });
});

describe("parseWindowsProcessRows", () => {
  it("reads pid|ppid|100ns lines and converts to ms, skipping blank and malformed lines", () => {
    const text = "\r\n4|0|\r\n100|4|12345678\r\ngarbage\r\n200|100|20000000\r\n";
    expect(parseWindowsProcessRows(text)).toEqual([
      // KernelModeTime + UserModeTime is $null on the System process: reads 0, not skipped.
      { cpuMs: 0, parentPid: 0, pid: 4 },
      { cpuMs: 1234.5678, parentPid: 4, pid: 100 },
      { cpuMs: 2_000, parentPid: 100, pid: 200 },
    ]);
  });
});

describe("parsePsCpuTime", () => {
  it("reads every ps TIME spelling", () => {
    expect(parsePsCpuTime("00:00:05")).toBe(5_000);
    expect(parsePsCpuTime("01:02:03")).toBe(3_723_000);
    expect(parsePsCpuTime("2-01:00:00")).toBe(176_400_000);
    // macOS: mm:ss.cc
    expect(parsePsCpuTime("0:00.05")).toBe(50);
    expect(parsePsCpuTime("12:34.56")).toBe(754_560);
    expect(parsePsCpuTime("")).toBeNull();
    expect(parsePsCpuTime("abc")).toBeNull();
  });
});

describe("parsePosixProcessRows", () => {
  it("reads ps -o pid=,ppid=,time= output, skipping malformed lines", () => {
    const text = "    1     0 00:00:03\n 4242     1 00:01:00\n 4300  4242 0:00.50\n bad line here\n";
    expect(parsePosixProcessRows(text)).toEqual([
      { cpuMs: 3_000, parentPid: 0, pid: 1 },
      { cpuMs: 60_000, parentPid: 1, pid: 4242 },
      { cpuMs: 500, parentPid: 4242, pid: 4300 },
    ]);
  });
});

describe("createSeatActivityProbe", () => {
  it("asks PowerShell for the whole CIM process table on win32 and walks it here", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const probe = createSeatActivityProbe("win32", async (file, args) => {
      calls.push({ args, file });
      return "4242|1|10000000\r\n4300|4242|5000000\r\n4400|4300|0\r\n9|1|1\r\n";
    }, { SystemRoot: "C:\\Windows" });
    await expect(probe(4242)).resolves.toEqual({ cpuMs: 1_500, descendants: 2 });
    expect(calls).toEqual([{
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_SCRIPT],
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    }]);
    expect(WINDOWS_TREE_SCRIPT).toContain("Get-CimInstance Win32_Process");
    expect(WINDOWS_TREE_SCRIPT).toContain("KernelModeTime+$_.UserModeTime");
  });

  it("asks ps for pid, ppid and time on POSIX", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const probe = createSeatActivityProbe("linux", async (file, args) => {
      calls.push({ args, file });
      return "4242 1 00:00:01\n4300 4242 00:00:02\n";
    });
    await expect(probe(4242)).resolves.toEqual({ cpuMs: 3_000, descendants: 1 });
    expect(calls).toEqual([{ args: [...POSIX_TREE_ARGS], file: "ps" }]);
  });

  it("answers { ok: false, reason }, never throws, and the reason names what failed", async () => {
    // The command threw (execFile rejected): the thrown message IS the reason.
    const failing = createSeatActivityProbe("linux", async () => { throw new Error("ps: not found"); });
    await expect(failing(4242)).resolves.toEqual({ ok: false, reason: "ps: not found" });
    // A table without the seat: a dead seat, or a pid the table never carried.
    const fine = createSeatActivityProbe("linux", async () => "4242 1 00:00:01\n");
    await expect(fine(9999)).resolves.toEqual({ ok: false, reason: "pid 9999 not in the process table" });
    await expect(fine(0)).resolves.toEqual({ ok: false, reason: "pid 0 is not a positive integer" });
    await expect(fine(-1)).resolves.toEqual({ ok: false, reason: "pid -1 is not a positive integer" });
    await expect(fine(Number.NaN)).resolves.toEqual({ ok: false, reason: "pid NaN is not a positive integer" });
    // The command answered, but nothing in it parsed: named apart from "seat absent".
    const empty = createSeatActivityProbe("linux", async () => "garbage\n");
    await expect(empty(4242)).resolves.toEqual({ ok: false, reason: "process table read empty (no parseable rows)" });
  });

  it("bounds every reason to one line of at most PROBE_REASON_MAX_CHARS", async () => {
    const long = createSeatActivityProbe("linux", async () => { throw new Error(`x\n${"y".repeat(500)}`); });
    const answer = await long(4242);
    expect(answer).toMatchObject({ ok: false });
    if ("ok" in answer) {
      expect(answer.reason.length).toBe(PROBE_REASON_MAX_CHARS);
      expect(answer.reason).not.toContain("\n");
      expect(answer.reason.startsWith("x y")).toBe(true);
    }
    expect(boundProbeReason("  \n ")).toBe("no detail");
  });
});

describe("describeProbeCommandFailure", () => {
  it("names a timeout, an exit code with its stderr tail, a spawn errno, or the thrown message", () => {
    // execFile on timeout: killed with SIGTERM, no exit code.
    expect(describeProbeCommandFailure({ killed: true, signal: "SIGTERM", code: null }, "", 30_000))
      .toBe("timed out after 30000ms (SIGTERM)");
    expect(describeProbeCommandFailure({ code: 1, killed: false }, "Get-CimInstance : Access denied\r\n", 30_000))
      .toBe("exit 1: Get-CimInstance : Access denied");
    expect(describeProbeCommandFailure({ code: 2, killed: false }, "", 30_000)).toBe("exit 2");
    expect(describeProbeCommandFailure({ code: "ENOENT", message: "spawn ps ENOENT" }, "", 30_000))
      .toBe("ENOENT: spawn ps ENOENT");
    expect(describeProbeCommandFailure(new Error("boom"), "", 30_000)).toBe("boom");
    expect(describeProbeCommandFailure("plain text", "", 30_000)).toBe("plain text");
    // The stderr tail is the LAST bytes, where the error usually is, and is bounded.
    const tail = describeProbeCommandFailure({ code: 1 }, `${"noise ".repeat(100)}real error`, 30_000);
    expect(tail.endsWith("real error")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(PROBE_REASON_MAX_CHARS);
  });
});
