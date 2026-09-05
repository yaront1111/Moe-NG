#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { SqliteEventStore } from "@moe/store";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "../daemon-store-dependencies.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createCompilerLanePort } from "../http/affordance-compiler-lane.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { refsOfGoal } from "../goals/goal-identity.js";
import { composeCompilerInstructions, latestRejectionReason } from "../planning/rejection-instructions.js";
import { createMcpHttpHost } from "../mcp-http/mcp-http-host.js";
import { createProductContractReadPort } from "../product-contract/product-contract-read-port.js";
import {
  createVerifierAuthorityProvider, readVerifierStandingAuthority,
} from "../review/verifier-authority-provider.js";
import { createProviderPauseGate } from "./agent-provider-pause.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import { claudeSpawnStarter } from "./agent-spawner.js";
import type { AgentSpawnStart, AgentSpawnStarter } from "./agent-spawner.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import { runReclaimPass } from "./agent-wrapper-reclaim.js";
import { createCompiledNodeSource } from "./compiled-node-source.js";
import { createRepositoryDeliveryRuntime } from "./repository-delivery-runtime.js";
import { createWrapperNodeMissions } from "./wrapper-node-missions.js";
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
import { providerFor } from "./moe-up-credentials.js";
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
import { enrollDecisionLedgerMemo } from "../decision-ledger-memo.js";

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
    // (fail closed); compiled execution refs belong exclusively to the graph source.
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

    const { nodeMission, listNodes } = createWrapperNodeMissions({
      compiled: compiledSource, nodeSpecsDir: config.nodeSpecsDir,
      log: (line) => { process.stderr.write(`${line}\n`); },
    });

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
    enrollDecisionLedgerMemo(verifierStore);

    // Disabling landing also disables new coding admission: ownership cannot be
    // safely released on acceptance alone.
    const landingOn = !["0", "off", "false"].includes(
      (process.env["MOE_NODE_LANDING"] ?? "").toLowerCase(),
    );
    const staffingFence = createAgentSessionFence({
      isProcessAlive: probeProcessAlive, projectId: config.projectId, store: verifierStore,
    });
    verifierRunner = createVerifierProcessRunner({ onFatalContainment: () => { stop.request(); } });
    const delivery = createRepositoryDeliveryRuntime({
      compiledWorkspace, fence: staffingFence, landingOn,
      log: (line) => { process.stdout.write(`${line}\n`); },
      nodes: listNodes, storePath: config.storePath,
      verifier: {
        deps: provider.provide(), mintId: () => randomUUID(), nodeMission,
        operatorCredential: config.credential, projectId: config.projectId,
        runTest: verifierRunner, store: verifierStore,
        verificationAuthority: createVerifierAuthorityProvider({ projectId: config.projectId, store: verifierStore }),
      },
    });

    let secureSpawn: AgentSpawnStart | null = null;
    wrapper = createAgentWrapper({
      nodeMission,
      // Named in every brief: the MCP port does not know the project, and a seat has no
      // read that answers it, so graph_get was uncallable without this (2026-09-05).
      projectId: config.projectId,
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
      // The goal's operator instructions: its durable catalog brief, plus - for a RE-STAFFED seat
      // - why the operator rejected the last plan. That composition is pure and lives in
      // ../planning/rejection-instructions.ts, which is what keeps this file to one call.
      compilerInstructions: (goalId) => {
        const laneStore = verifierStore;
        if (goalId === null || laneStore === undefined) return null;
        const event: unknown = laneStore.readAggregateEvents(goalId, 0, 1).items[0];
        if (event === undefined) return null;
        const decoded = decodeGoalCatalogEntry(
          event as Parameters<typeof decodeGoalCatalogEntry>[0], config.projectId,
        );
        const brief = decoded.ok && decoded.entry.goalId === goalId
          ? decoded.entry.brief?.instructions ?? null : null;
        return composeCompilerInstructions(brief, latestRejectionReason(
          laneStore, config.projectId, refsOfGoal(goalId).planningRunRef,
        ));
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
      spawnAgent: delivery.start(async (request) => {
        if (secureSpawn === null) throw new Error("MCP_HTTP_HOST_NOT_STARTED");
        return secureSpawn(request);
      }),
      // The seat command resolves exactly as the spawner resolves it
      // (agent-spawner.ts: `options.command ?? process.env["MOE_AGENT_COMMAND"] ?? "claude"`).
      // An unknown command reads as "claude": a scripted seat double printing the claude
      // limit line must park the provider it is imitating.
      providerPause: createProviderPauseGate({
        clock: () => Date.now(),
        log: (line) => { process.stdout.write(`${line}\n`); },
        projectId: config.projectId,
        provider: providerFor(process.env["MOE_AGENT_COMMAND"] ?? "claude")?.leaf ?? "claude",
        store: verifierStore,
      }),
      staffingFence,
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
      // The seats' only MCP host is THIS one: without the graph reader every graph_get a
      // seat made refused INPUT_INVALID, whatever the brief told it to send (2026-09-05).
      graph: provider.graph?.(),
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

    // Boot reclaim, ONCE before the first staffing pass: a restart otherwise leaves
    // its own dead children's claims fenced for the full 30-minute claim expiry.
    const reclaimed = runReclaimPass({
      clock: () => Date.now(), deps: provider.provide(), isProcessAlive: probeProcessAlive,
      log: (line: string) => { process.stdout.write(`${line}\n`); },
      mintSecret: () => randomUUID().replaceAll("-", ""), operatorCredential: config.credential,
      projectId: config.projectId, store: verifierStore,
    });
    const kept = reclaimed.filter((done) => done.outcome !== "RECLAIMED").length;
    process.stdout.write(`[wrapper] reclaim pass: ${String(reclaimed.length - kept)} `
      + `reclaimed, ${String(kept)} kept\n`);
    if (stop.requested()) return;

    const { intervalMs, once } = knobs;
    let lastIdle = "";
    for (;;) {
      if (stop.requested()) return;
      // Repository ownership gates every effect, including submissions made by
      // children that are still alive and wrappers sharing another project store.
      try {
        await delivery.advance();
      } catch (error) {
        if (stop.requested() && error instanceof VerifierProcessCancelledError) return;
        throw error;
      }
      if (stop.requested()) return;
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
        // A parked fleet is not an idle one: say which provider and until when.
        const idle = report.paused === undefined
          ? `[wrapper] nothing to staff (surface ${report.surfaceOutcome}, active ${String(report.active)})\n`
          : `[wrapper] provider paused: ${report.paused.provider} until ${report.paused.resetAt}`
            + ` (active ${String(report.active)})\n`;
        if (idle !== lastIdle) process.stdout.write(idle);
        lastIdle = idle;
      } else {
        lastIdle = "";
      }
      if (once) {
        await wrapper.settle();
        if (stop.requested()) return;
        try {
          await delivery.advance();
        } catch (error) {
          if (stop.requested() && error instanceof VerifierProcessCancelledError) return;
          throw error;
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
