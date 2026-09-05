import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findJetbrainsProxy, findSerena } from "../../scripts/mcp-host.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("project MCP config is host-native", () => {
  it("does not pin WSL-only moe or Serena paths", () => {
    const mcp = readFileSync(join(REPO_ROOT, ".mcp.json"), "utf8");
    expect(mcp).not.toContain("/mnt/");
    expect(mcp).not.toContain("/home/sysadmin");
    expect(mcp).toContain("scripts/mcp-moe.mjs");
    expect(mcp).toContain("scripts/mcp-serena.mjs");
  });
});

describe("findJetbrainsProxy", () => {
  it("prefers MOE_JETBRAINS_PROXY when that file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "moe-mcp-"));
    const proxy = join(dir, "index.js");
    writeFileSync(proxy, "export {};\n");
    expect(findJetbrainsProxy({ MOE_JETBRAINS_PROXY: proxy, APPDATA: join(dir, "missing") })).toBe(proxy);
    rmSync(dir, { recursive: true, force: true });
  });

  it("scans APPDATA/JetBrains/*/plugins/moe-jetbrains/proxy/index.js", () => {
    const appData = mkdtempSync(join(tmpdir(), "moe-appdata-"));
    const proxy = join(appData, "JetBrains", "PyCharm2026.1", "plugins", "moe-jetbrains", "proxy", "index.js");
    mkdirSync(dirname(proxy), { recursive: true });
    writeFileSync(proxy, "export {};\n");
    expect(findJetbrainsProxy({ APPDATA: appData })).toBe(proxy);
    rmSync(appData, { recursive: true, force: true });
  });

  it("refuses with a stable code when no proxy exists", () => {
    const appData = mkdtempSync(join(tmpdir(), "moe-empty-"));
    expect(() => findJetbrainsProxy({ APPDATA: appData, MOE_JETBRAINS_PROXY: join(appData, "nope.js") }))
      .toThrow(/MOE_MCP_PROXY_NOT_FOUND/);
    rmSync(appData, { recursive: true, force: true });
  });
});

describe("findSerena", () => {
  it("prefers serena.exe under the home .local/bin", () => {
    const home = mkdtempSync(join(tmpdir(), "moe-home-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const exe = join(home, ".local", "bin", "serena.exe");
    writeFileSync(exe, "");
    writeFileSync(join(home, ".local", "bin", "serena"), "");
    expect(findSerena(home)).toBe(exe);
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses with a stable code when Serena is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "moe-noserena-"));
    expect(() => findSerena(home)).toThrow(/SERENA_NOT_FOUND/);
    rmSync(home, { recursive: true, force: true });
  });
});
