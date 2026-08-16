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
import { codeMission, mission } from "./agent-mission-text.js";
import type { AgentSessionFence } from "./agent-session-fence.js";
import { createStaffingGate } from "./agent-staffing-gate.js";
import type { AgentSpawnStart, AgentSpawnStartResult, RunOnceReport,
  SpawnReport } from "./agent-spawn-contract.js";

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
  /** Claim/session lifetime per spawn. */
  readonly claimTtlMs: number;
  readonly clock: () => number;
  readonly deps: CommandAdapterDeps;
  readonly maxAgents: number;
  readonly mintSecret: () => string;
  /** Coding brief per node ref; a node step without one is not staffed. */
  readonly nodeMission?: ((nodeRef: string) => NodeMission | null) | undefined;
  readonly operatorCredential: string;
  /**
   * Optional development payload suggestion embedded in the mission, so a real
   * model does not have to guess witness hashes. Advisory text only — the
   * daemon's decoder remains the sole payload authority.
   */
  readonly payloadHint?: ((kind: string, target: string | null) => JsonObject | null) | undefined;
  /**
   * Starts the agent process and resolves on STARTUP ADMISSION — a coded
   * refusal, or an accepted start whose `exit` is the child's separate lifetime.
   * Injectable for tests.
   */
  readonly spawnAgent: AgentSpawnStart;
  /**
   * Durable staffing gate, consulted before any identity or claim is minted.
   *
   * Injected rather than constructed here so the wrapper never owns a store
   * handle. It is NOT a replacement for the in-process `active` map: that map
   * is still the correct cheap guard inside one process, and this port is what
   * survives the wrapper restart — or the claim expiry over a still-live child
   * — that the map cannot see. A wrapper built without one keeps the legacy
   * unfenced behaviour; production wires it in agent-wrapper-main.ts.
   */
  readonly staffingFence?: AgentSessionFence | undefined;
}

const encoder = new TextEncoder();
const HUMAN_ONLY_STEPS: ReadonlySet<string> = new Set(["approval.decide", "goal.close"]);

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
  const active = new Map<string, Promise<void>>();
  const cleanupFailures: Error[] = [];
  // The durable half of the staffing decision. `active` below is the in-process
  // half and is NOT replaced by it: it stays the correct cheap guard within one
  // process, while the gate is what survives a restart.
  const gate = createStaffingGate(config.staffingFence);

  const failures = (): Error[] => [...cleanupFailures].sort((a, b) =>
    a.message < b.message ? -1 : a.message > b.message ? 1 : 0);
  const failureOutcome = (): string | null => {
    const ordered = failures();
    return ordered.length === 0 ? null : ordered.map((error) => error.message).join("|");
  };

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
    }) as { ok: boolean; outcome: string;
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
        cleanupFailures.push(failure);
        return uncoded(step.kind, failure.message, null, workItemId);
      }
      if (brief === null) return uncoded(step.kind, "NODE_BRIEF_MISSING", null, workItemId);
    }

    // THE DURABLE STAFFING GATE, before any identity or claim is minted.
    // `session.open` and `work.claim` both follow this point, so one consult
    // here fences both. It answers what the surface cannot: an expired claim
    // still covering a live child reads as UNCLAIMED, and only this record
    // knows the predecessor is alive.
    const refused = gate.admit(workItemId, config.clock());
    if (refused !== null) return uncoded(step.kind, refused.code, null, workItemId);

    let secret: string;
    let sessionId: string;
    let expiresAt: string;
    try {
      secret = config.mintSecret();
      // The full mint, never a prefix: distinct mints can share long prefixes.
      sessionId = `sess-wrap-${config.mintSecret()}`;
      expiresAt = new Date(config.clock() + config.claimTtlMs).toISOString();
    } catch {
      const failure = setupError("identity.mint");
      cleanupFailures.push(failure);
      return uncoded(step.kind, failure.message, null, workItemId);
    }

    const cleanupAuthority = createAgentAuthorityCleanup({
      affordances: config.affordances,
      dispatch,
      operatorCredential: config.operatorCredential,
      secret,
      sessionId,
      workItemId,
    });

    const failSetup = (action: string, releaseClaim: boolean): SpawnReport => {
      const failure = setupError(action);
      cleanupFailures.push(failure, ...cleanupAuthority(releaseClaim));
      return uncoded(step.kind, failure.message, sessionId, workItemId);
    };

    let opened: { code: string; ok: boolean };
    try {
      opened = dispatch(config.operatorCredential, "session.open", {
        capabilities: [...capabilities],
        credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
        expiresAt,
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
      cleanupFailures.push(...cleanupAuthority(false));
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
        });
      } else {
        const hint = config.payloadHint?.(step.kind, step.aggregateId) ?? null;
        missionText = mission(workItemId, step.kind, expiresAt, hint);
      }
    } catch {
      return failSetup("mission", true);
    }

    const request = {
      credential: secret, expiresAt, kind: step.kind,
      mission: missionText, sessionId, workItemId, workspace,
    };
    // ADMISSION ONLY. A synchronous throw becomes the same rejected path a
    // failed start takes, so the caller sees one shape either way.
    let start: AgentSpawnStartResult;
    try {
      start = await config.spawnAgent(request);
    } catch (error) {
      // No producer code was earned, so none is invented. The start fails
      // closed through cleanup instead of being reported as SPAWNED.
      cleanupFailures.push(
        error instanceof Error ? error : new Error("AGENT_SPAWN_FAILED:UNKNOWN"),
        ...cleanupAuthority(true),
      );
      return uncoded(step.kind, "AGENT_SPAWN_FAILED:UNADMITTED", sessionId, workItemId);
    }
    if (!start.ok) {
      // The refusal travels verbatim: re-wrapping it into a wrapper-local code
      // would erase which layer actually answered.
      cleanupFailures.push(...cleanupAuthority(true));
      return { kind: step.kind, outcome: start.code, refusal: start, sessionId, workItemId };
    }
    // `exit` is the child's LIFETIME. It is handled — an unhandled rejection
    // would escape the wrapper — but it is never awaited on this path.
    // The child is live from here, so the durable record goes down BEFORE the
    // lifetime handlers are attached — a record written later could be skipped
    // by a child that exits immediately.
    cleanupFailures.push(...gate.record({
      childPid: start.pid,
      claimAggregateVersion: step.claimAggregateVersion,
      sessionId,
      workItemId,
    }));
    // Retired on BOTH lifetime routes. A route that forgets to retire wedges
    // the item permanently, which is worse than the race this fence closes and
    // breaks resume-after-crash outright.
    const retire = (): readonly Error[] => gate.retire(workItemId);
    const exit = start.exit
      .then(
        () => { cleanupFailures.push(...cleanupAuthority(true), ...retire()); },
        (error: unknown) => {
          cleanupFailures.push(
            error instanceof Error ? error : new Error("AGENT_PROCESS_FAILED:UNKNOWN"),
            ...cleanupAuthority(true),
            ...retire(),
          );
        },
      )
      .finally(() => { active.delete(workItemId); });
    active.set(workItemId, exit);
    return { kind: step.kind, outcome: "SPAWNED", refusal: null, sessionId, workItemId };
  };

  // Async ONLY to await startup admission; the child's exit is never awaited here.
  const runPass = async (): Promise<RunOnceReport> => {
    const priorFailure = failureOutcome();
    if (priorFailure !== null) {
      return { active: active.size, spawned: [], surfaceOutcome: priorFailure };
    }
    const surface = config.affordances.readSurface();
    if (surface.outcome !== "SURFACE") {
      return { active: active.size, spawned: [], surfaceOutcome: surface.code };
    }
    const spawned: SpawnReport[] = [];
    // Staffing priority: code nodes are the point of the board, so they come first.
    // Human approval and goal closure stay visible on the board but are never delegated.
    const ordered = [...surface.steps].sort((a, b) => {
      const rank = (step: ChainStep): number =>
        step.kind === "node.deliver" ? 0 : step.kind === "goal.close" ? 2 : 1;
      return rank(a) - rank(b);
    });
    for (const step of ordered) {
      if (HUMAN_ONLY_STEPS.has(step.kind)) continue;
      if (active.size >= config.maxAgents) break;
      if (step.status !== "READY" || step.claim !== null) continue;
      // Session lifecycle steps are identity plumbing the wrapper itself uses,
      // not board work an agent should be staffed on.
      if (step.kind.startsWith("session.")) continue;
      if (active.has(workItemIdFor(step.kind, step.aggregateId))) continue;
      spawned.push(await staff(step));
      if (failureOutcome() !== null) break;
    }
    return { active: active.size, spawned, surfaceOutcome: failureOutcome() ?? "SURFACE" };
  };

  // ONE PASS AT A TIME. While `runOnce` was synchronous, overlapping passes were
  // impossible; awaiting admission opens a window where two passes read the same
  // surface snapshot and could staff one item twice or overshoot `maxAgents`.
  // This serialises PASSES only — it never waits on a child's lifetime — and a
  // failed pass is not allowed to poison the chain behind it.
  let pending: Promise<unknown> = Promise.resolve();
  const runOnce = (): Promise<RunOnceReport> => {
    const next = pending.then(runPass, runPass);
    pending = next.catch(() => undefined);
    return next;
  };

  return Object.freeze({
    activeCount: (): number => active.size,
    runOnce,
    /** Resolves when every currently spawned agent has exited. */
    settle: async (): Promise<void> => {
      await Promise.all([...active.values()]);
      const ordered = failures();
      if (ordered.length === 1) throw ordered[0];
      if (ordered.length > 1) {
        throw new AggregateError(ordered, ordered.map((error) => error.message).join("|"));
      }
    },
  });
}
