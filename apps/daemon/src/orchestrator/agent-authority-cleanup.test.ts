import { describe, expect, it } from "vitest";

import type { AffordancePort } from "../http/affordance-contract.js";
import {
  createAgentAuthorityCleanup,
} from "./agent-authority-cleanup.js";
import type { AgentAuthorityDispatch } from "./agent-authority-cleanup.js";

const SESSION_ID = "session-cleanup-test";
const WORK_ITEM_ID = "policy.install@policy-cleanup-test";
const NOW = Date.UTC(2026, 7, 16, 11, 30);

/**
 * The surface as the daemon lists it: an OPEN session offers BOTH lifecycle
 * steps at the session's current version, and a renewal advances that version.
 */
function authoritySurface(sessionVersion: () => number = () => 9): AffordancePort {
  return {
    boundProjectId: "project-cleanup-test",
    readSurface: () => ({
      nextAllowedCommands: [],
      outcome: "SURFACE",
      steps: [
        {
          aggregateId: "policy-cleanup-test",
          claim: {
            claimedBy: SESSION_ID,
            expiresAt: "2026-08-16T12:00:00.000Z",
            version: 7,
          },
          claimAggregateVersion: 7,
          kind: "policy.install",
          missing: [],
          status: "READY",
          version: 0,
        },
        ...(["session.close", "session.renew"] as const).map((kind) => ({
          aggregateId: `session/${SESSION_ID}`,
          claim: null,
          claimAggregateVersion: 0,
          kind,
          missing: [],
          status: "READY" as const,
          version: sessionVersion(),
        })),
      ],
    }),
  };
}

interface RecordedCall {
  readonly commandId: string | undefined;
  readonly credential: string;
  readonly expectedVersion: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

describe("createAgentAuthorityCleanup", () => {
  it("attempts session closure after all exact-version release attempts fail", () => {
    const calls: Array<{
      readonly commandId: string | undefined;
      readonly credential: string;
      readonly expectedVersion: number;
      readonly kind: string;
    }> = [];
    const dispatch: AgentAuthorityDispatch = (
      credential, kind, _payload, _target, expectedVersion, commandId,
    ) => {
      calls.push({ commandId, credential, expectedVersion, kind });
      return kind === "session.close"
        ? { code: "EFFECTS_COMMITTED", ok: true }
        : { code: "EXPECTED_VERSION_CONFLICT", ok: true };
    };
    const cleanup = createAgentAuthorityCleanup({
      affordances: authoritySurface(), clock: () => NOW, dispatch,
      operatorCredential: "operator", secret: "agent-secret",
      sessionId: SESSION_ID, workItemId: WORK_ITEM_ID,
    });

    expect(cleanup(true).map((error) => error.message)).toEqual([
      "AGENT_CLEANUP_FAILED:work.release:EXPECTED_VERSION_CONFLICT",
    ]);
    expect(calls.map(({ kind }) => kind)).toEqual([
      "work.release", "work.release", "work.release", "session.close",
    ]);
    expect(calls.slice(0, 3).every((call) =>
      call.credential === "agent-secret" && call.expectedVersion === 7)).toBe(true);
    expect(calls[3]).toMatchObject({ credential: "operator", expectedVersion: 9 });
    expect(new Set(calls.map(({ commandId }) => commandId)).size).toBe(4);
  });

  it("retains release and close failures in deterministic order", () => {
    const dispatch: AgentAuthorityDispatch = () => ({
      code: "EXPECTED_VERSION_CONFLICT",
      ok: true,
    });
    const cleanup = createAgentAuthorityCleanup({
      affordances: authoritySurface(), clock: () => NOW, dispatch,
      operatorCredential: "operator", secret: "agent-secret",
      sessionId: SESSION_ID, workItemId: WORK_ITEM_ID,
    });

    expect(cleanup(true).map((error) => error.message)).toEqual([
      "AGENT_CLEANUP_FAILED:session.close:EXPECTED_VERSION_CONFLICT",
      "AGENT_CLEANUP_FAILED:work.release:EXPECTED_VERSION_CONFLICT",
    ]);
  });

  it("revives an expired bearer under the operator and retries the release once revived", () => {
    // The child outlived its session: the first release under the agent's own
    // secret is refused by the authenticator. Live run shape: a renewed claim
    // past the 30-minute session TTL, then exit, then AGENT_CLEANUP_FAILED on
    // every later pass. The bearer is revived under the OPERATOR credential and
    // the retry lands under the agent's secret, so the ledger still names the
    // agent as the releasing principal.
    const calls: RecordedCall[] = [];
    let sessionVersion = 9;
    let bearerAlive = false;
    const dispatch: AgentAuthorityDispatch = (
      credential, kind, payload, _target, expectedVersion, commandId,
    ) => {
      calls.push({ commandId, credential, expectedVersion, kind, payload });
      if (kind === "work.release") {
        return bearerAlive
          ? { code: "EFFECTS_COMMITTED", ok: true }
          : { code: "AUTHENTICATION_FAILED", ok: false };
      }
      if (kind === "session.renew") {
        if (credential !== "operator") return { code: "CAPABILITY_DENIED", ok: false };
        bearerAlive = true;
        sessionVersion += 1;
        return { code: "EFFECTS_COMMITTED", ok: true };
      }
      return { code: "EFFECTS_COMMITTED", ok: true };
    };
    const cleanup = createAgentAuthorityCleanup({
      affordances: authoritySurface(() => sessionVersion), clock: () => NOW, dispatch,
      operatorCredential: "operator", secret: "agent-secret",
      sessionId: SESSION_ID, workItemId: WORK_ITEM_ID,
    });

    expect(cleanup(true)).toEqual([]);
    expect(calls.map(({ credential, kind }) => `${kind}:${credential}`)).toEqual([
      "work.release:agent-secret",
      "session.renew:operator",
      "work.release:agent-secret",
      "session.close:operator",
    ]);
    // The revival is short and fresh off the wrapper's clock, at the session's
    // CURRENT version; the close that follows reads the renewed version back.
    expect(calls[1]).toMatchObject({
      expectedVersion: 9,
      payload: { expiresAt: new Date(NOW + 60_000).toISOString(), sessionId: SESSION_ID },
    });
    expect(calls[2]).toMatchObject({ expectedVersion: 7 });
    expect(calls[3]).toMatchObject({ expectedVersion: 10 });
    expect(new Set(calls.map(({ commandId }) => commandId)).size).toBe(4);
  });

  it("revives only the authenticator's refusal, never any other release refusal", () => {
    const kinds: string[] = [];
    const dispatch: AgentAuthorityDispatch = (_credential, kind) => {
      kinds.push(kind);
      return kind === "session.close"
        ? { code: "EFFECTS_COMMITTED", ok: true }
        : { code: "CAPABILITY_DENIED", ok: false };
    };
    const cleanup = createAgentAuthorityCleanup({
      affordances: authoritySurface(), clock: () => NOW, dispatch,
      operatorCredential: "operator", secret: "agent-secret",
      sessionId: SESSION_ID, workItemId: WORK_ITEM_ID,
    });

    expect(cleanup(true).map((error) => error.message)).toEqual([
      "AGENT_CLEANUP_FAILED:work.release:CAPABILITY_DENIED",
    ]);
    expect(kinds).not.toContain("session.renew");
  });

  it("fails the release closed, naming the revival's refusal, when the bearer cannot be revived", () => {
    const kinds: string[] = [];
    const dispatch: AgentAuthorityDispatch = (_credential, kind) => {
      kinds.push(kind);
      if (kind === "session.close") return { code: "EFFECTS_COMMITTED", ok: true };
      if (kind === "session.renew") return { code: "SESSION_ALREADY_CLOSED", ok: true };
      return { code: "AUTHENTICATION_FAILED", ok: false };
    };
    const cleanup = createAgentAuthorityCleanup({
      affordances: authoritySurface(), clock: () => NOW, dispatch,
      operatorCredential: "operator", secret: "agent-secret",
      sessionId: SESSION_ID, workItemId: WORK_ITEM_ID,
    });

    expect(cleanup(true).map((error) => error.message)).toEqual([
      "AGENT_CLEANUP_FAILED:work.release:SESSION_ALREADY_CLOSED",
    ]);
    expect(kinds).toEqual([
      "work.release", "session.renew", "work.release", "session.renew",
      "work.release", "session.renew", "session.close",
    ]);
  });
});
