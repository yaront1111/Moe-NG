import { createHash } from "node:crypto";

import type { JsonObject } from "@moe/contracts";

import type { AffordancePort, AffordanceSurface } from "../http/affordance-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";

const CLEANUP_ATTEMPTS = 3;
/**
 * The adapter's refusal for a bearer the authenticator no longer recognises
 * (http-contract.ts HTTP_BOUNDARY_ERROR_CODES): expired, closed, or unknown.
 * Only the expired case is revivable, and only this code names it.
 */
const BEARER_UNAUTHENTICATED = "AUTHENTICATION_FAILED";
/**
 * How long a revived bearer lives: enough for the release retry that follows,
 * never long enough to matter if the close after it were refused too.
 */
const REVIVAL_TTL_MS = 60_000;

interface CommandOutcome {
  readonly code: string;
  readonly ok: boolean;
}

export type AgentAuthorityDispatch = (
  credential: string,
  kind: string,
  payload: JsonObject,
  target: string,
  expectedVersion: number,
  commandId?: string,
) => CommandOutcome;

export interface AgentAuthorityCleanupConfig {
  readonly affordances: AffordancePort;
  /** The clock every wrapper TTL is minted against; a revival expiry comes from the same one. */
  readonly clock: () => number;
  readonly dispatch: AgentAuthorityDispatch;
  readonly operatorCredential: string;
  readonly secret: string;
  readonly sessionId: string;
  readonly workItemId: string;
}

export type AgentAuthorityCleanup = (releaseClaim: boolean) => readonly Error[];

function cleanupError(action: string, outcome: string): Error {
  return new Error(`AGENT_CLEANUP_FAILED:${action}:${outcome}`);
}

function errorOf(value: unknown): Error {
  return value instanceof Error && value.message.startsWith("AGENT_CLEANUP_FAILED:")
    ? value
    : cleanupError("unknown", "UNEXPECTED_ERROR");
}

/**
 * Builds one best-effort authority reaper for a minted agent identity. Claim
 * release and session closure are deliberately independent: even a stale or
 * refused release must not leave the bearer usable until its TTL expires.
 *
 * The release runs under the AGENT'S secret so the ledger names the agent as
 * the releasing principal. That bearer can be dead by the time the child
 * exits: the agent renews its claim past the session TTL, or the process
 * simply outlives it. The adapter then refuses every release with the
 * authenticator's code, and without recovery the failure would pin the wrapper
 * idle on AGENT_CLEANUP_FAILED for good. So one refusal of exactly that code
 * revives the bearer briefly under the operator credential (session.renew is
 * in the ADMIN family) and lets the next attempt retry; the close that follows
 * revokes it again. No other refusal is revived, and a dead bearer that cannot
 * be revived still fails the release closed.
 */
export function createAgentAuthorityCleanup(
  config: AgentAuthorityCleanupConfig,
): AgentAuthorityCleanup {
  const aggregateId = `session/${config.sessionId}`;
  const commandId = (action: string, attempt: number, version: number): string =>
    `wrap-${createHash("sha256").update(JSON.stringify([
      config.secret,
      config.sessionId,
      config.workItemId,
      action,
      attempt,
      version,
    ])).digest("hex").slice(0, 32)}`;

  /** The session's own lifecycle step of one kind; absent once the session is closed. */
  const sessionStep = (
    surface: AffordanceSurface, kind: "session.close" | "session.renew",
  ): AffordanceSurface["steps"][number] | undefined =>
    surface.steps.find((candidate) =>
      candidate.kind === kind && candidate.aggregateId === aggregateId);

  /**
   * Revives an expired bearer for the release retry. Returns null on a
   * committed renewal and the refusing code otherwise, so the caller's outcome
   * names the last thing that actually refused.
   */
  const reviveBearer = (surface: AffordanceSurface, attempt: number): string | null => {
    const renew = sessionStep(surface, "session.renew");
    if (renew === undefined) return "SESSION_NOT_VISIBLE";
    if (renew.version === null) return "SESSION_VERSION_NOT_VISIBLE";
    let renewed: CommandOutcome;
    try {
      renewed = config.dispatch(
        config.operatorCredential,
        "session.renew",
        {
          expiresAt: new Date(config.clock() + REVIVAL_TTL_MS).toISOString(),
          sessionId: config.sessionId,
        },
        aggregateId,
        renew.version,
        commandId("session.renew", attempt, renew.version),
      );
    } catch {
      return "COMMAND_DISPATCH_FAILED";
    }
    return renewed.ok && renewed.code === "EFFECTS_COMMITTED" ? null : renewed.code;
  };

  const closeSession = (): void => {
    let outcome = "SESSION_NOT_VISIBLE";
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      let surface: ReturnType<AffordancePort["readSurface"]>;
      try {
        surface = config.affordances.readSurface();
      } catch {
        outcome = "SURFACE_READ_FAILED";
        continue;
      }
      if (surface.outcome !== "SURFACE") {
        outcome = surface.code;
        continue;
      }
      const close = sessionStep(surface, "session.close");
      if (close === undefined) return;
      if (close.version === null) {
        outcome = "SESSION_VERSION_NOT_VISIBLE";
        continue;
      }
      let closed: CommandOutcome;
      try {
        closed = config.dispatch(
          config.operatorCredential,
          "session.close",
          { sessionId: config.sessionId },
          aggregateId,
          close.version,
          commandId("session.close", attempt, close.version),
        );
      } catch {
        outcome = "COMMAND_DISPATCH_FAILED";
        continue;
      }
      if (closed.ok && closed.code === "EFFECTS_COMMITTED") return;
      outcome = closed.code;
    }
    throw cleanupError("session.close", outcome);
  };

  const releaseClaim = (): void => {
    let outcome = "WORK_ITEM_NOT_VISIBLE";
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      let surface: ReturnType<AffordancePort["readSurface"]>;
      try {
        surface = config.affordances.readSurface();
      } catch {
        outcome = "SURFACE_READ_FAILED";
        continue;
      }
      if (surface.outcome !== "SURFACE") {
        outcome = surface.code;
        continue;
      }
      const staffed = surface.steps.find((candidate) =>
        workItemIdFor(candidate.kind, candidate.aggregateId) === config.workItemId);
      if (staffed === undefined) continue;
      if (staffed.claim === null || staffed.claim.claimedBy !== config.sessionId) return;
      let released: CommandOutcome;
      try {
        released = config.dispatch(
          config.secret,
          "work.release",
          { workItemId: config.workItemId },
          `work/${config.workItemId}`,
          staffed.claim.version,
          commandId("work.release", attempt, staffed.claim.version),
        );
      } catch {
        outcome = "COMMAND_DISPATCH_FAILED";
        continue;
      }
      if (released.ok && released.code === "EFFECTS_COMMITTED") return;
      outcome = released.code;
      // The retry is the NEXT attempt, not an inline repeat: it re-reads the
      // surface and earns a fresh command id, and a revival on the final
      // attempt has no retry left and fails closed like any other refusal.
      if (!released.ok && released.code === BEARER_UNAUTHENTICATED) {
        outcome = reviveBearer(surface, attempt) ?? outcome;
      }
    }
    throw cleanupError("work.release", outcome);
  };

  return (releaseClaimFirst: boolean): readonly Error[] => {
    const failures: Error[] = [];
    if (releaseClaimFirst) {
      try { releaseClaim(); } catch (error) { failures.push(errorOf(error)); }
    }
    try { closeSession(); } catch (error) { failures.push(errorOf(error)); }
    return failures.sort((a, b) =>
      a.message < b.message ? -1 : a.message > b.message ? 1 : 0);
  };
}
