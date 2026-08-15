import { describe, expect, it } from "vitest";

import type { AffordancePort } from "../http/affordance-contract.js";
import {
  createAgentAuthorityCleanup,
} from "./agent-authority-cleanup.js";
import type { AgentAuthorityDispatch } from "./agent-authority-cleanup.js";

const SESSION_ID = "session-cleanup-test";
const WORK_ITEM_ID = "policy.install@policy-cleanup-test";

function authoritySurface(): AffordancePort {
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
        {
          aggregateId: `session/${SESSION_ID}`,
          claim: null,
          claimAggregateVersion: 0,
          kind: "session.close",
          missing: [],
          status: "READY",
          version: 9,
        },
      ],
    }),
  };
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
      affordances: authoritySurface(), dispatch,
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
      affordances: authoritySurface(), dispatch,
      operatorCredential: "operator", secret: "agent-secret",
      sessionId: SESSION_ID, workItemId: WORK_ITEM_ID,
    });

    expect(cleanup(true).map((error) => error.message)).toEqual([
      "AGENT_CLEANUP_FAILED:session.close:EXPECTED_VERSION_CONFLICT",
      "AGENT_CLEANUP_FAILED:work.release:EXPECTED_VERSION_CONFLICT",
    ]);
  });
});
