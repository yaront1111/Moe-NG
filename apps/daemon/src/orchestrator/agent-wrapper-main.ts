#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "../daemon-store-dependencies.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createCompilerLanePort } from "../http/affordance-compiler-lane.js";
import { NODE_DELIVER_KIND } from "../http/affordance-contract.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { createMcpHttpHost } from "../mcp-http/mcp-http-host.js";
import { createGitLandingPort } from "../repository/git-landing-port.js";
import { createProductContractReadPort } from "../product-contract/product-contract-read-port.js";
import {
  createVerifierAuthorityProvider, readVerifierStandingAuthority,
} from "../review/verifier-authority-provider.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import { claudeSpawnStarter } from "./agent-spawner.js";
import type { AgentSpawnStart, AgentSpawnStarter } from "./agent-spawner.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { NodeMission } from "./agent-wrapper.js";
import { createCompiledNodeSource } from "./compiled-node-source.js";
import { createNodeLander } from "./node-lander.js";
import { createNodeVerifier } from "./node-verifier.js";
import {
  createWrapperStopSignal,
  probeProcessAlive,
  shutdownWrapperRuntime,
} from "./process-runner-lifecycle.js";
import type { WrapperStopSignal } from "./process-runner-lifecycle.js";
import {
  createVerifierProcessRunner,
  VerifierProcessCancelledError,
} from "./verifier-process-runner.js";
import type { VerifierProcessRunner } from "./verifier-process-runner.js";
import { readWrapperKnobs } from "./wrapper-knobs.js";

export {
  createWrapperStopSignal,
  probeProcessAlive,
  shutdownWrapperRuntime,
} from "./process-runner-lifecycle.js";
export type {
  ProcessSignalProbe,
  WrapperRuntimeShutdownResources,
  WrapperStopSignal,
} from "./process-runner-lifecycle.js";

/**
 * The process wrapper: `node src/orchestrator/agent-wrapper-main.ts` staffs the
 * board the way old Moe's daemon staffed its task list — every unclaimed READY
 * step gets a scoped agent session and a spawned `claude` process wired to the
 * moe-next MCP server, mission-prompted with exactly the item it claimed.
 *
 * Environment: the store trio + MOE_DAEMON_CREDENTIAL (operator), and
 * optionally MOE_AGENT_COMMAND (default "claude"), MOE_WRAPPER_MAX_AGENTS
 * (default 2), MOE_WRAPPER_INTERVAL_MS (default 15000), MOE_WRAPPER_ONCE=1 for
 * a single pass, MOE_WRAPPER_MAX_ITEM_ATTEMPTS (default 3) staffing tries per
 * unmoved item before it is reported STAFFING_ATTEMPTS_EXHAUSTED instead of
 * respawned, and MOE_AGENT_TIMEOUT_MS (default 30 min) the hard lifetime of
 * one agent process, from which the agent's bearer TTL is derived. The trusted
 * wrapper hosts MCP on loopback; each agent receives only its scoped bearer,
 * never the operator credential or store path.
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
    // leniently: a missing module just means missions carry no hint. The failure
    // is DISCLOSED, never swallowed — a silent null here cost a live run
    // 2026-08-20: live-dispatch.ts grew a `.js`-suffixed import with no bridge
    // file, every mission shipped hintless, and agents guessed payload shapes at
    // steps whose exact input the hint already knew.
    const hintModule = await import(
      new URL("../../../control-room/src/live/live-dispatch.ts", import.meta.url).href
    ).catch((error: unknown) => {
      console.error(`[wrapper] payload hints unavailable: ${String(error)}`);
      return null;
    }) as
      { payloadFor?: (kind: string, target: string | null) => object | null } | null;
    if (stop.requested()) return;

    // COMPILED nodes (sealed by an approved compiled plan) are briefed from the
    // durable graph plus two HOST facts the operator sets: MOE_NODE_WORKSPACE
    // (where the code is built) and MOE_NODE_TEST_COMMAND (how it is verified,
    // default "pnpm test"). Absent workspace = compiled nodes stay unstaffed
    // (fail closed); spec-dir briefs below always win on a nodeRef collision.
    const compiledWorkspace = (process.env["MOE_NODE_WORKSPACE"] ?? "") === ""
      ? null
      : process.env["MOE_NODE_WORKSPACE"] as string;
    const compiledTestCommand = (process.env["MOE_NODE_TEST_COMMAND"] ?? "") === ""
      ? "pnpm test"
      : process.env["MOE_NODE_TEST_COMMAND"] as string;
    const compiledSource = (): ReturnType<typeof createCompiledNodeSource> | null => {
      const laneStore = verifierStore;
      if (laneStore === undefined) return null;
      return createCompiledNodeSource({
        projectId: config.projectId,
        store: laneStore,
        testCommand: compiledTestCommand,
        workspace: compiledWorkspace,
      });
    };

    // Full coding briefs come from the same spec dir the affordance surface
    // lists nodes from; a spec without instructions/test/workspace is no brief.
    // A nodeRef with no spec falls through to the compiled-graph brief above.
    const nodeMission = (nodeRef: string): NodeMission | null =>
      specMission(nodeRef) ?? compiledSource()?.mission(nodeRef) ?? null;
    const specMission = (nodeRef: string): NodeMission | null => {
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

    // Every node the verifier and the lander look at: spec-dir nodes, plus the
    // compiled nodes of every active graph (a compiled delivery would otherwise
    // sit awaiting a verifier that never looks).
    const listNodes = (): readonly { nodeRef: string }[] => {
      const specs: { nodeRef: string }[] = [];
      const dir = config.nodeSpecsDir;
      if (dir !== undefined) {
        try {
          specs.push(...readdirSync(dir).filter((name) => name.endsWith(".json"))
            .map((name) => {
              const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as
                { nodeRef?: unknown };
              return typeof parsed.nodeRef === "string" ? { nodeRef: parsed.nodeRef } : null;
            }).filter((entry): entry is { nodeRef: string } => entry !== null));
        } catch { /* an unreadable dir contributes nothing */ }
      }
      const listed = new Set(specs.map((spec) => spec.nodeRef));
      for (const node of compiledSource()?.nodes() ?? []) {
        if (!listed.has(node.nodeRef)) specs.push({ nodeRef: node.nodeRef });
      }
      return specs;
    };

    // GIT LANDING: an accepted node's files become one local commit on the
    // workspace's current branch (never pushed). MOE_NODE_LANDING=0 turns it off.
    const landingOn = !["0", "off", "false"].includes(
      (process.env["MOE_NODE_LANDING"] ?? "").toLowerCase(),
    );
    const lander = createNodeLander({
      git: createGitLandingPort(),
      nodeMission,
      nodes: listNodes,
      projectId: config.projectId,
      store: verifierStore,
    });
    const NODE_DELIVER_PREFIX = `${NODE_DELIVER_KIND}@`;

    let secureSpawn: AgentSpawnStart | null = null;
    wrapper = createAgentWrapper({
      nodeMission,
      payloadHint: (kind, target) =>
        (hintModule?.payloadFor?.(kind, target) ?? null) as never,
      // The dispatcher mission's Gate 1 triple, resolved fresh per staffing from
      // the same durable state the offer ladder read. Convenience, not
      // authority: the compile dispatcher re-verifies every submit.
      compilerGateRef: (goalId) => {
        const laneStore = verifierStore;
        if (goalId === null || laneStore === undefined) return null;
        const facts = createCompilerLanePort({
          ledger: readDurableLedger(laneStore, config.projectId),
          projectId: config.projectId,
          store: laneStore,
        }).factsFor(goalId);
        return facts.lane === "COMPILER" && facts.approvedGateRef !== null
          ? { ...facts.approvedGateRef }
          : null;
      },
      affordances,
      // The goal's operator instructions, read from its durable catalog entry: a replan's
      // successor goal carries the exhausted attempt's findings there.
      compilerInstructions: (goalId) => {
        const laneStore = verifierStore;
        if (goalId === null || laneStore === undefined) return null;
        const event: unknown = laneStore.readAggregateEvents(goalId, 0, 1).items[0];
        if (event === undefined) return null;
        const decoded = decodeGoalCatalogEntry(
          event as Parameters<typeof decodeGoalCatalogEntry>[0], config.projectId,
        );
        return decoded.ok && decoded.entry.goalId === goalId
          ? decoded.entry.brief?.instructions ?? null : null;
      },
      // Both horizons come from the knobs, where the bearer TTL is derived from
      // the agent lifetime: a session bound to the claim TTL expired under a
      // long task that was still renewing its claim, and the exit-path release
      // under the dead secret wedged the wrapper on AGENT_CLEANUP_FAILED.
      claimTtlMs: knobs.claimTtlMs,
      clock: () => Date.now(),
      deps: provider.provide(),
      maxAgents: knobs.maxAgents,
      maxItemAttempts: knobs.maxItemAttempts,
      mintSecret: () => randomUUID().replaceAll("-", ""),
      operatorCredential: config.credential,
      sessionTtlMs: knobs.sessionTtlMs,
      spawnAgent: async (request) => {
        if (secureSpawn === null) throw new Error("MCP_HTTP_HOST_NOT_STARTED");
        // The baseline is taken BEFORE the seat exists: whatever is dirty now
        // is the operator's, and stays out of the landing.
        if (landingOn && request.workspace !== null
          && request.workItemId.startsWith(NODE_DELIVER_PREFIX)) {
          const baseline = await lander.baseline(request.workItemId.slice(NODE_DELIVER_PREFIX.length));
          process.stdout.write(`[lander] ${baseline.nodeRef}: ${baseline.outcome} (${baseline.detail})\n`);
        }
        return secureSpawn(request);
      },
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
      nodes: listNodes,
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

    // Say at startup what the verifier would otherwise only say per node, after a delivery:
    // without both standing slices every delivered node waits on verification forever.
    const standing = readVerifierStandingAuthority(verifierStore, config.projectId);
    if (!standing.policy || !standing.calibration) {
      const absent = [
        ...(standing.policy ? [] : ["moe-verifier-policy/1"]),
        ...(standing.calibration ? [] : ["moe-reviewer-calibration/1"]),
      ].join(", ");
      process.stdout.write(
        `[verifier] standing authority incomplete: ${absent} not installed for project `
        + `${config.projectId}; delivered nodes wait on verification until policy.install `
        + "lands them (docs/agent-stack-runbook.md, Verifier authority)\n",
      );
    }

    // Agents connect to this trusted parent over loopback. The host retains store/operator
    // authority; the per-agent config contains only its scoped bearer and this origin.
    mcpHost = createMcpHttpHost({
      affordances,
      // The planning seat's contract read: the approved revision's criteria, by id.
      contract: createProductContractReadPort({ projectId: config.projectId, store: verifierStore }),
      deps: provider.provide(),
      documents: provider.goalSource?.(),
      subscriptions,
    });
    const mcpStarted = await mcpHost.start();
    if (!mcpStarted.ok) throw new Error(mcpStarted.code);
    if (stop.requested()) return;
    // The admission-shaped boundary, not the lifetime-shaped one: `claudeSpawner`
    // resolves only when the agent EXITS, so a refused start was indistinguishable
    // from a running one and the wrapper printed SPAWNED either way.
    // The lifetime the bearer TTL above was derived from, handed over rather
    // than re-read from the environment, so the two cannot drift apart.
    agentSpawner = claudeSpawnStarter(mcpStarted.origin, {
      onFatalContainment: () => { stop.request(); },
      timeoutMs: knobs.agentTimeoutMs,
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
      // Land AFTER verifying: an acceptance earned this pass is committed this pass.
      if (landingOn) {
        for (const landed of await lander.landOnce()) {
          process.stdout.write(`[lander] ${landed.nodeRef}: ${landed.outcome} (${landed.detail})\n`);
        }
      }
      if (stop.requested()) return;
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
        if (landingOn) {
          for (const landed of await lander.landOnce()) {
            process.stdout.write(`[lander] ${landed.nodeRef}: ${landed.outcome} (${landed.detail})\n`);
          }
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
