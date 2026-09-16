#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { SqliteEventStore } from "@moe/store";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "../daemon-store-dependencies.js";
import { createPlaneFollowingDeps } from "../http/command-plane-deps.js";
import { createMcpHttpHost } from "../mcp-http/mcp-http-host.js";
import { createProductContractReadPort } from "../product-contract/product-contract-read-port.js";
import {
  createVerifierAuthorityProvider, readVerifierStandingAuthority,
} from "../review/verifier-authority-provider.js";
import { launchDelivery } from "../environment/environment-launch-resolver.js";
import { createProviderPauseGate } from "./agent-provider-pause.js";
import { agentProviderFact } from "./agent-provider-resolve.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import { claudeSpawnStarter } from "./agent-spawner.js";
import type { AgentSpawnStart, AgentSpawnStarter } from "./agent-spawner.js";
import { staffingSurfaceOf } from "./agent-staffing-surface.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import { runReclaimPass } from "./agent-wrapper-reclaim.js";
import { credentialValues } from "./credential-scrub.js";
import { createRepositoryDeliveryRuntime } from "./repository-delivery-runtime.js";
import { createReviewAwareNodeMissions } from "./wrapper-review-missions.js";
import { loadPayloadHints } from "./wrapper-payload-hints.js";
import { createCompilerMissionInputs, createDesignBriefResolver }
  from "./wrapper-mission-inputs.js";
import {
  createWrapperStopSignal,
  probeProcessAlive,
  shutdownWrapperRuntime,
} from "./process-runner-lifecycle.js";
import type { WrapperStopSignal } from "./process-runner-lifecycle.js";
import { VerifierProcessCancelledError } from "./verifier-process-runner.js";
import { createVerifierDatabaseRunner } from "./verifier-database.js";
import type { VerifierProcessRunner } from "./verifier-process-runner.js";
import { providerFor } from "./moe-up-credentials.js";
import { createSeatStartRecorder } from "./seat-start-recorder.js";
import { readWrapperKnobs } from "./wrapper-knobs.js";
import { createPassLogger } from "./wrapper-pass-log.js";

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
import { resolveRuntimeBrokerPid } from "./runtime-broker-identity.js";

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
  let delivery: ReturnType<typeof createRepositoryDeliveryRuntime> | undefined;
  let agentSpawner: AgentSpawnStarter | undefined;
  let wrapper: ReturnType<typeof createAgentWrapper> | undefined;
  let mcpHost: ReturnType<typeof createMcpHttpHost> | undefined;
  let stop!: WrapperStopSignal;
  stop = createWrapperStopSignal(process, () => {
    // Signal callbacks cannot await. Starting both idempotent closes here wakes
    // an in-flight verifier immediately; the finally gate below observes them.
    void verifierRunner?.close().catch(() => undefined);
    void delivery?.close().catch(() => undefined);
    void agentSpawner?.close().catch(() => undefined);
  });

  try {
    const affordances = provider.affordances?.();
    if (affordances === undefined) throw new Error("provider serves no affordance surface");
    const subscriptions = provider.subscriptions?.();
    if (subscriptions === undefined) throw new Error("provider serves no subscription surface");
    // THE WRAPPER'S DEPS FOLLOW THE CUTOVER PLANE. A /1 deps value captured at start is the
    // /1 plane for the life of the process: once `cutover.activate` binds current
    // readiness, every session.open this binary dispatches, every exit-path release, the boot
    // reclaim and the verifier answer V1_AUTHORITY_RETIRED, and each READY item is charged an
    // attempt per pass until STAFFING_ATTEMPTS_EXHAUSTED (measured over the shipped
    // composition, agent-wrapper-command-plane.test.ts). Both planes are required by name.
    const commandAuthorityPlane = provider.commandAuthorityPlane?.();
    if (commandAuthorityPlane === undefined) throw new Error("provider serves no command plane reader");
    const v2Deps = provider.provideV2?.();
    if (v2Deps === undefined) throw new Error("provider serves no /2 command plane");
    const v1Deps = provider.provide();
    const deps = createPlaneFollowingDeps({ commandAuthorityPlane, deps: v1Deps, v2Deps });

    // DEVELOPMENT payload suggestions from the control room's dev table, loaded leniently by
    // ./wrapper-payload-hints.ts: ABSENT (the installed artifact stages no control-room source)
    // and UNAVAILABLE (present, does not load) are each disclosed by name on stderr, never
    // swallowed, and missions then carry no hint. The module's header says why both matter.
    const hintModule = await loadPayloadHints({
      log: (line) => { console.error(line); },
      moduleUrl: new URL("../../../control-room/src/live/live-dispatch-payloads.ts", import.meta.url),
    });
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
    const { nodeMission, listNodes, reviewContinuation } = createReviewAwareNodeMissions({
      projectId: config.projectId, operatorPrincipalId: config.principalId, store: () => verifierStore,
      workspace: compiledWorkspace, testCommand: compiledTestCommand, nodeSpecsDir: config.nodeSpecsDir,
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
    const seatStart = createSeatStartRecorder({
      log: (line) => { process.stdout.write(`${line}\n`); },
      projectId: config.projectId, store: verifierStore,
    });
    const verifierDelivered = launchDelivery({
      credential: () => config.credential, now: () => new Date().toISOString(),
      projectId: config.projectId, store: verifierStore }, "VERIFIER");
    // THE ONLY DELIVERING BOUNDARY IN THIS PROCESS. The recipe under test needs the project's own
    // variables; `claudeSpawnStarter` below launches CODING seats and must NOT get them, so it
    // keeps calling `agentEnvironment(...)` with ONE argument (agent-spawner.ts:156 and :159).
    // The resolver takes a purpose and no environment name, so a verifier run cannot reach
    // `production`, and CODING_SEAT resolves to a delivery whose value type is `never`. An
    // `undefined` here (no credential, or no `verify` variables) spawns byte-identically to
    // before. Collisions stay environment-delivery.ts's call: the allowlisted runtime wins.
    verifierRunner = createVerifierDatabaseRunner({
      ...(verifierDelivered === undefined ? {} : { delivered: verifierDelivered }),
      onFatalContainment: () => { stop.request(); },
    });
    delivery = createRepositoryDeliveryRuntime({
      publisher: provider.releasePublisher(), runtimeBrokerPid: await resolveRuntimeBrokerPid(process.ppid),
      compiledWorkspace, fence: staffingFence, landingOn,
      log: (line) => { process.stdout.write(`${line}\n`); },
      nodes: listNodes, storePath: config.storePath,
      verifier: {
        deps, mintId: () => randomUUID(), nodeMission,
        operatorCredential: config.credential, projectId: config.projectId,
        runTest: verifierRunner, store: verifierStore,
        verificationAuthority: createVerifierAuthorityProvider({ projectId: config.projectId, store: verifierStore }),
      },
    });

    // The mission inputs that read durable state, all three from one scope. They live in
    // ./wrapper-mission-inputs.ts because this file stood at exactly the 400-line split
    // threshold: the design edge below could not be wired until the first two moved out.
    const missionInputs = createCompilerMissionInputs({
      projectId: config.projectId, store: verifierStore,
    });

    let secureSpawn: AgentSpawnStart | null = null;
    wrapper = createAgentWrapper({
      nodeMission,
      reviewContinuation,
      // Named in every brief: the MCP port does not know the project, and a seat has no
      // read that answers it, so graph_get was uncallable without this (2026-09-05).
      projectId: config.projectId,
      payloadHint: (kind, target) =>
        (hintModule?.payloadFor?.(kind, target) ?? null) as never,
      compilerGateRef: missionInputs.compilerGateRef,
      // THE WRAPPER'S READ, NOT THE BOARD'S. Over the raw port this binary spawned claude seats
      // on the activation chain (project.register, policy.install, ...) before the browser had
      // activated the project, and on plan.propose@run-live-1, a run no real goal owns; each was
      // refused inside claude (measured 2026-09-13). The MCP host below keeps the raw port.
      affordances: staffingSurfaceOf(affordances),
      compilerInstructions: missionInputs.compilerInstructions,
      // THE GOAL'S DESIGN, threaded for real. Declared and consumed since the design row landed
      // but never SUPPLIED, so every live compiler seat evaluated `undefined ?? null` and read
      // "NO DESIGN ACCOMPANIES THIS BRIEF" even where a design was submitted. A compiler seat
      // reads the LATEST design; a node seat reads the version its plan was compiled against.
      designBrief: createDesignBriefResolver({
        projectId: config.projectId, store: verifierStore,
      }),
      // Both horizons come from the knobs, where the bearer TTL is derived from
      // the agent lifetime: a session bound to the claim TTL expired under a
      // long task that was still renewing its claim, and the exit-path release
      // under the dead secret wedged the wrapper on AGENT_CLEANUP_FAILED.
      claimTtlMs: knobs.claimTtlMs,
      clock: () => Date.now(),
      deps,
      maxAgents: knobs.maxAgents,
      maxItemAttempts: knobs.maxItemAttempts,
      mintSecret: () => randomUUID().replaceAll("-", ""),
      operatorCredential: config.credential,
      sessionTtlMs: knobs.sessionTtlMs,
      // THE SEAT-START RECORD IS WRITTEN HERE, AFTER ADMISSION AND NOWHERE ELSE. A wrapper that
      // dies between deciding to staff and getting a child must not leave a note claiming a seat
      // ran; `started.ok` is the first instant a child exists. Fire-and-forget on purpose: the
      // write never rejects, and a spawn must not wait on a ledger commit to return.
      repositoryAdmission: delivery.admission,
      spawnAgent: delivery.start(async (request) => {
        if (secureSpawn === null) throw new Error("MCP_HTTP_HOST_NOT_STARTED");
        const started = await secureSpawn(request);
        if (started.ok) void seatStart.record(request);
        return started;
      }),
      // Durable per-scope setting, read per staffed seat: NO provider is frozen at process
      // start. `provider` below is only a fallback for a caller that resolved none.
      agentProvider: agentProviderFact(verifierStore, config.projectId),
      providerPause: createProviderPauseGate({
        clock: () => Date.now(),
        log: (line) => { process.stdout.write(`${line}\n`); },
        projectId: config.projectId,
        provider: providerFor(process.env["MOE_AGENT_COMMAND"] ?? "claude")?.leaf ?? "claude",
        secrets: () => credentialValues(process.env),
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
      // Both planes and the reader, as mcp-http-main.ts passes them: the port resolves the plane
      // per dispatch, so a seat that outlives cutover.activate is not refused on every call.
      commandAuthorityPlane,
      // The planning seat's contract read: the approved revision's criteria, by id.
      contract: createProductContractReadPort({ projectId: config.projectId, store: verifierStore }),
      deps: v1Deps,
      // The seat's design read, on the same reasoning as the contract read one line up: this is
      // the seats' only MCP host, so without the port every `design.read` a seat makes would
      // refuse INPUT_INVALID however correct its payload. The port binds NO projectId -- the
      // handler feeds it from the authenticated principal, so a cross-project read refuses
      // instead of agreeing with itself (`daemon-store-foundation-composition.ts:355`).
      design: provider.designReads?.(),
      documents: provider.goalSource?.(),
      // The seats' only MCP host is THIS one: without the graph reader every graph_get a
      // seat made refused INPUT_INVALID, whatever the brief told it to send (2026-09-05).
      graph: provider.graph?.(),
      subscriptions,
      v2Deps,
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
      clock: () => Date.now(), deps, isProcessAlive: probeProcessAlive,
      log: (line: string) => { process.stdout.write(`${line}\n`); },
      mintSecret: () => randomUUID().replaceAll("-", ""), operatorCredential: config.credential,
      projectId: config.projectId, store: verifierStore,
    });
    const kept = reclaimed.filter((done) => done.outcome !== "RECLAIMED").length;
    process.stdout.write(`[wrapper] reclaim pass: ${String(reclaimed.length - kept)} `
      + `reclaimed, ${String(kept)} kept\n`);
    if (stop.requested()) return;

    const { intervalMs, once } = knobs;
    // The per-pass lines live in ./wrapper-pass-log.ts: this file stood at the 400-line split
    // rail, and the command-plane wiring above could not land until the loop's log moved out.
    const logPass = createPassLogger((line) => { process.stdout.write(line); });
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
      const report = await wrapper.runOnce().catch((error: unknown): null => {
        // ONE failed pass is not the fleet. A DurableStoreError STORE_BUSY under a concurrent
        // daemon commit rejected the pass here and, uncaught, reached main().catch, whose finally
        // tree-killed every live seat and exited 1 (measured 2026-09-13). The wrapper contains
        // its reads by code now; this is the last line. A single pass still fails loudly.
        if (once) throw error;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[wrapper] pass failed: ${message}
`);
        return null;
      });
      if (report !== null) logPass(report);
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
        closeRepositoryDelivery: delivery?.close,
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
