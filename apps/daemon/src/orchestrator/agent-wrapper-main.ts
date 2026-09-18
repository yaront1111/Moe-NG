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
import {
  resolveVerifierDatabaseProvisioning, verifierDatabaseProvisioningFromEnvironment,
} from "./verifier-database-provisioning.js";
import type { VerifierProcessRunner } from "./verifier-process-runner.js";
import { providerFor } from "./moe-up-credentials.js";
import { createSeatStartRecorder } from "./seat-start-recorder.js";
import { readWrapperKnobs } from "./wrapper-knobs.js";
import { readGovernancePolicySettings } from "../review/governance-policy-settings.js";
import { createGovernorSeat, createProviderGovernorRunner } from "./governor-seat.js";
import { createGovernancePass } from "./wrapper-governance-pass.js";
import { createPassLogger } from "./wrapper-pass-log.js";
import { createDiagnosticRuntime } from "../diagnostics/diagnostic-runtime.js";
import { diagnosticProjectRoot } from "../diagnostics/diagnostic-project-root.js";
import { teeDiagnosticLine } from "../diagnostics/diagnostic-line-tee.js";
import { mcpDispatchFaultReporter, mcpSessionFaultReporter } from "../mcp-dispatch-fault-report.js";

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
 *
 * MOE_GOVERNANCE_MODE=AI_GOVERNOR with MOE_GOVERNANCE_MAX_DECISIONS=<n> lets the daemon answer
 * an exhausted review itself instead of parking the node on a human. BOTH are required: the
 * policy cannot be constructed without its decision bound, and an absent or malformed setting
 * leaves the seat closed, which is the shipped default. See review/governance-policy-settings.ts.
 */
async function main(): Promise<void> {
  // Knobs first: a malformed knob is refused by name before any store is opened.
  const knobs = readWrapperKnobs(process.env);
  // Read beside the knobs and for the same reason: a malformed governance setting is refused by
  // name before any store is opened. An absent or malformed one is a CLOSED seat, so a daemon
  // that states nothing keeps today's behaviour exactly.
  const governance = readGovernancePolicySettings(process.env);
  const config = readStoreDependencyEnv(process.env);
  // THE DIAGNOSTIC PLANE, built beside the knobs and for the same reason: a malformed MOE_LOG_*
  // is refused by name before any store is opened. Everything below still writes to the console
  // exactly as it did; the plane adds a durable copy under the project's own .moe/logs, so an
  // account of what a seat did survives a scrolled terminal and a supervisor that discards
  // stdout. Every credential this environment holds is scrubbed from both planes.
  const diagnostics = createDiagnosticRuntime({
    env: process.env,
    projectRoot: diagnosticProjectRoot(config.storePath, process.cwd()),
    secrets: credentialValues(process.env),
  });
  const seatDiagnostics = diagnostics.emitterFor("seat");
  const passDiagnostics = diagnostics.emitterFor("wrapper");
  const mcpDiagnostics = diagnostics.emitterFor("mcp");
  // The command ports this wrapper's host dispatches through report a store fault on this plane.
  const provider = createStoreDependencies({ ...config, diagnostics: diagnostics.emitterFor("command") });
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
      workspace: compiledWorkspace, testCommand: compiledTestCommand, nodeSpecsDir: config.nodeSpecsDir, nodeTrees: knobs.nodeTrees,
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

    // THE GOVERNOR SEAT. One-shot, in the project's own workspace, so it can consult the product
    // record the questions name — the PRD, the ADRs, the approved contract — and cite it rather
    // than decide. It is the same agent command the project staffs its seats with, and it holds
    // nothing: no claim, no session credential, no repository hold, and no command it could
    // commit on its own. Its only output is the answer it prints, and any answer that is not
    // well formed and fully sourced is discarded, which REPLANS the node instead of retrying it.
    //
    // With no workspace configured the seat runs where the wrapper does; it can still answer
    // from the findings, it just has no record to cite.
    const governorSeat = createGovernorSeat({
      log: (line) => { process.stdout.write(`${line}\n`); },
      run: createProviderGovernorRunner({
        command: process.env["MOE_AGENT_COMMAND"] ?? "claude",
        cwd: compiledWorkspace ?? process.cwd(),
      }),
    });
    const governancePass = createGovernancePass({
      advisor: governorSeat,
      clock: () => new Date().toISOString(),
      log: (line) => { process.stdout.write(`${line}\n`); },
      nodes: listNodes,
      policy: governance,
      projectId: config.projectId,
      store: () => verifierStore,
    });

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
    // The disposable database's image/variables/TLS are the OPERATOR's to declare (MOE_VERIFIER_DB_*):
    // a product needing pgvector or TLS could never verify against the hard-coded shape. Unset = byte-identical.
    const verifierDatabase = verifierDatabaseProvisioningFromEnvironment(process.env);
    // Stated at startup so the FIRST lines of wrapper.log prove what the verifier will provision.
    // Measured 2026-09-18: the knobs were set at the launcher and silently absent here, and the
    // only evidence was a verifier refusal an hour later. Names only — never the delivered values.
    const shape = resolveVerifierDatabaseProvisioning(verifierDatabase);
    process.stdout.write(`[verifier] database: image=${shape.image} urlVariables=${shape.urlVariables.join(",")}`
      + ` tls=${String(shape.tls)} caVariable=${shape.caPathVariable ?? "-"}`
      + `${verifierDatabase === undefined ? " (defaults: no MOE_VERIFIER_DB_* reached this process)" : ""}\n`);
    verifierRunner = createVerifierDatabaseRunner({
      ...(verifierDelivered === undefined ? {} : { delivered: verifierDelivered }),
      ...(verifierDatabase === undefined ? {} : { database: verifierDatabase }),
      // Same drop as the spawner's handler below, for the verifier's own child.
      onFatalContainment: (error: { readonly reason?: string }) => {
        process.stderr.write("[verifier] fatal containment failure: "
          + `${error.reason ?? "UNNAMED"}; stopping the fleet\n`);
        stop.request();
      },
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
      // A seat's tool call that THROWS host-side used to vanish: UNKNOWN_ERROR to the seat and
      // nothing here. It now lands as MCP_DISPATCH_THREW on this wrapper's diagnostics plane.
      onDispatchFault: mcpDispatchFaultReporter(mcpDiagnostics),
      onSessionFault: mcpSessionFaultReporter(mcpDiagnostics),
      subscriptions,
      v2Deps,
    });
    const mcpStarted = await mcpHost.start();
    // The code ALONE killed the fleet unexplained: this throw reaches main().catch, which prints
    // one line and exits 1, and every seat in the project is unstaffable. The host now names the
    // errno and the address it could not take, so carry that through instead of dropping it.
    if (!mcpStarted.ok) {
      throw new Error(mcpStarted.detail === undefined
        ? mcpStarted.code
        : `${mcpStarted.code}: ${mcpStarted.detail}`);
    }
    if (stop.requested()) return;
    // The admission-shaped boundary, not the lifetime-shaped one: `claudeSpawner`
    // resolves only when the agent EXITS, so a refused start was indistinguishable
    // from a running one and the wrapper printed SPAWNED either way.
    // The lifetime the bearer TTL above was derived from, handed over rather
    // than re-read from the environment, so the two cannot drift apart.
    agentSpawner = claudeSpawnStarter(mcpStarted.origin, {
      // THE REASON WAS ALWAYS ON THE ARGUMENT AND ALWAYS DROPPED. This handler begins shutting
      // the whole fleet down; without naming PID_UNAVAILABLE / TREE_KILL_FAILED /
      // CLOSE_NOT_OBSERVED the operator's only clue was the absence of further activity, and the
      // reason surfaced much later, reduced to a message, through the shutdown AggregateError.
      onFatalContainment: (error) => {
        process.stderr.write(`[wrapper] fatal containment failure: ${error.reason};`
          + " stopping the fleet\n");
        stop.request();
      },
      // The seat's own lines — spawn refusals, the quiet notice, the exit facts — went to stdout
      // and nowhere else. This is the account an operator needs AFTER a seat has gone wrong.
      log: teeDiagnosticLine({
        emitter: seatDiagnostics,
        event: "SEAT_LINE",
        write: (line) => { process.stdout.write(`${line}\n`); },
      }),
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
    const logPass = createPassLogger(teeDiagnosticLine({
      emitter: passDiagnostics,
      event: "WRAPPER_PASS_LINE",
      // The pass logger already frames whole lines, newline included; passed through untouched.
      write: (line) => { process.stdout.write(line); },
    }));
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
      // Governance answers the nodes this loop cannot otherwise move, BEFORE the pass that would
      // find them unstaffable: a node funded here is staffed in the same pass rather than the
      // next one. It is a no-op unless the owner stated a policy.
      // The pass contains its own failures per node; this is the last line. An escaped rejection
      // here would reach main().catch, whose finally tree-kills every live seat and exits 1 —
      // the same shape that took the fleet down in 2026-09-13, and not a fate an optional
      // advisory pass may ever inflict on the loop.
      await governancePass().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[governance] pass failed: ${message}\n`);
      });
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
      diagnostics.close();
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
