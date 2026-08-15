#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "../daemon-store-dependencies.js";
import { claudeSpawner } from "./agent-spawner.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { NodeMission } from "./agent-wrapper.js";
import { createNodeVerifier } from "./node-verifier.js";
import type { VerifierRunCapture } from "./node-verifier.js";
import { readWrapperKnobs } from "./wrapper-knobs.js";

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
async function main(): Promise<void> {
  // Knobs first: a malformed knob is refused by name before any store is opened.
  const knobs = readWrapperKnobs(process.env);
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

  // Full coding briefs come from the same spec dir the affordance surface
  // lists nodes from; a spec without instructions/test/workspace is no brief.
  const nodeMission = (nodeRef: string): NodeMission | null => {
    const dir = config.nodeSpecsDir;
    if (dir === undefined) return null;
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return null;
    }
    for (const name of names) {
      try {
        const spec = JSON.parse(readFileSync(join(dir, name), "utf8")) as
          Partial<NodeMission> & { nodeRef?: string };
        if (spec.nodeRef !== nodeRef) continue;
        if (typeof spec.instructions !== "string" || typeof spec.test !== "string"
          || typeof spec.workspace !== "string") return null;
        return {
          instructions: spec.instructions, test: spec.test,
          title: spec.title ?? nodeRef, workspace: spec.workspace,
        };
      } catch { /* skipped */ }
    }
    return null;
  };

  const wrapper = createAgentWrapper({
    nodeMission,
    payloadHint: (kind, target) =>
      (hintModule?.payloadFor?.(kind, target) ?? null) as never,
    affordances,
    claimTtlMs: 30 * 60 * 1000,
    clock: () => Date.now(),
    deps: provider.provide(),
    maxAgents: knobs.maxAgents,
    mintSecret: () => randomUUID().replaceAll("-", ""),
    operatorCredential: config.credential,
    spawnAgent: claudeSpawner({
      MOE_DAEMON_CREDENTIAL: config.credential,
      MOE_PROJECT_ID: config.projectId,
      MOE_STORE_PATH: config.storePath,
    }),
  });

  // Daemon-side verification: a bounded child process running the spec's test
  // in its workspace, output captured and sha-256'd for the receipt binding.
  const runTest = (brief: NodeMission): Promise<VerifierRunCapture> =>
    new Promise((resolveRun) => {
      const child = spawn(brief.test, [], {
        cwd: brief.workspace, shell: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let total = 0;
      const collect = (chunk: Buffer): void => {
        total += chunk.byteLength;
        if (total <= 262_144) chunks.push(chunk);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      // A hung test must not leave an orphan holding the workspace: with
      // `shell: true` the child IS the shell, and on Windows `kill()` stops
      // only cmd.exe while the grandchild (`node test.mjs`) lives on. taskkill
      // /T takes the tree; elsewhere the signal reaches the process group.
      const killTree = (): void => {
        if (process.platform === "win32" && child.pid !== undefined) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          child.kill();
        }
      };
      const timer = setTimeout(killTree, 120_000);
      const finish = (exitCode: number | null): void => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString("utf8");
        resolveRun({
          exitCode,
          output,
          sha256: createHashSha256(output),
        });
      };
      child.on("exit", (code) => finish(code));
      child.on("error", () => finish(null));
    });

  const verifier = createNodeVerifier({
    deps: provider.provide(),
    mintId: () => randomUUID(),
    nodeMission,
    nodes: () => {
      const dir = config.nodeSpecsDir;
      if (dir === undefined) return [];
      try {
        return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
          const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as
            { nodeRef?: unknown };
          return typeof parsed.nodeRef === "string" ? { nodeRef: parsed.nodeRef } : null;
        }).filter((entry): entry is { nodeRef: string } => entry !== null);
      } catch {
        return [];
      }
    },
    operatorCredential: config.credential,
    projectId: config.projectId,
    runTest,
    store: SqliteEventStore.open(config.storePath),
  });

  const { intervalMs, once } = knobs;
  let lastIdle = "";
  for (;;) {
    // Verify BEFORE staffing: a clean submission earns its acceptance (or its
    // failure round) before any new agent is spawned against stale state.
    for (const verdict of await verifier.verifyOnce()) {
      process.stdout.write(`[verifier] ${verdict.nodeRef}: ${verdict.outcome} (${verdict.detail})\n`);
    }
    const report = wrapper.runOnce();
    for (const entry of report.spawned) {
      process.stdout.write(`[wrapper] ${entry.workItemId}: ${entry.outcome}\n`);
    }
    if (report.spawned.length === 0) {
      // Say so: a silent pass reads as a hung wrapper to an operator watching it.
      // Once per distinct idle state, not once per interval — the continuous
      // loop would otherwise print the same line every few seconds.
      const idle = `[wrapper] nothing to staff (surface ${report.surfaceOutcome}, active ${String(report.active)})\n`;
      if (idle !== lastIdle) process.stdout.write(idle);
      lastIdle = idle;
    } else {
      lastIdle = "";
    }
    if (once) {
      await wrapper.settle();
      for (const verdict of await verifier.verifyOnce()) {
        process.stdout.write(`[verifier] ${verdict.nodeRef}: ${verdict.outcome} (${verdict.detail})\n`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function createHashSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "wrapper failed"}\n`);
    process.exitCode = 1;
  });
}

export { main as runAgentWrapperMain };
