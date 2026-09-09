import { describe, expect, it, vi } from "vitest";
import * as surface from "../index.js";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("../platform/windows/windows-broker-path.js", async (original) => {
  const actual = await original<typeof import("../platform/windows/windows-broker-path.js")>();
  return { ...actual, resolveBrokerBinary: () => process.env["MOE_TEST_APPROVED_BROKER"] ?? actual.resolveBrokerBinary() };
});
const programSha256 = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");

describe("criterion check executor public boundary", () => {
  it("publishes the contained criterion executor while withholding the raw Windows launcher", () => {
    expect((surface as Record<string, unknown>)["createCriterionCheckExecutor"]).toBeTypeOf("function");
    expect("openWindowsProcessBoundary" in surface).toBe(false);
  });
  it("measures a real check through the published process boundary", async () => {
    const executor = surface.createCriterionCheckExecutor();
    const started: number[] = [];
    try {
      const result = await executor.run({ program: process.execPath, programSha256, args: ["-e", "process.stdout.write('criterion-proof')"],
        cwd: process.cwd(), timeoutMs: 30000 }, (pid) => { started.push(pid); });
      if (process.platform !== "win32") {
        expect(result).toMatchObject({ containment: "UNKNOWN", refusal: { code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED" } });
        expect(started).toEqual([]); return;
      }
      expect(result).toMatchObject({ containment: "PROVEN", exitCode: 0, refusal: null, byteCount: 15,
        outputSha256: createHash("sha256").update("criterion-proof").digest("hex") });
      expect(started).toHaveLength(1); expect(started[0]).toBeGreaterThan(0);
    } finally { await executor.close(); }
  }, 60000);
  it("refuses an unapproved executable digest at the native image layer before reporting a started child", async () => {
    const executor = surface.createCriterionCheckExecutor(); const started: number[] = [];
    try {
      const result = await executor.run({ program: process.execPath, programSha256: "0".repeat(64),
        args: ["--version"], cwd: process.cwd(), timeoutMs: 30000 }, (pid) => { started.push(pid); });
      expect(result).toMatchObject(process.platform === "win32"
        ? { containment: "UNKNOWN", refusal: { code: "PROCESS_BOUNDARY_BROKER_REFUSED", layer: "BROKER_APPROVED_IMAGE" } }
        : { containment: "UNKNOWN", refusal: { code: "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED" } });
      expect(started).toEqual([]);
    } finally { await executor.close(); }
  }, 60000);
  it("never falls back to an ordinary launch when the approved digest is absent", async () => {
    const executor = surface.createCriterionCheckExecutor(); const started: number[] = [];
    try {
      const result = await executor.run({ program: process.execPath, programSha256: undefined as never,
        args: ["--version"], cwd: process.cwd(), timeoutMs: 30000 }, (pid) => { started.push(pid); });
      expect(result).toMatchObject({ containment: "UNKNOWN", refusal: { code: "CRITERION_EXECUTOR_IMAGE_DIGEST_INVALID" } });
      expect(started).toEqual([]);
    } finally { await executor.close(); }
  }, 60000);
  it("holds the launched executable against transient replacement until its contained lifetime closes", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(join(tmpdir(), "moe-criterion-image-"));
    const program = join(root, "check.exe"); copyFileSync(process.execPath, program);
    const executor = surface.createCriterionCheckExecutor(); let writeBlocked = false; let renameBlocked = false;
    try {
      const result = await executor.run({ program, programSha256, args: ["-e", "setTimeout(()=>process.exit(0),1000)"],
        cwd: root, timeoutMs: 30000 }, () => {
          try { writeFileSync(program, "swapped"); } catch { writeBlocked = true; }
          try { renameSync(program, join(root, "replaced.exe")); } catch { renameBlocked = true; }
        });
      expect(result).toMatchObject({ containment: "PROVEN", exitCode: 0, refusal: null });
      expect(writeBlocked).toBe(true); expect(renameBlocked).toBe(true);
      expect(createHash("sha256").update(readFileSync(program)).digest("hex")).toBe(programSha256);
      renameSync(program, join(root, "released.exe"));
    } finally { await executor.close(); rmSync(root, { recursive: true, force: true }); }
  }, 60000);
  it("waits for contained cancellation when durable child binding throws", async () => {
    if (process.platform !== "win32") return;
    const executor = surface.createCriterionCheckExecutor(); let childPid = 0;
    try {
      const result = await executor.run({ program: process.execPath, programSha256,
        args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), timeoutMs: 30000 }, (pid) => {
          childPid = pid; throw new Error("durable PID binding failed");
        });
      expect(result).toMatchObject({ containment: "PROVEN", exitCode: null,
        refusal: { code: "CRITERION_EXECUTOR_PID_BIND_FAILED", layer: "CRITERION_EXECUTOR" } });
      expect(childPid).toBeGreaterThan(0); expect(() => process.kill(childPid, 0)).toThrow();
    } finally { await executor.close(); }
  }, 60000);
  it("refuses a reparse directory even when it currently reaches the approved binary", async () => {
    if (process.platform !== "win32") return;
    const root = mkdtempSync(join(tmpdir(), "moe-criterion-reparse-")); const linked = join(root, "linked");
    symlinkSync(dirname(process.execPath), linked, "junction");
    const executor = surface.createCriterionCheckExecutor(); const started: number[] = [];
    try {
      const result = await executor.run({ program: join(linked, basename(process.execPath)), programSha256,
        args: ["--version"], cwd: root, timeoutMs: 30000 }, (pid) => { started.push(pid); });
      expect(result).toMatchObject({ containment: "UNKNOWN", refusal: { code: "PROCESS_BOUNDARY_BROKER_REFUSED", layer: "BROKER_APPROVED_IMAGE" } });
      expect(started).toEqual([]);
    } finally { await executor.close(); rmSync(root, { recursive: true, force: true }); }
  }, 60000);
});
