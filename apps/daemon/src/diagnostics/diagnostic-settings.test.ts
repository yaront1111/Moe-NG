import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_ENV_INVALID, readDiagnosticSettings } from "./diagnostic-settings.js";

const root = "/project";

describe("readDiagnosticSettings", () => {
  it("defaults to .moe/logs beside the project, at info", () => {
    const settings = readDiagnosticSettings({}, root);

    expect(settings.level).toBe("info");
    expect(settings.directory.replaceAll("\\", "/")).toBe("/project/.moe/logs");
    expect(settings.consoleLevel).toBe("warn");
    expect(settings.enabled).toBe(true);
  });

  it("takes the level from MOE_LOG_LEVEL", () => {
    expect(readDiagnosticSettings({ MOE_LOG_LEVEL: "debug" }, root).level).toBe("debug");
  });

  it("refuses a malformed level BY NAME rather than guessing one", () => {
    expect(() => readDiagnosticSettings({ MOE_LOG_LEVEL: "verbose" }, root))
      .toThrow(new RegExp(`${DIAGNOSTIC_ENV_INVALID}: MOE_LOG_LEVEL`, "u"));
  });

  it("refuses a malformed byte bound by name", () => {
    expect(() => readDiagnosticSettings({ MOE_LOG_MAX_BYTES: "8mb" }, root))
      .toThrow(new RegExp(`${DIAGNOSTIC_ENV_INVALID}: MOE_LOG_MAX_BYTES`, "u"));
  });

  it("takes an explicit directory", () => {
    expect(readDiagnosticSettings({ MOE_LOG_DIR: "/var/log/moe" }, root).directory)
      .toBe("/var/log/moe");
  });

  it("turns the file plane off with MOE_LOG=off, keeping the console", () => {
    const settings = readDiagnosticSettings({ MOE_LOG: "off" }, root);

    expect(settings.enabled).toBe(false);
    expect(settings.consoleLevel).toBe("warn");
  });

  it("silences the console with MOE_LOG_CONSOLE=off", () => {
    expect(readDiagnosticSettings({ MOE_LOG_CONSOLE: "off" }, root).consoleLevel).toBeNull();
  });
});
