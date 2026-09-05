/**
 * Host-native MCP launch helpers. Claude, Grok, and Cursor on Windows and WSL
 * share these so `.mcp.json` never pins `/mnt/...` or another machine's home.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function findJetbrainsProxy(env = process.env) {
  const explicit = env.MOE_JETBRAINS_PROXY;
  if (typeof explicit === "string" && explicit !== "" && existsSync(explicit)) return explicit;
  const appData = env.APPDATA;
  if (typeof appData === "string" && appData !== "") {
    const jetbrains = join(appData, "JetBrains");
    if (existsSync(jetbrains)) {
      for (const name of readdirSync(jetbrains)) {
        const candidate = join(jetbrains, name, "plugins", "moe-jetbrains", "proxy", "index.js");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error("MOE_MCP_PROXY_NOT_FOUND: JetBrains moe-jetbrains proxy/index.js is not on this host. Set MOE_JETBRAINS_PROXY.");
}

/**
 * @param {string} [home]
 * @returns {string}
 */
export function findSerena(home = homedir()) {
  const exe = join(home, ".local", "bin", "serena.exe");
  if (existsSync(exe)) return exe;
  const unix = join(home, ".local", "bin", "serena");
  if (existsSync(unix)) return unix;
  throw new Error("SERENA_NOT_FOUND: ~/.local/bin/serena(.exe) is not on this host.");
}
