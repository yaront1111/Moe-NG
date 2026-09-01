import type { DatabaseSync } from "node:sqlite";

import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import {
  RESUME_PROJECT, RESUME_PROJECTION, RESUME_SECOND_CREDENTIAL, RESUME_SECOND_PRINCIPAL,
  RESUME_SESSION_CREDENTIAL, RESUME_SESSION_PRINCIPAL, RESUME_SUBSCRIBER,
  RESUME_WORK_CREDENTIAL, RESUME_WORK_PRINCIPAL, advance, callResumeTool, cursorDoc,
  grantedSubscriberFor, mintSession, openMcpSession, resumeArguments, withResumeHarness,
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

/**
 * The two fences a resume can hit once the request itself is well formed. They are asserted
 * as PAIRS because code alone is not the contract: the layer says which component refused,
 * and the foreign-session arm is only meaningful while these two pairs stay distinct.
 */
const AUTHORITY_FENCE = Object.freeze({
  code: "EVENT_STREAM_RESUME_OPERATOR_AUTHORITY_REQUIRED",
  layer: "DAEMON_AUTHORIZATION",
});
const SUBSCRIBER_FENCE = Object.freeze({
  code: "EVENT_STREAM_RESUME_SESSION_MISMATCH",
  layer: "DAEMON_EVENT_STREAM_RESUME",
});

/** The stored receipt for one commandId, or null. The decision key is the SESSION principal. */
function decisionFor(
  store: SqliteEventStore,
  commandId: string,
  principalId: string = RESUME_SESSION_PRINCIPAL,
): unknown {
  return store.getCommandDecision({ commandId, principalId, projectId: RESUME_PROJECT });
}

/** The observed refusal reduced to the pair the fences are identified by. */
function fenceOf(answer: Record<string, unknown> | null): Record<string, unknown> {
  const refusal = (answer ?? {})["refusal"] as Record<string, unknown> | undefined;
  return { code: refusal?.["code"], layer: refusal?.["layer"] };
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

  it("refuses a work.write-only session at the operator-authority fence", TIMEOUT, async () => {
    await withResumeHarness(async (harness, origin) => {
      // DoD 4 was rewritten to operator authority precisely BECAUSE production refuses this
      // session. This arm exists so the rewrite can never be read as admitting a work.write
      // resume: weaken the capability check and this reddens.
      mintSession(
        harness.store, ["work.write"], RESUME_WORK_CREDENTIAL, RESUME_WORK_PRINCIPAL,
      );
      const sessionId = await openMcpSession(harness.host, origin, RESUME_WORK_CREDENTIAL);
      const before = cursorDoc(harness.database);

      const refused = await callResumeTool(
        harness.host, origin, resumeArguments("mcp-resume-workwrite", harness.issuedCursor),
        { bearer: RESUME_WORK_CREDENTIAL, sessionId },
      );

      expect(fenceOf(refused.answer)).toEqual(AUTHORITY_FENCE);
      expect(refused.answer).toMatchObject({
        httpStatus: 403, ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
      });
      // Production grants this principal no reader at all, which is why it never reaches
      // the subscriber fence.
      expect(grantedSubscriberFor(harness.store, RESUME_WORK_PRINCIPAL, ["work.write"]))
        .toBeUndefined();
      expect(cursorDoc(harness.database)).toBe(before);
      expect(decisionFor(harness.store, "mcp-resume-workwrite", RESUME_WORK_PRINCIPAL))
        .toBeNull();
    });
  });

  it("refuses a second operator session presenting the first session's subscriber", TIMEOUT,
    async () => {
      await withResumeHarness(async (harness, origin) => {
        // The second session carries OPERATOR capabilities on purpose. Minting it with
        // ["work.write"] would be answered by the authority fence above and the subscriber
        // fence under test would never run - a downstream fence answering for the mechanism.
        mintSession(
          harness.store, OPERATOR_CAPABILITIES, RESUME_SECOND_CREDENTIAL, RESUME_SECOND_PRINCIPAL,
        );

        // The premise, read out of the PRODUCTION resolver: the two principals are granted
        // DIFFERENT readers. Without this divergence the arm below could not distinguish a
        // foreign subscriber from an unknown one.
        const firstGrant = grantedSubscriberFor(harness.store, RESUME_SESSION_PRINCIPAL);
        const secondGrant = grantedSubscriberFor(harness.store, RESUME_SECOND_PRINCIPAL);
        expect(firstGrant).toBe(RESUME_SUBSCRIBER);
        expect(secondGrant).toBe(`reader:${RESUME_SECOND_PRINCIPAL}`);
        expect(secondGrant).not.toBe(firstGrant);

        // The call travels on the SECOND session's OWN credential and its OWN MCP session id,
        // and asks for the FIRST session's granted subscriber.
        const sessionId = await openMcpSession(harness.host, origin, RESUME_SECOND_CREDENTIAL);
        const before = cursorDoc(harness.database);

        const refused = await callResumeTool(
          harness.host, origin, resumeArguments("mcp-resume-foreign", harness.issuedCursor),
          { bearer: RESUME_SECOND_CREDENTIAL, sessionId },
        );

        expect(fenceOf(refused.answer)).toEqual(SUBSCRIBER_FENCE);
        // Explicitly NOT the authority fence: if the two ever converge this arm would
        // silently become a second copy of the work.write arm above.
        expect(fenceOf(refused.answer)).not.toEqual(AUTHORITY_FENCE);
        expect(refused.answer).toMatchObject({
          ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
        });
        expect(cursorDoc(harness.database)).toBe(before);
        expect(decisionFor(harness.store, "mcp-resume-foreign", RESUME_SECOND_PRINCIPAL))
          .toBeNull();
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
