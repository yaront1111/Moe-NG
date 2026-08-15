import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";

import { agentCapabilitiesFor } from "../daemon-store-dependencies.js";
import type { AffordancePort, ChainStep } from "../http/affordance-contract.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";

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
  /** Spawns the agent process; resolves when it exits. Injectable for tests. */
  readonly spawnAgent: (request: SpawnRequest) => Promise<void>;
}

export interface SpawnReport {
  readonly kind: string;
  readonly outcome: "SPAWNED" | string;
  readonly sessionId: string | null;
  readonly workItemId: string;
}

export interface RunOnceReport {
  readonly active: number;
  readonly spawned: readonly SpawnReport[];
  readonly surfaceOutcome: string;
}

const encoder = new TextEncoder();
const HUMAN_ONLY_STEPS: ReadonlySet<string> = new Set(["approval.decide", "goal.close"]);

function digestOf(payload: JsonObject): string {
  return createHash("sha256").update(encoder.encode(JSON.stringify(payload))).digest("hex");
}

/** Exported for its text contract: the agent learns the release payload shape from here. */
export function codeMission(
  workItemId: string, nodeRef: string, expiresAt: string, brief: NodeMission,
  hints: { accept: JsonObject | null; submit: JsonObject | null },
): string {
  const lines = [
    `You are a moe-next coding agent. You hold the durable claim on code node "${nodeRef}"`,
    `(work item "${workItemId}") until ${expiresAt}. TASK — ${brief.title}:`,
    brief.instructions,
    `Work in the directory ${brief.workspace} (your working directory). Verify by running:`,
    `${brief.test} — it must exit 0 before you report anything as done.`,
    "Then record your submission durably over the moe-next MCP tools:",
    "1) call work_get_context and find the review.submit offer whose targetAggregateId is",
    `"${nodeRef}"; call review_submit with EXACTLY that offer's commandId and`,
    "expectedVersion, round = expectedVersion + 1, and empty findings if your test run",
    "was clean.",
    `2) finish with work_release with payload {"workItemId": "${workItemId}"} and no`,
    "other fields.",
    "Do NOT call integration_accept_output — acceptance is EARNED from the daemon's own",
    "verifier run, never from your report. The daemon will verify your submission and",
    "either accept it or record a verifier-test-failed round for the next attempt.",
    "Every refusal carries a stable reason code — read it, correct the request, never",
    "work around a refusal, and report what the daemon actually answered.",
  ];
  if (hints.submit !== null) {
    lines.push(`Suggested review.submit payload shape: ${JSON.stringify(hints.submit)}`);
  }
  return lines.join(" ");
}

function mission(
  workItemId: string, kind: string, expiresAt: string, hint: JsonObject | null,
): string {
  const lines = [
    `You are a moe-next agent. You hold the durable claim on work item "${workItemId}"`,
    `(command kind ${kind}) until ${expiresAt}.`,
    "Use the moe-next MCP tools: first call work_get_context to see the board and find",
    `the daemon's offered command for your step (commandKind ${kind}); then call the`,
    `${kind.replaceAll(".", "_")} tool passing EXACTLY the offer's commandId,`,
    "expectedVersion and targetAggregateId plus a correlationId and the payload.",
    "Renew your claim with work_renew if you need longer, and finish by calling",
    `work_release with payload {"workItemId": "${workItemId}"}. Every refusal carries`,
    "a stable reason code — read it, correct the request, never work around a refusal,",
    "and report what the daemon actually answered.",
  ];
  if (hint !== null) {
    lines.push(`Suggested development payload for ${kind}: ${JSON.stringify(hint)}`);
  }
  return lines.join(" ");
}

export function createAgentWrapper(config: AgentWrapperConfig) {
  const active = new Map<string, Promise<void>>();

  const dispatch = (
    credential: string, kind: string, payload: JsonObject,
    target: string, expectedVersion: number,
  ): { code: string; ok: boolean } => {
    const envelope = {
      commandId: `wrap-${config.mintSecret().slice(0, 18)}`,
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

  const staff = (step: ChainStep): SpawnReport => {
    const workItemId = workItemIdFor(step.kind, step.aggregateId);
    const capabilities = agentCapabilitiesFor(step.kind);
    if (capabilities === null) {
      return { kind: step.kind, outcome: "UNWIRED_KIND", sessionId: null, workItemId };
    }
    // Resolve the coding brief BEFORE any durable step: refusing after the
    // claim would leave a fenced item nobody is working on until expiry.
    let brief: NodeMission | null = null;
    if (step.kind === "node.deliver") {
      brief = config.nodeMission?.(step.aggregateId ?? "") ?? null;
      if (brief === null) {
        return { kind: step.kind, outcome: "NODE_BRIEF_MISSING", sessionId: null, workItemId };
      }
    }
    const secret = config.mintSecret();
    // The full mint, never a prefix: distinct mints can share long prefixes.
    const sessionId = `sess-wrap-${config.mintSecret()}`;
    const expiresAt = new Date(config.clock() + config.claimTtlMs).toISOString();

    const opened = dispatch(config.operatorCredential, "session.open", {
      capabilities: [...capabilities],
      credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
      expiresAt,
      sessionId,
    }, `session/${sessionId}`, 0);
    if (!opened.ok) {
      return { kind: step.kind, outcome: opened.code, sessionId: null, workItemId };
    }

    const closeSession = (version: number): void => {
      dispatch(
        config.operatorCredential,
        "session.close",
        { sessionId },
        `session/${sessionId}`,
        version,
      );
    };

    // The AGENT claims, so the fence names the agent: expiry doubles as the
    // reap horizon when a spawned process dies without releasing.
    const claimed = dispatch(secret, "work.claim", { expiresAt, workItemId },
      `work/${workItemId}`, 0);
    if (!claimed.ok) {
      // Nothing was spawned, so no child can clean this identity up later.
      // The open decision left the session at version 1.
      try { closeSession(1); } catch { /* expiry is the fail-closed backstop */ }
      return { kind: step.kind, outcome: claimed.code, sessionId, workItemId };
    }

    let missionText: string;
    let workspace: string | null = null;
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
    const revokeSession = (): void => {
      // Resolve the current version from the daemon's own surface: an agent
      // may have renewed while it ran, so assuming the version opened above
      // would turn cleanup into a stale no-op. Revocation is best-effort here;
      // the session's short expiry remains the fail-closed backstop if the
      // surface itself is temporarily unavailable.
      try {
        const surface = config.affordances.readSurface();
        if (surface.outcome !== "SURFACE") return;
        const staffed = surface.steps.find((candidate) =>
          workItemIdFor(candidate.kind, candidate.aggregateId) === workItemId);
        if (staffed?.claim?.claimedBy === sessionId) {
          // Release before closing the bearer. A crashed/failed child must not
          // fence the work item for the rest of the 30-minute claim TTL.
          dispatch(
            secret,
            "work.release",
            { workItemId },
            `work/${workItemId}`,
            staffed.claim.version,
          );
        }
        const aggregateId = `session/${sessionId}`;
        const close = surface.steps.find((candidate) =>
          candidate.kind === "session.close" && candidate.aggregateId === aggregateId);
        if (close?.version === null || close?.version === undefined) return;
        closeSession(close.version);
      } catch { /* expiry still revokes the bearer if cleanup cannot run */ }
    };
    const exit = config.spawnAgent({
      credential: secret, expiresAt, kind: step.kind,
      mission: missionText, sessionId, workItemId, workspace,
    }).catch(() => undefined).then(() => {
      revokeSession();
      active.delete(workItemId);
    });
    active.set(workItemId, exit);
    return { kind: step.kind, outcome: "SPAWNED", sessionId, workItemId };
  };

  const runOnce = (): RunOnceReport => {
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
      spawned.push(staff(step));
    }
    return { active: active.size, spawned, surfaceOutcome: "SURFACE" };
  };

  return Object.freeze({
    activeCount: (): number => active.size,
    runOnce,
    /** Resolves when every currently spawned agent has exited. */
    settle: (): Promise<void> =>
      Promise.all([...active.values()]).then(() => undefined),
  });
}
