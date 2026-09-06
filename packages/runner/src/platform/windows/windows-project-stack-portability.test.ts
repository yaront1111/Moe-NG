import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Exercise POSIX's native path semantics even when this regression runs on Windows.
// The request still carries Windows paths; win32's parser remains the real implementation.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, basename: actual.posix.basename };
});

import {
  encodeProjectStackLaunchPayload, openWindowsProjectStackBoundary,
} from "./windows-project-stack-boundary.js";

const REQUEST = Object.freeze({
  assetRoot: "C:\\Moe\\control-room",
  configPath: "C:\\Work\\alpha\\moe.config.json",
  cwd: "C:\\Moe",
  entryPath: "C:\\Moe\\apps\\daemon\\src\\projects\\project-stack-host-main.ts",
  environment: Object.freeze({}),
  instanceId: "11111111-1111-4111-8111-111111111111",
  nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
  storePath: "C:\\Work\\alpha\\store.sqlite",
});

describe("Windows project-stack paths on a POSIX path host", () => {
  it("encodes the reviewed Windows executable and entry without native path parsing", () => {
    expect(basename(REQUEST.nodeExecutable)).toBe(REQUEST.nodeExecutable);
    expect(encodeProjectStackLaunchPayload(REQUEST) instanceof Uint8Array).toBe(true);
  });

  it.each([
    ["foreign executable", { nodeExecutable: "C:\\Tools\\other.exe" }, "PROCESS_BOUNDARY_EXECUTABLE_REJECTED"],
    ["foreign entry", { entryPath: "C:\\Moe\\other-main.ts" }, "PROCESS_BOUNDARY_ARGV_REJECTED"],
    ["slash-normalized entry", { entryPath: "C:/Moe/project-stack-host-main.ts" }, "PROCESS_BOUNDARY_ARGV_REJECTED"],
  ] as const)("still rejects a %s", (_label, overrides, code) => {
    const result = encodeProjectStackLaunchPayload({ ...REQUEST, ...overrides });
    expect(result instanceof Uint8Array).toBe(false);
    if (result instanceof Uint8Array) throw new Error("invalid request was encoded");
    expect(result.code).toBe(code);
  });

  it.each(["linux", "darwin"])("refuses %s before reflecting on a request or accessing a broker", (platform) => {
    let reflected = 0;
    const hostile = new Proxy({}, {
      ownKeys: () => { reflected += 1; throw new Error("request reflection must not run"); },
      get: () => { reflected += 1; throw new Error("request access must not run"); },
    });
    const resolveBroker = vi.fn(() => { throw new Error("broker resolution must not run"); });
    const spawn = vi.fn(() => { throw new Error("broker spawn must not run"); });
    const result = openWindowsProjectStackBoundary(hostile, { deps: { platform, resolveBroker, spawn } });

    expect("truthClass" in result ? result.code : "BOUNDARY_OPENED")
      .toBe("PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED");
    expect(reflected).toBe(0);
    expect(resolveBroker).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
