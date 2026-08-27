import type { DatabaseSync } from "node:sqlite";

import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  RESUME_PROJECT, RESUME_PROJECTION, RESUME_SESSION_CREDENTIAL, RESUME_SESSION_PRINCIPAL,
  RESUME_SUBSCRIBER, advance, callResumeTool, cursorDoc, mintSession, openMcpSession,
  resumeArguments, withResumeHarness,
} from "./event-resume-mcp-fixtures.js";

/**
 * DoD-4 and DoD-5, driven through the REAL MCP HTTP host: a started listener, `initialize`,
 * `tools/call`, the generated `events_resume` schema, daemon authentication, the production
 * command registry, the durable decision table and live subscription state. No mock stands in
 * for any of those; the only test-owned code opens the store and reads rows back to assert on.
 *
 * Every refusal arm asserts THREE things: the exact reason code, the exact refusing LAYER or
 * stage, and that the durable stream state did not move — cursor document byte-equal and no
 * command decision recorded for the refused commandId. A refusal that quietly reseated the
 * subscriber would pass a code-only assertion.
 */

const TIMEOUT = { timeout: 60_000 } as const;

/** The stored receipt for one commandId, or null. The decision key is the SESSION principal. */
function decisionFor(store: SqliteEventStore, commandId: string): unknown {
  return store.getCommandDecision({
    commandId, principalId: RESUME_SESSION_PRINCIPAL, projectId: RESUME_PROJECT,
  });
}

/** The refusal must not have moved durable stream state. */
function expectNoStreamMutation(
  database: DatabaseSync,
  store: SqliteEventStore,
  before: string | null,
  commandId: string,
): void {
  expect(cursorDoc(database)).toBe(before);
  expect(decisionFor(store, commandId)).toBeNull();
}

describe("task-4dd05f0c events.resume over the real MCP host", () => {
  it("reseats a gapped subscriber once and preserves the receipt on retry", TIMEOUT, async () => {
    await withResumeHarness(async (harness, origin) => {
      const sessionId = await openMcpSession(harness.host, origin);
      const call = { bearer: RESUME_SESSION_CREDENTIAL, sessionId };
      const args = resumeArguments("mcp-resume-once", harness.issuedCursor);

      const first = await callResumeTool(harness.host, origin, args, call);

      expect(first.answer).toMatchObject({
        decision: {
          commandId: "mcp-resume-once", disposition: "DECIDED",
          resultCode: "EFFECTS_COMMITTED",
        },
        ok: true,
        outcome: "ACCEPTED",
      });
      const decision = (first.answer ?? {})["decision"] as Record<string, unknown>;
      expect(JSON.parse(cursorDoc(harness.database) ?? "null")).toMatchObject({
        cursor: harness.issuedCursor, projection: RESUME_PROJECTION,
      });
      expect(decisionFor(harness.store, "mcp-resume-once")).not.toBeNull();

      // A second generation makes a SECOND reseat observable: if the retry reseated, the
      // cursor document would move to the new generation instead of staying byte-equal.
      advance(harness.database, "prove the identical retry does not reseat");
      const beforeRetry = cursorDoc(harness.database);
      const retry = await callResumeTool(harness.host, origin, args, call);

      expect(retry.answer).toMatchObject({
        decision: {
          commandId: "mcp-resume-once",
          disposition: "REPLAYED",
          effectId: decision["effectId"],
          resultCode: "EFFECTS_COMMITTED",
        },
        ok: true,
        outcome: "ACCEPTED",
      });
      expect(cursorDoc(harness.database)).toBe(beforeRetry);
    });
  });

  it("refuses a tools/call carrying no Authorization header", TIMEOUT, async () => {
    await withResumeHarness(async (harness, origin) => {
      const sessionId = await openMcpSession(harness.host, origin);
      const before = cursorDoc(harness.database);

      const refused = await callResumeTool(
        harness.host, origin, resumeArguments("mcp-resume-noauth", harness.issuedCursor),
        { sessionId },
      );

      expect(refused.status).toBe(401);
      expect(refused.answer).toBeNull();
      expect((refused.rpc["error"] as Record<string, unknown>)["code"]).toBe(-32001);
      expect((refused.rpc["error"] as Record<string, unknown>)["data"]).toMatchObject({
        code: "AUTHENTICATION_FAILED",
        recoveryCategory: "REAUTHENTICATE",
        transport: { category: "UNAUTHENTICATED", httpStatus: 401, mcpCode: -32001 },
        truthClass: "DAEMON_VERIFIED",
      });
      expectNoStreamMutation(
        harness.database, harness.store, before, "mcp-resume-noauth",
      );
    });
  });

  it("refuses a tools/call carrying a bearer no session ever minted", TIMEOUT, async () => {
    await withResumeHarness(async (harness, origin) => {
      const sessionId = await openMcpSession(harness.host, origin);
      const before = cursorDoc(harness.database);

      const refused = await callResumeTool(
        harness.host, origin, resumeArguments("mcp-resume-wrong-bearer", harness.issuedCursor),
        { bearer: "forged-session-credential", sessionId },
      );

      expect(refused.status).toBe(401);
      expect(refused.answer).toBeNull();
      expect((refused.rpc["error"] as Record<string, unknown>)["data"]).toMatchObject({
        code: "AUTHENTICATION_FAILED",
        transport: { category: "UNAUTHENTICATED", httpStatus: 401, mcpCode: -32001 },
      });
      expectNoStreamMutation(
        harness.database, harness.store, before, "mcp-resume-wrong-bearer",
      );
    });
  });

  it("refuses a malformed presented cursor under the resume layer", TIMEOUT, async () => {
    await withResumeHarness(async (harness, origin) => {
      const sessionId = await openMcpSession(harness.host, origin);
      const before = cursorDoc(harness.database);

      const refused = await callResumeTool(
        harness.host, origin,
        resumeArguments("mcp-resume-malformed", harness.issuedCursor, {
          payload: {
            presentedCursor: "not-a-cursor",
            projection: RESUME_PROJECTION,
            subscriberId: RESUME_SUBSCRIBER,
          },
        }),
        { bearer: RESUME_SESSION_CREDENTIAL, sessionId },
      );

      expect(refused.answer).toMatchObject({
        httpStatus: 422,
        ok: false,
        outcome: "PORT_REFUSED",
        refusal: {
          code: "EVENT_STREAM_RESUME_INPUT_INVALID",
          httpStatus: 422,
          layer: "DAEMON_EVENT_STREAM_RESUME",
        },
        stage: "DISPATCH",
      });
      expectNoStreamMutation(
        harness.database, harness.store, before, "mcp-resume-malformed",
      );
    });
  });

  it("refuses an extra payload key at the registry payload-shape gate", TIMEOUT, async () => {
    await withResumeHarness(async (harness, origin) => {
      const sessionId = await openMcpSession(harness.host, origin);
      const before = cursorDoc(harness.database);

      const refused = await callResumeTool(
        harness.host, origin,
        resumeArguments("mcp-resume-extra-key", harness.issuedCursor, {
          payload: {
            extra: 1,
            presentedCursor: harness.issuedCursor,
            projection: RESUME_PROJECTION,
            subscriberId: RESUME_SUBSCRIBER,
          },
        }),
        { bearer: RESUME_SESSION_CREDENTIAL, sessionId },
      );

      // A DIFFERENT layer from the malformed arm above: the registry refuses on key shape
      // BEFORE the resume edge ever runs, so the code and stage must both differ.
      expect(refused.answer).toMatchObject({
        error: {
          code: "INPUT_INVALID",
          transport: { category: "REQUEST_INVALID", httpStatus: 400, mcpCode: -32602 },
        },
        httpStatus: 400,
        ok: false,
        outcome: "REFUSED",
        stage: "PAYLOAD_SHAPE",
      });
      expect((refused.answer ?? {})["refusal"]).toBeUndefined();
      expectNoStreamMutation(
        harness.database, harness.store, before, "mcp-resume-extra-key",
      );
    });
  });

  it("refuses a subscriber this session was never granted", TIMEOUT, async () => {
    await withResumeHarness(async (harness, origin) => {
      // A second live session exists, so the refusal cannot be "no other session was minted".
      mintSession(
        harness.store, ["work.write"], "second-session-credential", "second-session",
      );
      const sessionId = await openMcpSession(harness.host, origin);
      const before = cursorDoc(harness.database);

      const refused = await callResumeTool(
        harness.host, origin,
        resumeArguments("mcp-resume-foreign", harness.issuedCursor, {
          payload: {
            presentedCursor: harness.issuedCursor,
            projection: RESUME_PROJECTION,
            subscriberId: "second-session-subscriber",
          },
          targetAggregateId: "second-session-subscriber",
        }),
        { bearer: RESUME_SESSION_CREDENTIAL, sessionId },
      );

      expect(refused.answer).toMatchObject({
        ok: false,
        outcome: "PORT_REFUSED",
        refusal: {
          code: "EVENT_STREAM_RESUME_SESSION_MISMATCH",
          layer: "DAEMON_EVENT_STREAM_RESUME",
        },
        stage: "DISPATCH",
      });
      expectNoStreamMutation(
        harness.database, harness.store, before, "mcp-resume-foreign",
      );
    });
  });

  it("refuses a changed request under one command identity and keeps the receipt", TIMEOUT,
    async () => {
      await withResumeHarness(async (harness, origin) => {
        const sessionId = await openMcpSession(harness.host, origin);
        const call = { bearer: RESUME_SESSION_CREDENTIAL, sessionId };
        const commandId = "mcp-resume-conflict";
        const accepted = await callResumeTool(
          harness.host, origin, resumeArguments(commandId, harness.issuedCursor), call,
        );
        expect(accepted.answer).toMatchObject({ ok: true, outcome: "ACCEPTED" });
        const firstStored = decisionFor(harness.store, commandId);
        expect(firstStored).not.toBeNull();
        const before = cursorDoc(harness.database);

        const changed = await callResumeTool(
          harness.host, origin,
          resumeArguments(commandId, {
            ...harness.issuedCursor,
            position: (BigInt(harness.issuedCursor.position) + 1n).toString(),
          }),
          call,
        );

        expect(changed.answer).toMatchObject({
          httpStatus: 409,
          ok: false,
          outcome: "PORT_REFUSED",
          refusal: {
            code: "EVENT_STREAM_RESUME_IDEMPOTENCY_CONFLICT",
            layer: "DAEMON_EVENT_STREAM_RESUME",
          },
          stage: "DISPATCH",
        });
        // The receipt for the accepted call survives BYTE-IDENTICAL and no reseat happened.
        expect(cursorDoc(harness.database)).toBe(before);
        expect(decisionFor(harness.store, commandId)).toEqual(firstStored);
      });
    });
});
