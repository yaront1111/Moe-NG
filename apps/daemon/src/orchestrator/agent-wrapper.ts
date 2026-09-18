import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { validReviewContinuationApproval } from "@moe/review";
import type { JsonObject } from "@moe/contracts";

import { agentCapabilitiesFor } from "../daemon-store-dependencies.js";
import type { AffordanceSurfaceResult, ChainStep } from "../http/affordance-contract.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";
import { createAgentAuthorityCleanup } from "./agent-authority-cleanup.js";
import { DESIGN_STEP_KIND, byStaffingRank } from "./agent-staffing-order.js";
import { codeMission, compilerMission, designGoalRef, designMission, mission } from "./agent-mission-text.js";
import { PROVIDER_PAUSED_OUTCOME } from "./agent-provider-pause.js";
import { decideSeatProvider, pauseProviderOf } from "./agent-provider-resolve.js";
import {
  COMPILER_STEPS, GATE_REFUSALS, HUMAN_ONLY_STEPS, NODE_BRIEF_UNREADABLE, NodeBriefUnreadableError,
} from "./agent-spawn-contract.js";
import type { ProviderPauseFacts, RunOnceReport, SpawnReport, SpawnStartRefusal } from "./agent-spawn-contract.js";
import type { AgentWrapperConfig, NodeMission } from "./agent-wrapper-config.js";
import { createAgentWrapperStaffing } from "./agent-wrapper-staffing.js";
import { createRepositoryAdmissionBackoff } from "./repository-admission-backoff.js";
import type { RepositoryAdmissionWait } from "./repository-admission-backoff.js";

// The kind rosters live in the contract file (data, not behaviour); re-exported here so
// the offer surface's test keeps importing HUMAN_ONLY_STEPS from the wrapper it guards.
export { HUMAN_ONLY_STEPS } from "./agent-spawn-contract.js";
// The config contract moved file, not home: every importer of these three keeps its path.
export type { AgentWrapperConfig, NodeMission, SpawnRequest } from "./agent-wrapper-config.js";

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

const encoder = new TextEncoder();
function setupError(action: string, cause?: unknown): Error {
  // One public context refusal survives; arbitrary reader errors may contain private paths or data.
  if (action === "mission" && cause instanceof Error && cause.message === "REPLAN_CONTEXT_UNAVAILABLE") {
    return new Error("REPLAN_CONTEXT_UNAVAILABLE");
  }
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
  const appliedContinuations = new Map<string, { decisionId: string; resultSha256: string; version: number }>();
  const observeContinuation = (step: ChainStep, workItemId: string): void => {
    if (step.kind !== "node.deliver" || step.aggregateId === null || config.reviewContinuation === undefined) return;
    try {
      const approval = config.reviewContinuation(step.aggregateId);
      if (!validReviewContinuationApproval(approval) || approval.projectId !== config.projectId
        || approval.projectId !== config.affordances.boundProjectId || approval.subjectRef !== step.aggregateId
        || approval.decisionVersion !== step.version) return;
      const prior = appliedContinuations.get(workItemId);
      if (prior !== undefined && (approval.decisionVersion <= prior.version || approval.decisionId === prior.decisionId
        || approval.decisionResultSha256 === prior.resultSha256)) return;
      // A human grant can arrive between polls, hiding the BLOCKED interval. Its immutable
      // identity re-arms this advisory counter once; it does not create another review grant.
      appliedContinuations.set(workItemId, { decisionId: approval.decisionId,
        resultSha256: approval.decisionResultSha256, version: approval.decisionVersion });
      attempts.delete(workItemId);
    } catch { /* An unknown grant never re-arms attempts. */ }
  };
  const repositoryBackoff = createRepositoryAdmissionBackoff();
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

  const staff = async (step: ChainStep, command: string): Promise<SpawnReport> => {
    const workItemId = workItemIdFor(step.kind, step.aggregateId);
    const capabilities = agentCapabilitiesFor(step.kind);
    if (capabilities === null) return uncoded(step.kind, "UNWIRED_KIND", null, workItemId);
    // Resolve the coding brief BEFORE any durable step: refusing after the
    // claim would leave a fenced item nobody is working on until expiry.
    let brief: NodeMission | null = null;
    if (step.kind === "node.deliver") {
      try {
        brief = config.nodeMission?.(step.aggregateId ?? "") ?? null;
      } catch (error) {
        // A brief the STORE could not serve is retried next pass and recorded nowhere. The path
        // below records a failure the staffing gate never clears, so it would turn one
        // transient read fault into a wrapper that staffs nothing until restarted.
        if (error instanceof NodeBriefUnreadableError) {
          return uncoded(step.kind, NODE_BRIEF_UNREADABLE, null, workItemId);
        }
        const failure = setupError("node.mission");
        staffing.recordFailures(failure);
        return uncoded(step.kind, failure.message, null, workItemId);
      }
      if (brief === null) return uncoded(step.kind, "NODE_BRIEF_MISSING", null, workItemId);
      // Who holds the repository is read BEFORE any durable step (addendum 2026-09-15): a busy
      // repository used to cost a session, a claim and a staffing record on every retry.
      // An unreadable admission is no answer: the spawner's own repository gate still decides.
      let held: SpawnStartRefusal | null = null;
      try { held = config.repositoryAdmission?.(step.aggregateId ?? "", brief.workspace) ?? null; } catch { held = null; }
      if (held !== null) return { kind: step.kind, outcome: held.code, refusal: held, sessionId: null, workItemId };
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

    const failSetup = (action: string, releaseClaim: boolean, cause?: unknown): SpawnReport => {
      const failure = setupError(action, cause);
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
          config.projectId ?? null,
          config.compilerInstructions?.(designGoalRef(step.aggregateId)) ?? null);
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
    } catch (cause) {
      return failSetup("mission", true, cause);
    }

    const request = { credential: secret, expiresAt, kind: step.kind, mission: missionText,
      provider: command, sessionId, workItemId, workspace };
    return staffing.start({
      claimAggregateVersion: step.claimAggregateVersion,
      cleanupAuthority,
      kind: step.kind,
      // The attempt is charged when the seat spawns. A PROVIDER_LIMIT exit hands it
      // back, so the item's count on the next pass equals its pre-spawn count: the
      // provider refused, the item never got its turn.
      onExit: config.providerPause?.exitObserver(sessionId, workItemId, () => {
        attempts.set(workItemId, Math.max(0, (attempts.get(workItemId) ?? 0) - 1));
      }, pauseProviderOf(command), secret),
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
      return {
        active: staffing.activeCount(), halted: priorFailure, spawned: [], surfaceOutcome: priorFailure,
      };
    }
    // MANY providers per wrapper, one resolved per spawn, so the pause is consulted PER
    // STEP against that seat's own provider (decideSeatProvider) and PROVIDER_PAUSED is
    // reported only when a pause is why the pass staffed NOTHING. See that module.
    let stalled: ProviderPauseFacts | null = null;
    let surface: AffordanceSurfaceResult;
    try {
      surface = config.affordances.readSurface();
    } catch {
      // A ledger read that throws is one unreadable pass, reported by the code every sibling
      // read already answers (agent-authority-cleanup.ts), never a rejection: a DurableStoreError
      // STORE_BUSY under a concurrent daemon commit left runOnce this way, reached main() and
      // tree-killed every live seat (measured 2026-09-13). The next pass reads again.
      return { active: staffing.activeCount(), spawned: [], surfaceOutcome: "SURFACE_READ_FAILED" };
    }
    if (surface.outcome !== "SURFACE") {
      return { active: staffing.activeCount(), spawned: [], surfaceOutcome: surface.code };
    }
    const spawned: SpawnReport[] = [];
    const repositoryWaiting: RepositoryAdmissionWait[] = [];
    // Leaving READY is movement and re-arms attempts. A held claim or durable
    // gate refusal is not movement and must not create an infinite respawn loop.
    const ready = new Set(surface.steps
      .filter((step) => step.status === "READY")
      .map((step) => workItemIdFor(step.kind, step.aggregateId)));
    for (const item of [...attempts.keys()]) {
      if (!ready.has(item)) attempts.delete(item);
    }
    repositoryBackoff.retain(ready);
    const ordered = [...surface.steps].sort(byStaffingRank);
    for (const step of ordered) {
      if (HUMAN_ONLY_STEPS.has(step.kind)) continue;
      if (staffing.activeCount() >= config.maxAgents) break;
      if (step.status !== "READY" || step.claim !== null) continue;
      // Session lifecycle steps are wrapper plumbing, not agent work.
      if (step.kind.startsWith("session.")) continue;
      const workItemId = workItemIdFor(step.kind, step.aggregateId);
      if (staffing.has(workItemId)) continue;
      const waiting = repositoryBackoff.waiting(workItemId, step.version, config.clock());
      if (waiting !== null) { repositoryWaiting.push(waiting); continue; }
      observeContinuation(step, workItemId);
      const tried = attempts.get(workItemId) ?? 0;
      if (tried >= maxItemAttempts) {
        spawned.push(uncoded(step.kind, "STAFFING_ATTEMPTS_EXHAUSTED", null, workItemId));
        continue;
      }
      let seat: ReturnType<typeof decideSeatProvider>;
      try {
        seat = decideSeatProvider({ aggregateId: step.aggregateId, kind: step.kind,
          nowMs: config.clock(), pauseGate: config.providerPause,
          settingFor: config.agentProvider });
      } catch {
        // The pause ledger raises the same store error. An unreadable pause gains no authority
        // to staff the step and charges it no attempt: reported by code, read again next pass.
        spawned.push(uncoded(step.kind, "PROVIDER_PAUSE_UNREADABLE", null, workItemId));
        continue;
      }
      if (seat.pause !== null) { stalled = seat.pause; continue; }
      const report = await staff(step, seat.command);
      repositoryBackoff.record(report, step.version, config.clock());
      // Charged only for a try that got past the gate: a fence refusal spent
      // nothing and must not exhaust the item while its predecessor lives.
      if (!GATE_REFUSALS.has(report.outcome)) attempts.set(workItemId, tried + 1);
      spawned.push(report);
      if (staffing.failureOutcome() !== null) break;
      // A closed spawner admits nothing else this pass: stop before minting more identities.
      if (report.refusal?.code === "AGENT_SPAWNER_CLOSED") break;
    }
    const idled = stalled !== null && spawned.length === 0;
    const halted = staffing.failureOutcome();
    return { active: staffing.activeCount(), spawned,
      ...(repositoryWaiting.length === 0 ? {} : { repositoryWaiting }),
      ...(idled && stalled !== null ? { paused: stalled } : {}),
      ...(halted === null ? {} : { halted }),
      surfaceOutcome: halted ?? (idled ? PROVIDER_PAUSED_OUTCOME : "SURFACE") };
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
