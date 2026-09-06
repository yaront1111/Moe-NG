import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

import { deliverEnvironment } from "./environment-delivery.js";

it.each(["win32", "linux"] as const)("uses %s name semantics for runtime collisions", (platform) => {
  const runtime = { Path: "runtime-bin", ComSpec: "runtime-shell", Temp: "" };
  const delivered = { PATH: "project-bin", COMSPEC: "project-shell", TEMP: "project-temp", APP_SETTING: "enabled" };
  const merged = deliverEnvironment(runtime, delivered, platform);

  expect(merged.collisions).toEqual(platform === "win32" ? ["PATH", "COMSPEC", "TEMP"] : []);
  expect(merged.environment["Path"] === runtime.Path).toBe(true);
  expect(merged.environment["ComSpec"] === runtime.ComSpec).toBe(true);
  expect(merged.environment["Temp"] === runtime.Temp).toBe(true);
  expect(merged.environment["APP_SETTING"] === delivered.APP_SETTING).toBe(true);
  for (const name of ["PATH", "COMSPEC", "TEMP"]) {
    expect(Object.hasOwn(merged.environment, name)).toBe(platform !== "win32");
  }
  expect(Object.keys(runtime)).toEqual(["Path", "ComSpec", "Temp"]);
});

it.runIf(process.platform === "win32")("preserves the runtime search path in a real Windows child", () => {
  const runtime = "runtime-search-path";
  const merged = deliverEnvironment({ Path: runtime }, { PATH: "project-search-path" });
  const child = execFileSync(process.execPath, [
    "-e", "process.stdout.write(String(process.env.PATH === process.argv[1]))", runtime,
  ], { encoding: "utf8", env: merged.environment, shell: false, windowsHide: true });

  expect(child).toBe("true");
  expect(merged.collisions).toEqual(["PATH"]);
});
