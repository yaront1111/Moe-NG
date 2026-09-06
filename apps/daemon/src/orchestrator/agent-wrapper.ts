import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";

import { agentCapabilitiesFor } from "../daemon-store-dependencies.js";
import type { AffordancePort, ChainStep } from "../http/affordance-contract.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";
import { createAgentAuthorityCleanup } from "./agent-authority-cleanup.js";
import { DESIGN_STEP_KIND, byStaffingRank } from "./agent-staffing-order.js";
import { type DesignBrief, codeMission, compilerMission, designMission, mission }
  from "./agent-mission-text.js";
import type { AgentSessionFence } from "./agent-session-fence.js";
import { PROVIDER_PAUSED_OUTCOME } from "./agent-provider-pause.js";
import type { ProviderPauseGate } from "./agent-provider-pause.js";
import { COMPILER_STEPS, GATE_REFUSALS, HUMAN_ONLY_STEPS } from "./agent-spawn-contract.js";
import type { AgentSpawnStart, RunOnceReport,
  SpawnReport } from "./agent-spawn-contract.js";
import { createAgentWrapperStaffing } from "./agent-wrapper-staffing.js";

// The kind rosters live in the contract file (data, not behaviour); re-exported here so
// the offer surface's test keeps importing HUMAN_ONLY_STEPS from the wrapper it guards.
export { HUMAN_ONLY_STEPS } from "./agent-spawn-contract.js";

/**
 * The wrapper: watches the daemon's own offer surface and staffs it — the
 * old-Moe loop on new-Moe truth.
 *
 * For each READY, unclaimed step (up to `maxAgents`): mint an agent identity
 * (session.open, capabilities scoped to exactly the claimed kind's family plus
 * work.write), claim the item UNDER THE AGENT'S OWN credential so the durable
 * fence names the agent and not the wrapper, then hand the spawner the
 * credential and a mission naming the claimed item. Every step is a normal
 * dispatch through the committed adapter — the wrapper holds no side door, so
 * anything it can do, an agent with the operator credential could do too.
 *
 * The wrapper never invents outcomes: a spawned agent's work shows up as
 * ledger facts (the step turns COMMITTED, the claim is released) or it
 * doesn't. `runOnce` reports what was observed and what was started, nothing
 * more.
 */

export interface SpawnRequest {
  /** The agent's bearer credential. Hand it to the process environment only. */
  readonly credential: string;
  /** The CLAIM's expiry, the horizon the mission names; the bearer's is longer. */
  readonly expiresAt: string;
  readonly kind: string;
  readonly mission: string;
  readonly sessionId: string;
  readonly workItemId: string;
  /** For code nodes: the directory the agent works in; null for chain steps. */
  readonly workspace: string | null;
}

/** Operator-authored coding brief for one node (full spec file). */
export interface NodeMission {
  readonly instructions: string;
  readonly test: string;
  readonly title: string;
  readonly workspace: string;
}

export interface AgentWrapperConfig {
  readonly affordances: AffordancePort;
  /**
   * Claim lifetime per spawn: the reap horizon when a child dies without
   * releasing. The agent renews it if the work runs longer.
   */
  readonly claimTtlMs: number;
  readonly clock: () => number;
  readonly deps: CommandAdapterDeps;
  readonly maxAgents: number;
  /** Stops restaffing one unmoved item; leaving READY re-arms the counter. */
  readonly maxItemAttempts?: number | undefined;
  readonly mintSecret: () => string;
  /** Coding brief per node ref; a node step without one is not staffed. */
  readonly nodeMission?: ((nodeRef: string) => NodeMission | null) | undefined;
  readonly operatorCredential: string;
  /**
   * Provider-limit pause: reads every seat exit, refunds a limit exit's attempt and
   * parks staffing until the reset; absent = today's behaviour.
   */
  readonly providerPause?: ProviderPauseGate | undefined;
  /**
   * Optional development payload suggestion embedded in the mission, so a real
   * model does not have to guess witness hashes. Advisory text only — the
   * daemon's decoder remains the sole payload authority.
   */
  readonly payloadHint?: ((kind: string, target: string | null) => JsonObject | null) | undefined;
  /**
   * The Gate 1 approval triple for a source-bound goal, resolved from durable
   * state for the DISPATCHER mission only. Convenience, not authority: the
   * compile dispatcher re-verifies the gate and digest on every submit, so a
   * wrong answer here buys a refusal, never a compile.
   */
  readonly compilerGateRef?: ((goalId: string | null) => JsonObject | null) | undefined;
  /** The goal's own operator instructions (a replan's findings live there); null when absent. */
  readonly compilerInstructions?: ((goalId: string | null) => string | null) | undefined;
  /** The goal's design outcome for briefs that plan from it. A null answer is STATED as ABSENT
   *  in the brief, never omitted: a seat that cannot tell a skip from a failed read guesses. */
  readonly designBrief?: ((kind: string, target: string | null) => DesignBrief | null) | undefined;
  /** The project the seat's MCP host serves, named in every brief so graph_get is callable. */
  readonly projectId?: string | undefined;
  /**
   * Bearer lifetime per spawn, independent of the claim's. The exit-path
   * release runs under the agent's own secret, so the bearer must outlive the
   * child process: a session bound to the claim TTL dies while a long task is
   * still renewing its claim, and every later release is refused as
   * unauthenticated. Production derives it from the agent lifetime knob
   * (wrapper-knobs.ts); absent, it falls back to `claimTtlMs`.
   */
  readonly sessionTtlMs?: number | undefined;
  /**
   * Starts the agent process and resolves on STARTUP ADMISSION — a coded
   * refusal, or an accepted start whose `exit` is the child's separate lifetime.
   * Injectable for tests.
   */
  readonly spawnAgent: AgentSpawnStart;
  /** Durable pre-identity gate. The lifecycle retains its in-process active map;
   * this injected port survives restarts and expired claims over live children. */
  readonly staffingFence?: AgentSessionFence | undefined;
}

const encoder = new TextEncoder();
function setupError(action: string): Error {
  return new Error(`AGENT_SETUP_FAILED:${action}:UNEXPECTED_ERROR`);
}

function digestOf(payload: JsonObject): string {
  return createHash("sha256").update(encoder.encode(JSON.stringify(payload))).digest("hex");
}

// Re-exported so `codeMission`'s existing import path keeps working: the text
// contract moved file, not home.
export { codeMission } from "./agent-mission-text.js";

export function createAgentWrapper(config: AgentWrapperConfig) {
  const maxItemAttempts = config.maxItemAttempts ?? 3;
  // Counts tries that minted identity. Gate refusals spend nothing and do not
  // exhaust an orphaned item; restart re-arms this advisory counter while the
  // durable staffing gate still fences the live-child race.
  const attempts = new Map<string, number>();
  // One lifecycle owns both the process-local active map and durable gate.
  const staffing = createAgentWrapperStaffing(config.staffingFence);

  const dispatch = (
    credential: string, kind: string, payload: JsonObject,
    target: string, expectedVersion: number, commandId?: string,
  ): { code: string; ok: boolean } => {
    const envelope = {
      commandId: commandId ?? `wrap-${config.mintSecret().slice(0, 18)}`,
      commandKind: kind,
      correlationId: "agent-wrapper",
      expectedVersion,
      payload,
      requestDigest: digestOf(payload),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential,
      targetAggregateId: target,
    };
    const result = handleCommandRequest(config.deps, {
      body: encoder.encode(JSON.stringify(envelope)),
      credential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "AGENT_WRAPPER") as { ok: boolean; outcome: string;
      decision?: { resultCode: string }; refusal?: { code: string }; error?: { code: string }; };
    return result.ok
      ? { code: (result.decision?.resultCode ?? "ACCEPTED"), ok: true }
      : { code: result.refusal?.code ?? result.error?.code ?? result.outcome, ok: false };
  };

  /** Every report but the admitted one: the start earned no producer code. */
  const uncoded = (
    kind: string, outcome: string, sessionId: string | null, workItemId: string,
  ): SpawnReport => ({ kind, outcome, refusal: null, sessionId, workItemId });

  const staff = async (step: ChainStep): Promise<SpawnReport> => {
    const workItemId = workItemIdFor(step.kind, step.aggregateId);
    const capabilities = agentCapabilitiesFor(step.kind);
    if (capabilities === null) return uncoded(step.kind, "UNWIRED_KIND", null, workItemId);
    // Resolve the coding brief BEFORE any durable step: refusing after the
    // claim would leave a fenced item nobody is working on until expiry.
    let brief: NodeMission | null = null;
    if (step.kind === "node.deliver") {
      try {
        brief = config.nodeMission?.(step.aggregateId ?? "") ?? null;
      } catch {
        const failure = setupError("node.mission");
        staffing.recordFailures(failure);
        return uncoded(step.kind, failure.message, null, workItemId);
      }
      if (brief === null) return uncoded(step.kind, "NODE_BRIEF_MISSING", null, workItemId);
    }

    // THE DURABLE STAFFING GATE, before any identity or claim is minted.
    // `session.open` and `work.claim` both follow this point, so one consult
    // here fences both. It answers what the surface cannot: an expired claim
    // still covering a live child reads as UNCLAIMED, and only this record
    // knows the predecessor is alive.
    const refused = staffing.admit(workItemId, config.clock());
    if (refused !== null) return uncoded(step.kind, refused.code, null, workItemId);

    let secret: string;
    let sessionId: string;
    let expiresAt: string;
    let sessionExpiresAt: string;
    try {
      secret = config.mintSecret();
      // The full mint, never a prefix: distinct mints can share long prefixes.
      sessionId = `sess-wrap-${config.mintSecret()}`;
      // Two horizons off one clock read: the claim's (what the mission tells
      // the agent it holds, and what the agent renews) and the bearer's (which
      // must still authenticate the release after the child has exited).
      const now = config.clock();
      expiresAt = new Date(now + config.claimTtlMs).toISOString();
      sessionExpiresAt =
        new Date(now + (config.sessionTtlMs ?? config.claimTtlMs)).toISOString();
    } catch {
      const failure = setupError("identity.mint");
      staffing.recordFailures(failure);
      return uncoded(step.kind, failure.message, null, workItemId);
    }

    const cleanupAuthority = createAgentAuthorityCleanup({
      affordances: config.affordances,
      clock: config.clock,
      dispatch,
      operatorCredential: config.operatorCredential,
      secret,
      sessionId,
      workItemId,
    });

    const failSetup = (action: string, releaseClaim: boolean): SpawnReport => {
      const failure = setupError(action);
      staffing.recordFailures(failure, ...cleanupAuthority(releaseClaim));
      return uncoded(step.kind, failure.message, sessionId, workItemId);
    };

    let opened: { code: string; ok: boolean };
    try {
      opened = dispatch(config.operatorCredential, "session.open", {
        capabilities: [...capabilities],
        credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
        expiresAt: sessionExpiresAt,
        sessionId,
      }, `session/${sessionId}`, 0);
    } catch {
      return failSetup("session.open", false);
    }
    if (!opened.ok || opened.code !== "EFFECTS_COMMITTED") {
      return uncoded(step.kind, opened.code, null, workItemId);
    }

    // The AGENT claims, so the fence names the agent: expiry doubles as the
    // reap horizon when a spawned process dies without releasing.
    let claimed: { code: string; ok: boolean };
    try {
      claimed = dispatch(secret, "work.claim", { expiresAt, workItemId },
        `work/${workItemId}`, step.claimAggregateVersion);
    } catch {
      // Dispatch may have committed before throwing. Probe the durable claim
      // and release only this session's exact visible version before closing.
      return failSetup("work.claim", true);
    }
    if (!claimed.ok || claimed.code !== "EFFECTS_COMMITTED") {
      staffing.recordFailures(...cleanupAuthority(false));
      return uncoded(step.kind, claimed.code, sessionId, workItemId);
    }

    let missionText: string;
    let workspace: string | null = null;
    try {
      if (brief !== null) {
        workspace = brief.workspace;
        missionText = codeMission(workItemId, step.aggregateId ?? "", expiresAt, brief, {
          accept: null,
          submit: config.payloadHint?.("review.submit", step.aggregateId) ?? null,
        }, config.projectId ?? null, config.designBrief?.(step.kind, step.aggregateId) ?? null);
      } else if (step.kind === DESIGN_STEP_KIND) {
        missionText = designMission(workItemId, step.kind, expiresAt, step.aggregateId,
          config.projectId ?? null);
      } else if (COMPILER_STEPS.has(step.kind)) {
        // The planning lane gets its OWN brief and NO payload hint: the demo
        // `payloadFor` table proposing a hard-coded graph against a real PRD is
        // the exact race the compiler retires.
        missionText = compilerMission(workItemId, step.kind, expiresAt, step.aggregateId,
          step.kind === "planning.submit_decomposition"
            ? config.compilerGateRef?.(step.aggregateId) ?? null
            : null,
          config.compilerInstructions?.(step.aggregateId) ?? null, config.projectId ?? null,
          config.designBrief?.(step.kind, step.aggregateId) ?? null);
      } else {
        const hint = config.payloadHint?.(step.kind, step.aggregateId) ?? null;
        missionText = mission(workItemId, step.kind, expiresAt, hint, config.projectId ?? null);
      }
    } catch {
      return failSetup("mission", true);
    }

    const request = {
      credential: secret, expiresAt, kind: step.kind,
      mission: missionText, sessionId, workItemId, workspace,
    };
    return staffing.start({
      claimAggregateVersion: step.claimAggregateVersion,
      cleanupAuthority,
      kind: step.kind,
      // The attempt is charged when the seat spawns. A PROVIDER_LIMIT exit hands it
      // back, so the item's count on the next pass equals its pre-spawn count: the
      // provider refused, the item never got its turn.
      onExit: config.providerPause?.exitObserver(sessionId, workItemId, () => {
        attempts.set(workItemId, Math.max(0, (attempts.get(workItemId) ?? 0) - 1));
      }),
      request,
      sessionId,
      spawnAgent: config.spawnAgent,
      workItemId,
    });
  };

  // Async ONLY to await startup admission; the child's exit is never awaited here.
  const runPass = async (): Promise<RunOnceReport> => {
    const priorFailure = staffing.failureOutcome();
    if (priorFailure !== null) {
      return { active: staffing.activeCount(), spawned: [], surfaceOutcome: priorFailure };
    }
    // One MOE_AGENT_COMMAND per wrapper process, so one provider: while its pause is
    // live this pass staffs nothing and keeps polling. The pass at or after the reset
    // reads null and staffs normally.
    const paused = config.providerPause?.paused(config.clock()) ?? null;
    if (paused !== null) {
      return {
        active: staffing.activeCount(), paused, spawned: [],
        surfaceOutcome: PROVIDER_PAUSED_OUTCOME,
      };
    }
    const surface = config.affordances.readSurface();
    if (surface.outcome !== "SURFACE") {
      return { active: staffing.activeCount(), spawned: [], surfaceOutcome: surface.code };
    }
    const spawned: SpawnReport[] = [];
    // Leaving READY is movement and re-arms attempts. A held claim or durable
    // gate refusal is not movement and must not create an infinite respawn loop.
    const ready = new Set(surface.steps
      .filter((step) => step.status === "READY")
      .map((step) => workItemIdFor(step.kind, step.aggregateId)));
    for (const item of [...attempts.keys()]) {
      if (!ready.has(item)) attempts.delete(item);
    }
    const ordered = [...surface.steps].sort(byStaffingRank);
    for (const step of ordered) {
      if (HUMAN_ONLY_STEPS.has(step.kind)) continue;
      if (staffing.activeCount() >= config.maxAgents) break;
      if (step.status !== "READY" || step.claim !== null) continue;
      // Session lifecycle steps are wrapper plumbing, not agent work.
      if (step.kind.startsWith("session.")) continue;
      const workItemId = workItemIdFor(step.kind, step.aggregateId);
      if (staffing.has(workItemId)) continue;
      const tried = attempts.get(workItemId) ?? 0;
      if (tried >= maxItemAttempts) {
        spawned.push(uncoded(step.kind, "STAFFING_ATTEMPTS_EXHAUSTED", null, workItemId));
        continue;
      }
      const report = await staff(step);
      // Charged only for a try that got past the gate: a fence refusal spent
      // nothing and must not exhaust the item while its predecessor lives.
      if (!GATE_REFUSALS.has(report.outcome)) attempts.set(workItemId, tried + 1);
      spawned.push(report);
      if (staffing.failureOutcome() !== null) break;
    }
    return {
      active: staffing.activeCount(),
      spawned,
      surfaceOutcome: staffing.failureOutcome() ?? "SURFACE",
    };
  };

  // Serialize passes, not child lifetimes: overlapping surface snapshots could
  // double-staff or overshoot maxAgents, and one failed pass must not poison later work.
  let pending: Promise<unknown> = Promise.resolve();
  const runOnce = (): Promise<RunOnceReport> => {
    const next = pending.then(runPass, runPass);
    pending = next.catch(() => undefined);
    return next;
  };

  return Object.freeze({
    activeCount: staffing.activeCount,
    runOnce,
    /** Resolves when every currently spawned agent has exited. */
    settle: staffing.settle,
  });
}
