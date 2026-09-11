import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { landingSeatClaim } from "./lane-landing.js";
import { liveProviderSeat } from "./live-proof-seat.js";

const created: string[] = [];
const PRIVATE = "PRIVATE-PROVIDER-DIAGNOSTIC";
afterEach(() => {
  for (const dir of created.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + "\\") && process.platform === "win32") {
      throw new Error("seat fixture escaped its temporary root");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Execute the generated launcher; inject only its provider subprocess, never a real CLI. */
function runSeat(status: number | null, writes: boolean, spawnError = false, observePublication = false) {
  const dir = mkdtempSync(join(tmpdir(), "moe-live-seat-test-"));
  created.push(dir);
  const nodeKey = "node-test";
  const nodeRef = "node:v1:test";
  liveProviderSeat({
    briefs: [{ checks: [], modulePath: "module.mjs", nodeKey, objective: "test" }],
    dir, executable: PRIVATE, providerMode: "INJECTED_TEST", refs: { [nodeKey]: nodeRef },
    rendezvous: [], workspace: dir,
  });
  const hook = join(dir, "inject-provider.cjs");
  const end = join(dir, `seat-${nodeKey}.end`);
  const partial = join(dir, "observed-partial-mark");
  writeFileSync(hook, [
    'const fs = require("node:fs");',
    ...(observePublication ? [
      `const end = ${JSON.stringify(end)};`,
      `const partial = ${JSON.stringify(partial)};`,
      "const write = fs.writeFileSync;",
      "fs.writeFileSync = (file, bytes, options) => {",
      "  write(file, String(bytes).slice(0, 1), options);",
      "  if (fs.existsSync(end)) {",
      '    try { JSON.parse(fs.readFileSync(end, "utf8")); } catch { write(partial, "partial"); }',
      "  }",
      "  return write(file, bytes, options);",
      "};",
    ] : []),
    `const target = ${JSON.stringify(join(dir, "module.mjs"))};`,
    'require("node:child_process").spawnSync = () => {',
    writes ? '  fs.writeFileSync(target, "export const value = 1;\\n");' : "",
    `  return { pid: 123, status: ${JSON.stringify(status)}, stdout: ${JSON.stringify(PRIVATE)},`,
    `    stderr: ${JSON.stringify(PRIVATE)}, error: ${spawnError ? `new Error(${JSON.stringify(PRIVATE)})` : "undefined"} };`,
    "};",
  ].join("\n"), "utf8");
  const result = spawnSync(process.execPath, ["--require", hook, join(dir, "live-proof-provider-seat.js")], {
    cwd: dir, encoding: "utf8", input: landingSeatClaim(nodeRef), shell: false,
    timeout: 10_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  const mark = JSON.parse(readFileSync(end, "utf8")) as Record<string, unknown>;
  return { mark, output: result.stdout + result.stderr, partialVisible: existsSync(partial), status: result.status };
}

describe("live proof provider completion", () => {
  it.each([
    { label: "nonzero exit", status: 7, spawnError: false },
    { label: "timeout", status: null, spawnError: true },
    { label: "spawn error despite zero status", status: 0, spawnError: true },
  ])("rejects $label even when a module was written", ({ status, spawnError }) => {
    const result = runSeat(status, true, spawnError);
    expect(result.status).toBe(1);
    expect(result.mark["ok"]).toBe(false);
    expect(result.mark["providerStatus"]).toBe(status);
    expect(result.output).toContain("SEAT_PROVIDER_FAILED");
    expect(result.output).not.toContain(PRIVATE);
    expect(JSON.stringify(result.mark)).not.toContain(PRIVATE);
  });

  it("records completed injected output without crediting a real provider", () => {
    const result = runSeat(0, true);
    expect(result.status).toBe(0);
    expect(result.mark).toMatchObject({ ok: true, providerStatus: 0, realProvider: false });
    expect(result.mark["moduleBytes"]).toBe(Buffer.byteLength("export const value = 1;\n"));
    expect(Number(result.mark["startedAt"])).toBeGreaterThan(0);
    expect(Number(result.mark["endedAt"])).toBeGreaterThanOrEqual(Number(result.mark["startedAt"]));
    expect(JSON.stringify(result.mark)).not.toContain(PRIVATE);
    expect(result.output).not.toContain(PRIVATE);
  });

  it("refuses a zero-exit provider that writes no module without exposing diagnostics", () => {
    const result = runSeat(0, false);
    expect(result.status).toBe(1);
    expect(result.mark).toMatchObject({ ok: false, moduleBytes: 0, providerStatus: 0, realProvider: false });
    expect(result.output).toContain("SEAT_PROVIDER_WROTE_NOTHING");
    expect(result.output).not.toContain(PRIVATE);
    expect(JSON.stringify(result.mark)).not.toContain(PRIVATE);
  });

  it("publishes a complete terminal marker without exposing a partial JSON write", () => {
    const result = runSeat(0, true, false, true);
    expect(result.status).toBe(0);
    expect(result.mark["ok"]).toBe(true);
    expect(result.partialVisible).toBe(false);
  });
});
