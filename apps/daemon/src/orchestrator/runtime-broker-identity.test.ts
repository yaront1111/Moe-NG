import { describe, expect, it, vi } from "vitest";
import { brokerImageAt, parseRuntimeBroker, resolveRuntimeBrokerPid } from "./runtime-broker-identity.js";

/** The runtime's broker is named only when it really is the broker (addendum 2026-09-16). */
describe("naming this runtime's Job broker", () => {
  it.each([
    ["21416|D:\\projexts\\moe-next\\dist\\moe-windows\\packages\\runner\\bin\\moe-windows-job-broker.exe", 21416],
    ["noise\r\n21416|C:\\x\\MOE-WINDOWS-JOB-BROKER.EXE\r\n", 21416],
    ["31732|C:\\Program Files\\PowerShell\\7\\pwsh.exe", null],
    ["22524|C:\\Program Files\\nodejs\\node.exe", null],
    ["0|C:\\x\\moe-windows-job-broker.exe", null],
    ["", null],
    ["21416|", null],
    ["not a pid|C:\\x\\moe-windows-job-broker.exe", null],
  ])("reads %j as %s", (output, pid) => {
    expect(parseRuntimeBroker(output)).toBe(pid);
  });

  it("asks for the grandparent through the given parent, and trusts only the broker image", async () => {
    const run = vi.fn(async () => "21416|D:\\a\\moe-windows-job-broker.exe\n");

    expect(await resolveRuntimeBrokerPid(22524, run, "win32")).toBe(21416);
    const [file, args] = run.mock.calls[0]! as unknown as [string, string[]];
    expect(file.toLowerCase()).toContain("powershell.exe");
    expect(args.at(-1)).toContain("ProcessId=22524");
  });

  it("names no broker off Windows, for an invalid parent, or when the query fails", async () => {
    const run = vi.fn(async () => "21416|D:\\a\\moe-windows-job-broker.exe");
    expect(await resolveRuntimeBrokerPid(22524, run, "linux")).toBeNull();
    expect(await resolveRuntimeBrokerPid(0, run, "win32")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(await resolveRuntimeBrokerPid(22524, async () => { throw new Error("timed out"); }, "win32")).toBeNull();
  });

  it.runIf(process.platform === "win32")("names no broker for a process that is not under one", async () => {
    expect(await resolveRuntimeBrokerPid(process.ppid)).toBeNull();
  }, 60_000);
});

/** A live pid is not a live broker: Windows reuses pids (UnAI 2026-09-19, pid 42564). */
describe("whether a recorded broker pid still runs the broker image", () => {
  const csv = (image: string, pid: number): string => `"${image}","${String(pid)}","Console","1","7,004 K"` + String.fromCharCode(13, 10);

  it("says yes only for the broker image at exactly that pid", () => {
    const calls: string[][] = [];
    const run = (answer: string) => (file: string, args: readonly string[]): string => { calls.push([file, ...args]); return answer; };
    expect(brokerImageAt(42564, run(csv("moe-windows-job-broker.exe", 42564)), "win32")).toBe(true);
    expect(brokerImageAt(42564, run(csv("MOE-Windows-Job-Broker.EXE", 42564)), "win32")).toBe(true);
    // The pid now belongs to something else, or to nothing: not the broker.
    expect(brokerImageAt(42564, run(csv("node.exe", 42564)), "win32")).toBe(false);
    expect(brokerImageAt(42564, run("INFO: No tasks are running which match the specified criteria."), "win32")).toBe(false);
    // A row for ANOTHER pid proves nothing about this one.
    expect(brokerImageAt(42564, run(csv("moe-windows-job-broker.exe", 4256)), "win32")).toBe(false);
    expect(calls[0]?.slice(1)).toEqual(["/FI", "PID eq 42564", "/FO", "CSV", "/NH"]);
    expect(calls[0]?.[0]?.toLowerCase().endsWith("tasklist.exe")).toBe(true);
  });

  it("cannot say off Windows, for an invalid pid, or when the query fails", () => {
    const never = (): string => { throw new Error("must not run"); };
    expect(brokerImageAt(42564, never, "linux")).toBeNull();
    expect(brokerImageAt(0, never, "win32")).toBeNull();
    expect(brokerImageAt(42564, () => { throw new Error("tasklist missing"); }, "win32")).toBeNull();
  });

  it.runIf(process.platform === "win32")("asks the real OS: this test process is not the broker", () => {
    expect(brokerImageAt(process.pid)).toBe(false);
  }, 30_000);
});
