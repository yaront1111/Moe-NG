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
import { createVerifierAuthorityProvider } from "../review/verifier-authority-provider.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import { claudeSpawnStarter } from "./agent-spawner.js";
import type { AgentSpawnStart, AgentSpawnStarter } from "./agent-spawner.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { NodeMission } from "./agent-wrapper.js";
import { createNodeVerifier } from "./node-verifier.js";
import {
  createVerifierProcessRunner,
  VerifierProcessCancelledError,
} from "./verifier-process-runner.js";
import type { VerifierProcessRunner } from "./verifier-process-runner.js";
import { readWrapperKnobs } from "./wrapper-knobs.js";

/** The signal-0 probe backing the wrapper's durable staffing fence. */
export type ProcessSignalProbe = (pid: number, signal: 0) => void;

/**
 * Is this pid still addressable? `kill(pid, 0)` delivers no signal; it only asks.
 *
 * ESRCH means no such process — the staffing record is stale and the item may be
 * re-staffed. EPERM means the process EXISTS but is owned by someone else, which
 * is ALIVE and must refuse; reading it as "gone" would admit a second agent
 * beside a live child, the exact defect the fence closes. Anything else is
 * propagated so the fence answers LIVENESS_UNKNOWN rather than guessing "dead" —
 * an unknown probe failure is never evidence of death.
 */
export function probeProcessAlive(
  pid: number,
  kill: ProcessSignalProbe = (target, signal) => { process.kill(target, signal); },
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

interface WrapperSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface WrapperStopSignal {
  readonly close: () => void;
  readonly request: () => void;
  readonly requested: () => boolean;
  readonly wait: () => Promise<void>;
}

/** One idempotent stop latch shared by both operator signals and fatal child ownership. */
export function createWrapperStopSignal(
  source: WrapperSignalSource,
  onRequest: () => void,
): WrapperStopSignal {
  let stopping = false;
  let wake!: () => void;
  const stopped = new Promise<void>((resolve) => { wake = resolve; });
  const request = (): void => {
    if (stopping) return;
    stopping = true;
    wake();
    onRequest();
  };
  // Persistent handlers are load-bearing: a second same signal during async
  // teardown must not fall through to Node's default hard-exit behavior.
  source.on("SIGINT", request);
  source.on("SIGTERM", request);
  return Object.freeze({
    close: (): void => {
      source.removeListener("SIGINT", request);
      source.removeListener("SIGTERM", request);
    },
    request,
    requested: (): boolean => stopping,
    wait: (): Promise<void> => stopped,
  });
}

export interface WrapperRuntimeShutdownResources {
  readonly closeAgentSpawner?: (() => Promise<void>) | undefined;
  readonly closeProvider?: (() => void) | undefined;
  readonly closeVerifierRunner?: (() => Promise<void>) | undefined;
  readonly closeVerifierStore?: (() => void) | undefined;
  readonly settleAgents?: (() => Promise<void>) | undefined;
  readonly stopAuthorityHost?: (() => Promise<void>) | undefined;
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error("WRAPPER_RUNTIME_SHUTDOWN_FAILED");

/** Child ownership is attempted first, then network/store authority is revoked
 * on every path. An escaped child must never retain a live bearer endpoint. */
export async function shutdownWrapperRuntime(
  resources: WrapperRuntimeShutdownResources,
): Promise<void> {
  const childStops = [resources.closeVerifierRunner, resources.closeAgentSpawner]
    .filter((stop): stop is () => Promise<void> => stop !== undefined)
    .map(async (stop) => stop());
  const childResults = await Promise.allSettled(childStops);
  const settleResult = resources.settleAgents === undefined
    ? undefined
    : await Promise.resolve().then(resources.settleAgents).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ reason, status: "rejected" as const }),
    );
  const failures = childResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => asError(result.reason));
  if (settleResult?.status === "rejected") failures.push(asError(settleResult.reason));

  if (resources.stopAuthorityHost !== undefined) {
    try {
      await resources.stopAuthorityHost();
    } catch (error) {
      failures.push(asError(error));
    }
  }
  failures.push(...[resources.closeVerifierStore, resources.closeProvider]
    .filter((close): close is () => void => close !== undefined)
    .map((close) => {
      try {
        close();
        return null;
      } catch (error) {
        return asError(error);
      }
    }).filter((error): error is Error => error !== null));

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "WRAPPER_RUNTIME_SHUTDOWN_FAILED");
  }
}

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
  let verifierStore: SqliteEventStore | undefined;
  let verifierRunner: VerifierProcessRunner | undefined;
  let agentSpawner: AgentSpawnStarter | undefined;
  let wrapper: ReturnType<typeof createAgentWrapper> | undefined;
  let mcpHost: ReturnType<typeof createMcpHttpHost> | undefined;
  let stop!: WrapperStopSignal;
  stop = createWrapperStopSignal(process, () => {
    // Signal callbacks cannot await. Starting both idempotent closes here wakes
    // an in-flight verifier immediately; the finally gate below observes them.
    void verifierRunner?.close().catch(() => undefined);
    void agentSpawner?.close().catch(() => undefined);
  });

  try {
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
    if (stop.requested()) return;

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

    // Opened BEFORE the wrapper because the durable staffing fence needs it, and
    // an unfenced wrapper is the defect this binary exists to close: without a
    // fence, `createStaffingGate(undefined).admit` returns null and admits every
    // pass. One handle serves both the fence and the verifier below; the finally
    // gate already owns closing it. The handle is PROJECT-ASSERTED (the same
    // pattern daemon-store-dependencies.ts uses): every durable staffing and
    // verifier write goes through the decision/event ledger transactions, and
    // those refuse PROJECT_SCOPE_REQUIRED on an unasserted handle — which would
    // fail every ONCE pass at its staffing commit.
    verifierStore = SqliteEventStore.openForProject(config.storePath, config.projectId);

    let secureSpawn: AgentSpawnStart | null = null;
    wrapper = createAgentWrapper({
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
      staffingFence: createAgentSessionFence({
        isProcessAlive: probeProcessAlive,
        projectId: config.projectId,
        store: verifierStore,
      }),
    });

    // Daemon-side verification runs with a reduced environment and bounded
    // capture. This is authority reduction, not same-UID/workspace hermeticity.
    verifierRunner = createVerifierProcessRunner({
      onFatalContainment: () => { stop.request(); },
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
      runTest: verifierRunner,
      store: verifierStore,
      // Reads calibration, policy and package facts from the durable store; a
      // fact that is not installed still yields VERIFICATION_AUTHORITY_UNAVAILABLE.
      verificationAuthority: createVerifierAuthorityProvider({
        projectId: config.projectId,
        store: verifierStore,
      }),
    });

    // Agents connect to this trusted parent over loopback. The host retains store/operator
    // authority; the per-agent config contains only its scoped bearer and this origin.
    mcpHost = createMcpHttpHost({
      affordances,
      deps: provider.provide(),
      subscriptions,
    });
    const mcpStarted = await mcpHost.start();
    if (!mcpStarted.ok) throw new Error(mcpStarted.code);
    if (stop.requested()) return;
    // The admission-shaped boundary, not the lifetime-shaped one: `claudeSpawner`
    // resolves only when the agent EXITS, so a refused start was indistinguishable
    // from a running one and the wrapper printed SPAWNED either way.
    agentSpawner = claudeSpawnStarter(mcpStarted.origin, {
      onFatalContainment: () => { stop.request(); },
    });
    secureSpawn = agentSpawner;

    const { intervalMs, once } = knobs;
    let lastIdle = "";
    for (;;) {
      if (stop.requested()) return;
      // Verify BEFORE staffing: a clean submission earns its acceptance (or its
      // failure round) before any new agent is spawned against stale state.
      let verdicts: Awaited<ReturnType<typeof verifier.verifyOnce>>;
      try {
        verdicts = await verifier.verifyOnce();
      } catch (error) {
        if (stop.requested() && error instanceof VerifierProcessCancelledError) return;
        throw error;
      }
      if (stop.requested()) return;
      for (const verdict of verdicts) {
        process.stdout.write(
          `[verifier] ${verdict.nodeRef}: ${verdict.outcome} (${verdict.detail})\n`,
        );
      }
      // Awaits STARTUP ADMISSION only. Every agent's exit stays in flight, so a
      // staffed run never blocks this loop on a child's lifetime.
      const report = await wrapper.runOnce();
      for (const entry of report.spawned) {
        // Name the refusing layer: two layers can refuse a start, and the code
        // alone does not say which one answered.
        const refused = entry.refusal === null ? "" : ` (${entry.refusal.layer})`;
        process.stdout.write(`[wrapper] ${entry.workItemId}: ${entry.outcome}${refused}\n`);
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
        if (stop.requested()) return;
        let finalVerdicts: Awaited<ReturnType<typeof verifier.verifyOnce>>;
        try {
          finalVerdicts = await verifier.verifyOnce();
        } catch (error) {
          if (stop.requested() && error instanceof VerifierProcessCancelledError) return;
          throw error;
        }
        for (const verdict of finalVerdicts) {
          process.stdout.write(`[verifier] ${verdict.nodeRef}: ${verdict.outcome} (${verdict.detail})\n`);
        }
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => { timer = setTimeout(resolve, intervalMs); }),
          stop.wait(),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    try {
      await shutdownWrapperRuntime({
        closeAgentSpawner: agentSpawner?.close,
        closeProvider: provider.close,
        closeVerifierRunner: verifierRunner?.close,
        closeVerifierStore: verifierStore === undefined ? undefined : () => { verifierStore?.close(); },
        settleAgents: wrapper?.settle,
        stopAuthorityHost: mcpHost?.stop,
      });
    } finally {
      stop.close();
    }
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
