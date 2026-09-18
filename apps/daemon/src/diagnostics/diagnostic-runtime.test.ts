import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DIAGNOSTIC_LOG_FILENAME } from "./diagnostic-file-sink.js";
import {
  createDiagnosticRuntime, nullDiagnosticRuntime, sharedDiagnosticRuntime,
} from "./diagnostic-runtime.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "moe-diag-rt-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { force: true, recursive: true });
});

const clock = (): string => "2026-09-17T22:00:00.000Z";

function harness(env: Record<string, string> = {}): {
  readonly console: string[]; readonly root: string;
  readonly runtime: ReturnType<typeof createDiagnosticRuntime>;
} {
  const root = scratch();
  const lines: string[] = [];
  const runtime = createDiagnosticRuntime({
    clock, env, projectRoot: root, write: (line) => { lines.push(line); },
  });
  return { console: lines, root, runtime };
}

function logFile(root: string): string {
  return readFileSync(join(root, ".moe", "logs", DIAGNOSTIC_LOG_FILENAME), "utf8");
}

describe("createDiagnosticRuntime", () => {
  it("writes the durable line and the console line from one emit", () => {
    const { console: lines, root, runtime } = harness();

    runtime.emitterFor("store").error("STORE_READ_FAILED", { fields: { aggregate: "run-1" } });
    runtime.close();

    expect(logFile(root)).toContain("STORE_READ_FAILED");
    expect(lines[0]).toContain("ERROR store STORE_READ_FAILED");
  });

  it("holds an info record back from the console but keeps it on disk", () => {
    const { console: lines, root, runtime } = harness();

    runtime.emitterFor("boot").info("BOOT_STEP_COMPLETED");
    runtime.close();

    expect(logFile(root)).toContain("BOOT_STEP_COMPLETED");
    expect(lines).toEqual([]);
  });

  it("drops a debug record entirely at the default level", () => {
    const { root, runtime } = harness();

    runtime.emitterFor("boot").debug("BOOT_STEP_DETAIL");
    runtime.close();

    expect(existsSync(join(root, ".moe", "logs", DIAGNOSTIC_LOG_FILENAME))).toBe(false);
  });

  it("keeps a debug record when the operator raises the level", () => {
    const { root, runtime } = harness({ MOE_LOG_LEVEL: "debug" });

    runtime.emitterFor("boot").debug("BOOT_STEP_DETAIL");
    runtime.close();

    expect(logFile(root)).toContain("BOOT_STEP_DETAIL");
  });

  it("MOE_LOG=off writes no file and still speaks to the operator", () => {
    const { console: lines, root, runtime } = harness({ MOE_LOG: "off" });

    runtime.emitterFor("store").error("STORE_READ_FAILED");
    runtime.close();

    expect(existsSync(join(root, ".moe", "logs"))).toBe(false);
    expect(lines[0]).toContain("STORE_READ_FAILED");
  });

  it("MOE_LOG_CONSOLE=off keeps the file and silences the terminal", () => {
    const { console: lines, root, runtime } = harness({ MOE_LOG_CONSOLE: "off" });

    runtime.emitterFor("store").error("STORE_READ_FAILED");
    runtime.close();

    expect(logFile(root)).toContain("STORE_READ_FAILED");
    expect(lines).toEqual([]);
  });

  it("refuses a malformed knob by name at construction, before anything starts", () => {
    expect(() => createDiagnosticRuntime({ env: { MOE_LOG_LEVEL: "loud" }, projectRoot: "/x" }))
      .toThrow(/MOE_LOG_LEVEL/u);
  });

  it("tells the operator on the console when the file plane itself dies", () => {
    const root = scratch();
    // A FILE where the log directory should be: mkdir and append both refuse, which is the
    // shape an operator hits when .moe/logs was replaced or the volume went read-only.
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory", "utf8");
    const lines: string[] = [];
    const runtime = createDiagnosticRuntime({
      clock, env: { MOE_LOG_DIR: blocked }, projectRoot: root,
      write: (line) => { lines.push(line); },
    });

    runtime.emitterFor("store").error("STORE_READ_FAILED");

    expect(lines.some((line) => line.includes("DIAGNOSTIC_SINK_WRITE_FAILED"))).toBe(true);
  });

  it("scrubs a declared secret from both planes", () => {
    const root = scratch();
    const lines: string[] = [];
    const runtime = createDiagnosticRuntime({
      clock, env: {}, projectRoot: root, secrets: ["sk-live-abc"],
      write: (line) => { lines.push(line); },
    });

    runtime.emitterFor("store").error("STORE_READ_FAILED", { fields: { detail: "sk-live-abc" } });
    runtime.close();

    expect(logFile(root)).not.toContain("sk-live-abc");
    expect(lines.join("")).not.toContain("sk-live-abc");
  });

  it("the null runtime accepts every emit and keeps nothing", () => {
    expect(() => {
      nullDiagnosticRuntime().emitterFor("store").error("STORE_READ_FAILED");
    }).not.toThrow();
  });
});

describe("sharedDiagnosticRuntime", () => {
  it("hands every caller with the same project root the same instance, and another root its own", () => {
    // The daemon bin and the shipped provider both build from MOE_STORE_PATH in one process; two
    // file sinks on one log would race its rotation.
    const root = scratch();
    const other = scratch();
    const first = sharedDiagnosticRuntime({ env: { MOE_LOG_CONSOLE: "off" }, projectRoot: root });
    const second = sharedDiagnosticRuntime({ env: { MOE_LOG_CONSOLE: "off" }, projectRoot: root });
    const elsewhere = sharedDiagnosticRuntime({ env: { MOE_LOG_CONSOLE: "off" }, projectRoot: other });

    expect(second).toBe(first);
    expect(elsewhere).not.toBe(first);
    first.close();
    elsewhere.close();
  });
});
