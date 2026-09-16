import { describe, expect, it, vi } from "vitest";
import { parseRuntimeBroker, resolveRuntimeBrokerPid } from "./runtime-broker-identity.js";

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
