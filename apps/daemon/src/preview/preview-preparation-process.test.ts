import { ChildProcess } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { expect, it } from "vitest";
import { runPreviewPreparation } from "./preview-preparation-process.js";

it("preparation uses the same runtime allowlist and explicit preview environment delivery", async () => {
  let options: SpawnOptions | undefined;
  const result = await runPreviewPreparation("npm ci --ignore-scripts", "D:/preview-source", {
    environment: { PATH: "test-runtime", SYSTEMROOT: "C:/Windows", UNRELATED_HOST_VALUE: "test-host-only" },
    delivered: { PREVIEW_CONFIG: "test-delivered", PATH: "test-collision" },
    spawn: (_file, _args, input) => {
      options = input; const child = new ChildProcess();
      queueMicrotask(() => child.emit("close", 0)); return child;
    },
  });
  expect(result.ok).toBe(true);
  expect(options?.env).toEqual({ PATH: "test-runtime", SYSTEMROOT: "C:/Windows", PREVIEW_CONFIG: "test-delivered" });
  expect(options?.stdio).toBe("ignore");
  expect(options?.windowsHide).toBe(true);
});

it("bounds a preparation process that never completes without exposing output", async () => {
  const result = await runPreviewPreparation("fixture setup", "D:/preview-source", {
    startTimeoutMs: 10, spawn: () => new ChildProcess(),
  });
  expect(result.ok).toBe(false);
  expect(result.alive()).toBe(false);
});
