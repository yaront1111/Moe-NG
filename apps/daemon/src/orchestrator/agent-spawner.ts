import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSpawnInvocation } from "./agent-spawn-invocation.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * Spawns one `claude -p` process per staffed work item, wired to the moe-next
 * MCP server through a per-agent config file. Credentials reach the agent's
 * MCP server through that file's `env` block only — never argv, never the
 * mission text — and the file is removed the moment the agent exits.
 */
const DAEMON_DIR = new URL("../..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, "");
const MCP_MAIN = new URL("../mcp-main.ts", import.meta.url).pathname
  .replace(/^\/(?=[A-Za-z]:)/u, "");

/** Everything the spawner touches outside its own arguments, injectable for tests. */
export interface AgentSpawnerOptions {
  readonly command?: string;
  readonly log?: (line: string) => void;
  readonly spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Hard lifetime for one agent process; a hung agent is killed and its slot freed. */
  readonly timeoutMs?: number;
  /** Platform override for the kill strategy (win32 needs a tree kill). */
  readonly platform?: NodeJS.Platform;
}

/** Default agent lifetime: the claim TTL, so a hung agent frees its slot no later
 *  than its claim's reap horizon rather than holding a maxAgents slot forever. */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

const CHAIN_TOOLS = "mcp__moe-next,mcp__moe-next__*";
const CODING_TOOLS = `${CHAIN_TOOLS},Edit,Write,Read,Glob,Grep,Bash`;

export function claudeSpawner(
  storeEnv: Readonly<Record<string, string>>,
  options: AgentSpawnerOptions = {},
): (request: SpawnRequest) => Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), "moe-wrapper-"));
  // Per-agent files are removed as each agent exits; the directory itself goes
  // with the wrapper process, whichever way it ends.
  process.once("exit", () => { rmSync(configDir, { force: true, recursive: true }); });
  const command = options.command ?? process.env["MOE_AGENT_COMMAND"] ?? "claude";
  const spawn = options.spawn ?? nodeSpawn;
  const log = options.log ?? ((line: string): void => { process.stdout.write(`${line}\n`); });
  const envTimeout = Number(process.env["MOE_AGENT_TIMEOUT_MS"] ?? "");
  const timeoutMs = options.timeoutMs
    ?? (Number.isSafeInteger(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_AGENT_TIMEOUT_MS);
  const platform = options.platform ?? process.platform;
  return (request: SpawnRequest): Promise<void> => {
    const mcpConfigPath = join(configDir, `${request.sessionId}.json`);
    // Absolute entry path: MCP server configs carry no working directory, and
    // node resolves the module's own relative imports from its file URL anyway.
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        "moe-next": {
          args: [MCP_MAIN],
          command: "node",
          env: { ...storeEnv, MOE_SESSION_CREDENTIAL: request.credential },
        },
      },
    }), "utf8");
    // Code-node agents work IN their workspace and get the file/exec tools a
    // worker needs; chain-step agents keep the MCP-only surface.
    const coding = request.workspace !== null;
    return new Promise((resolve) => {
      // The mission travels over STDIN: on Windows the CLI is a .cmd requiring
      // shell resolution, and a shell line would shred a space-bearing prompt
      // argument. `agentSpawnInvocation` builds that line itself (argv plus
      // `shell: true` is deprecated, DEP0190) and quotes the one argument —
      // the config path — that may legitimately carry whitespace.
      const invocation = agentSpawnInvocation(command, [
        "-p",
        "--mcp-config", mcpConfigPath,
        "--allowedTools", coding ? CODING_TOOLS : CHAIN_TOOLS,
      ]);
      const child = spawn(invocation.file, [...invocation.args], {
        cwd: request.workspace ?? DAEMON_DIR,
        shell: invocation.shell,
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin?.write(request.mission);
      child.stdin?.end();
      // A hung agent must not hold its maxAgents slot forever: kill its process
      // tree after the lifetime bound (on win32 the child is cmd.exe, so a plain
      // kill would orphan the real agent). The claim's own reap horizon frees the
      // work item; this frees the wrapper slot and the credentialed config file.
      const killTree = (): void => {
        if (platform === "win32" && child.pid !== undefined) {
          try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); }
          catch { child.kill(); }
        } else {
          child.kill();
        }
      };
      // The config file carries the agent's credential; it must not outlive the
      // agent it was minted for. Both exit paths remove it; a missing file is fine.
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rmSync(mcpConfigPath, { force: true });
        resolve();
      };
      const timer = setTimeout(() => {
        // Free the slot on the deadline whether or not the kill lands: waiting
        // for the process to actually exit is the very hang this bound exists
        // to break. Kill is best-effort cleanup; a later exit is a no-op finish.
        log(`[wrapper] ${request.workItemId} agent exceeded ${String(timeoutMs)}ms; killing`);
        killTree();
        finish();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      child.on("exit", (code) => {
        log(`[wrapper] ${request.workItemId} agent exited ${String(code)}`);
        finish();
      });
      child.on("error", finish);
    });
  };
}
