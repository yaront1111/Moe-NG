#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "../daemon-store-dependencies.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * The process wrapper: `node src/orchestrator/agent-wrapper-main.ts` staffs the
 * board the way old Moe's daemon staffed its task list — every unclaimed READY
 * step gets a scoped agent session and a spawned `claude` process wired to the
 * moe-next MCP server, mission-prompted with exactly the item it claimed.
 *
 * Environment: the store trio + MOE_DAEMON_CREDENTIAL (operator), and
 * optionally MOE_AGENT_COMMAND (default "claude"), MOE_WRAPPER_MAX_AGENTS
 * (default 2), MOE_WRAPPER_INTERVAL_MS (default 15000), MOE_WRAPPER_ONCE=1 for
 * a single pass. Credentials reach the agent through its process environment
 * only — never argv, never a file the mission names.
 */
const DAEMON_DIR = new URL("../..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, "");
const MCP_MAIN = new URL("../mcp-main.ts", import.meta.url).pathname
  .replace(/^\/(?=[A-Za-z]:)/u, "");

function claudeSpawner(storeEnv: Readonly<Record<string, string>>) {
  const configDir = mkdtempSync(join(tmpdir(), "moe-wrapper-"));
  const command = process.env["MOE_AGENT_COMMAND"] ?? "claude";
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
    return new Promise((resolve) => {
      // The mission travels over STDIN: on Windows the CLI is a .cmd requiring
      // shell resolution, and shell spawns concatenate argv unescaped — a
      // space-bearing prompt argument arrives shredded. Every remaining argv
      // element is space-free by construction.
      const child = spawn(command, [
        "-p",
        "--mcp-config", mcpConfigPath,
        "--allowedTools", "mcp__moe-next,mcp__moe-next__*",
      ], {
        cwd: DAEMON_DIR,
        shell: process.platform === "win32",
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin?.write(request.mission);
      child.stdin?.end();
      child.on("exit", (code) => {
        process.stdout.write(`[wrapper] ${request.workItemId} agent exited ${String(code)}\n`);
        resolve();
      });
      child.on("error", () => resolve());
    });
  };
}

async function main(): Promise<void> {
  const config = readStoreDependencyEnv(process.env);
  const provider = createStoreDependencies(config);
  const affordances = provider.affordances?.();
  if (affordances === undefined) throw new Error("provider serves no affordance surface");

  // DEVELOPMENT payload suggestions from the control room's dev table, loaded
  // leniently: a missing module just means missions carry no hint.
  const hintModule = await import(
    new URL("../../../control-room/src/live/live-dispatch.ts", import.meta.url).href
  ).catch(() => null) as
    { payloadFor?: (kind: string, target: string | null) => object | null } | null;

  const wrapper = createAgentWrapper({
    payloadHint: (kind, target) =>
      (hintModule?.payloadFor?.(kind, target) ?? null) as never,
    affordances,
    claimTtlMs: 30 * 60 * 1000,
    clock: () => Date.now(),
    deps: provider.provide(),
    maxAgents: Number(process.env["MOE_WRAPPER_MAX_AGENTS"] ?? "2"),
    mintSecret: () => randomUUID().replaceAll("-", ""),
    operatorCredential: config.credential,
    spawnAgent: claudeSpawner({
      MOE_DAEMON_CREDENTIAL: config.credential,
      MOE_PROJECT_ID: config.projectId,
      MOE_STORE_PATH: config.storePath,
    }),
  });

  const once = process.env["MOE_WRAPPER_ONCE"] === "1";
  const intervalMs = Number(process.env["MOE_WRAPPER_INTERVAL_MS"] ?? "15000");
  for (;;) {
    const report = wrapper.runOnce();
    for (const entry of report.spawned) {
      process.stdout.write(`[wrapper] ${entry.workItemId}: ${entry.outcome}\n`);
    }
    if (once) { await wrapper.settle(); return; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "wrapper failed"}\n`);
    process.exitCode = 1;
  });
}

export { main as runAgentWrapperMain };
