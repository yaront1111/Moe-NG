import { createHash } from "node:crypto";

import type { JsonObject } from "@moe/contracts";

import type { AffordancePort } from "../http/affordance-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";

const CLEANUP_ATTEMPTS = 3;

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
 */
export function createAgentAuthorityCleanup(
  config: AgentAuthorityCleanupConfig,
): AgentAuthorityCleanup {
  const commandId = (action: string, attempt: number, version: number): string =>
    `wrap-${createHash("sha256").update(JSON.stringify([
      config.secret,
      config.sessionId,
      config.workItemId,
      action,
      attempt,
      version,
    ])).digest("hex").slice(0, 32)}`;

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
      const aggregateId = `session/${config.sessionId}`;
      const close = surface.steps.find((candidate) =>
        candidate.kind === "session.close" && candidate.aggregateId === aggregateId);
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
