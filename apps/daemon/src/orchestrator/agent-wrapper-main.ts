#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "../daemon-store-dependencies.js";
import { createMcpHttpHost } from "../mcp-http/mcp-http-host.js";
import { claudeSpawner } from "./agent-spawner.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { NodeMission, SpawnRequest } from "./agent-wrapper.js";
import { createNodeVerifier } from "./node-verifier.js";
import { createVerifierProcessRunner } from "./verifier-process-runner.js";
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
 * a single pass. The trusted wrapper hosts MCP on loopback; each agent receives
 * only its scoped bearer, never the operator credential or store path.
 */
async function main(): Promise<void> {
  // Knobs first: a malformed knob is refused by name before any store is opened.
  const knobs = readWrapperKnobs(process.env);
  const config = readStoreDependencyEnv(process.env);
  const provider = createStoreDependencies(config);
  const affordances = provider.affordances?.();
  if (affordances === undefined) throw new Error("provider serves no affordance surface");
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription surface");

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

  let secureSpawn: ((request: SpawnRequest) => Promise<void>) | null = null;
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
    spawnAgent: (request) => secureSpawn === null
      ? Promise.reject(new Error("MCP_HTTP_HOST_NOT_STARTED"))
      : secureSpawn(request),
  });

  // Daemon-side verification runs with a reduced environment and bounded
  // capture. This is authority reduction, not same-UID/workspace hermeticity.
  const runTest = createVerifierProcessRunner();

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

  // Agents connect to this trusted parent over loopback. The host retains store/operator
  // authority; the per-agent config contains only its scoped bearer and this origin.
  const mcpHost = createMcpHttpHost({
    affordances,
    deps: provider.provide(),
    subscriptions,
  });
  const mcpStarted = await mcpHost.start();
  if (!mcpStarted.ok) throw new Error(mcpStarted.code);
  secureSpawn = claudeSpawner(mcpStarted.origin);

  const { intervalMs, once } = knobs;
  let lastIdle = "";
  try {
    for (;;) {
      // Verify BEFORE staffing: a clean submission earns its acceptance (or its
      // failure round) before any new agent is spawned against stale state.
      for (const verdict of await verifier.verifyOnce()) {
        process.stdout.write(
          `[verifier] ${verdict.nodeRef}: ${verdict.outcome} (${verdict.detail})\n`,
        );
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
  } finally {
    await mcpHost.stop();
    provider.close();
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
