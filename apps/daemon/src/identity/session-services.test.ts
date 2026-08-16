import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { SESSION_COMMAND_KINDS } from "./session-contracts.js";
import { readSessionLedger } from "./session-ledger.js";
import { runSessionCommand } from "./session-services.js";
import {
  CREDENTIAL,
  EXPIRES_AT,
  OPENER,
  PROJECT_ID,
  SESSION_ID,
  TEST_RECOVERY_INCARNATION_REF,
  TEST_RECOVERY_KEY_EPOCH_REF,
  closeStores,
  commitRaw,
  envelope,
  hashOf,
  openDefaultSession,
  openPayload,
  openStore,
  openUnboundStore,
  send,
} from "./session-test-fixtures.js";

/**
 * Durable session lifecycle commands. Three layers can refuse — ingress, the daemon's durable
 * prerequisite gate, and the store — so every refusal case pins the stable code AND the layer
 * that produced it; "it refused" alone would go vacuous the moment an earlier layer starts
 * answering first.
 */

afterEach(closeStores);

function refusalOf(outcome: ReturnType<typeof send>): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected refusal, got acceptance");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

describe("session command vocabulary", () => {
  it("covers exactly the three kinds this surface owns", () => {
    expect(new Set<string>(SESSION_COMMAND_KINDS)).toEqual(
      new Set(["session.close", "session.open", "session.renew"]),
    );
    expect(SESSION_COMMAND_KINDS).toHaveLength(3);
  });

  it("names only kinds the runtime command vocabulary already declares", () => {
    const vocabulary = new Set<string>(RUNTIME_COMMAND_KINDS);
    expect(SESSION_COMMAND_KINDS.filter((kind) => !vocabulary.has(kind))).toEqual([]);
  });
});

describe("session.open", () => {
  it("commits one durable decision and folds an OPEN record holding only the hash", () => {
    const store = openStore();
    const outcome = openDefaultSession(store);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.authority).toBe("DURABLE_DECISION");

    const ledger = readSessionLedger(store, PROJECT_ID);
    const record = ledger.sessions.get(SESSION_ID);
    expect(record).toEqual({
      capabilities: ["review.submit", "work.claim"],
      credentialSha256: hashOf(CREDENTIAL),
      expiresAt: EXPIRES_AT,
      keyEpochRef: TEST_RECOVERY_KEY_EPOCH_REF,
      principalId: OPENER,
      recoveryIncarnationRef: TEST_RECOVERY_INCARNATION_REF,
      sessionId: SESSION_ID,
      status: "OPEN",
      version: 1,
    });
    // The plaintext credential must appear NOWHERE in the durably stored result.
    expect(Buffer.from(outcome.decision.resultBytes).toString("utf8")).not.toContain(CREDENTIAL);
  });

  it("refuses opening when the selected recovery binding is unavailable", () => {
    const store = openUnboundStore();
    expect(refusalOf(send(store, envelope("session.open", 0, openPayload())))).toEqual({
      code: "SESSION_RECOVERY_BINDING_UNAVAILABLE",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("replays the same commandId as REPLAYED without a second decision", () => {
    const store = openStore();
    openDefaultSession(store, {}, "cmd-open-1");
    const replay = send(store, envelope("session.open", 0, openPayload(), "cmd-open-1"));

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay acceptance");
    expect(replay.disposition).toBe("REPLAYED");
    expect(readSessionLedger(store, PROJECT_ID).decisionCount).toBe(1);
  });

  it("refuses a commandId reused under a different kind with SESSION_COMMAND_ID_REUSED", () => {
    const store = openStore();
    openDefaultSession(store, {}, "cmd-shared");
    const outcome = send(
      store,
      envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-shared"),
    );
    expect(refusalOf(outcome)).toEqual({
      code: "SESSION_COMMAND_ID_REUSED",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("refuses re-opening an OPEN session id with SESSION_ALREADY_OPEN", () => {
    const store = openStore();
    openDefaultSession(store);
    const outcome = send(store, envelope("session.open", 0, openPayload(), "cmd-open-again"));
    expect(refusalOf(outcome)).toEqual({
      code: "SESSION_ALREADY_OPEN",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("refuses re-opening a CLOSED session id with SESSION_ALREADY_CLOSED", () => {
    const store = openStore();
    openDefaultSession(store);
    send(store, envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-close-1"));
    const outcome = send(store, envelope("session.open", 0, openPayload(), "cmd-reopen"));
    expect(refusalOf(outcome)).toEqual({
      code: "SESSION_ALREADY_CLOSED",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("refuses malformed payload facts by their own ingress codes", () => {
    const store = openStore();
    const cases = [
      ["SESSION_PAYLOAD_INVALID", openPayload({ sessionId: "" })],
      ["SESSION_PAYLOAD_INVALID", openPayload({ capabilities: "work.claim" })],
      ["SESSION_PAYLOAD_INVALID", openPayload({ capabilities: [""] })],
      ["SESSION_CREDENTIAL_HASH_INVALID", openPayload({ credentialSha256: "ABC123" })],
      ["SESSION_CREDENTIAL_HASH_INVALID", openPayload({ credentialSha256: hashOf("x").toUpperCase() })],
      ["SESSION_EXPIRED_AT_INVALID", openPayload({ expiresAt: "not-a-date" })],
      // Date.parse accepts all three of these, but their instant depends on the
      // HOST timezone — a session must not expire at a different moment because
      // the daemon moved machines. Only the canonical zoned instant is a value.
      ["SESSION_EXPIRED_AT_INVALID", openPayload({ expiresAt: "2027-01-01T00:00:00" })],
      ["SESSION_EXPIRED_AT_INVALID", openPayload({ expiresAt: "2027-01-01" })],
      ["SESSION_EXPIRED_AT_INVALID", openPayload({ expiresAt: "January 1 2027" })],
    ] as const;
    for (const [index, [code, payload]] of cases.entries()) {
      const outcome = send(store, envelope("session.open", 0, payload, `cmd-p-${index}`));
      expect(refusalOf(outcome)).toEqual({ code, refusedBy: "DAEMON_INGRESS" });
    }
  });

  it("refuses a session id that collides with a reserved principal namespace", () => {
    // The WORKING principal of a session IS its session id (authenticator). If a
    // caller could open a session whose id equals the operator principal, work
    // claimed under it would be attributed to the operator. Reserve that id.
    const store = openStore();
    for (const [sessionId, commandId] of [
      ["operator-local", "cmd-reserved-operator"],
      ["daemon:node-verifier", "cmd-reserved-verifier"],
    ] as const) {
      const outcome = send(
        store,
        envelope("session.open", 0, openPayload({ sessionId }), commandId),
        ["operator-local", "daemon:node-verifier"],
      );
      expect(refusalOf(outcome)).toEqual({
        code: "SESSION_ID_RESERVED",
        refusedBy: "DAEMON_INGRESS",
      });
    }
    // A different session id under the same reservation still opens.
    const ok = send(
      store,
      envelope("session.open", 0, openPayload({ sessionId: "sess-agent-9" }), "cmd-ok"),
      ["operator-local", "daemon:node-verifier"],
    );
    expect(ok.ok).toBe(true);
  });

  it("refuses a stale expected version with SESSION_EXPECTED_VERSION_STALE", () => {
    const store = openStore();
    const outcome = send(store, envelope("session.open", 3, openPayload(), "cmd-stale-open"));
    expect(refusalOf(outcome)).toEqual({
      code: "SESSION_EXPECTED_VERSION_STALE",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });
});

describe("session.close and session.renew", () => {
  it("refuses closing an unknown session with SESSION_NOT_FOUND", () => {
    const store = openStore();
    const outcome = send(store, envelope("session.close", 0, { sessionId: "ghost" }, "cmd-ghost"));
    expect(refusalOf(outcome)).toEqual({
      code: "SESSION_NOT_FOUND",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("closes an open session, then refuses a second close with SESSION_ALREADY_CLOSED", () => {
    const store = openStore();
    openDefaultSession(store);
    const closed = send(store, envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-c1"));
    expect(closed.ok).toBe(true);
    expect(readSessionLedger(store, PROJECT_ID).sessions.get(SESSION_ID)?.status).toBe("CLOSED");

    const again = send(store, envelope("session.close", 2, { sessionId: SESSION_ID }, "cmd-c2"));
    expect(refusalOf(again)).toEqual({
      code: "SESSION_ALREADY_CLOSED",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });

  it("renew extends the folded expiry and nothing else", () => {
    const store = openStore();
    openDefaultSession(store);
    const later = "2026-08-10T12:00:00.000Z";
    const renewed = send(
      store,
      envelope("session.renew", 1, { expiresAt: later, sessionId: SESSION_ID }, "cmd-r1"),
    );
    expect(renewed.ok).toBe(true);
    const record = readSessionLedger(store, PROJECT_ID).sessions.get(SESSION_ID);
    expect(record?.expiresAt).toBe(later);
    expect(record?.status).toBe("OPEN");
    expect(record?.credentialSha256).toBe(hashOf(CREDENTIAL));
    expect(record?.version).toBe(2);
  });

  it("refuses renewing an unknown or closed session by its own codes", () => {
    const store = openStore();
    const unknown = send(
      store,
      envelope("session.renew", 0, { expiresAt: EXPIRES_AT, sessionId: "ghost" }, "cmd-rg"),
    );
    expect(refusalOf(unknown).code).toBe("SESSION_NOT_FOUND");

    openDefaultSession(store);
    send(store, envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-rc"));
    const closed = send(
      store,
      envelope("session.renew", 2, { expiresAt: EXPIRES_AT, sessionId: SESSION_ID }, "cmd-rr"),
    );
    expect(refusalOf(closed).code).toBe("SESSION_ALREADY_CLOSED");
  });

  it("refuses a close whose expected version does not match the folded record", () => {
    const store = openStore();
    openDefaultSession(store);
    const outcome = send(store, envelope("session.close", 0, { sessionId: SESSION_ID }, "cmd-cs"));
    expect(refusalOf(outcome)).toEqual({
      code: "SESSION_EXPECTED_VERSION_STALE",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });
});

describe("ingress and fail-closed arms", () => {
  it("pins the ingress codes for bad bytes, foreign kinds and a wrong schema version", () => {
    const store = openStore();
    const bytes = runSessionCommand(store, new TextEncoder().encode("{not json"));
    expect(refusalOf(bytes).code).toBe("SESSION_INPUT_REJECTED");
    const foreign = send(store, envelope("goal.create", 0, {}, "cmd-foreign"));
    expect(refusalOf(foreign).code).toBe("SESSION_COMMAND_UNKNOWN");
    const request = envelope("session.open", 0, openPayload(), "cmd-schema");
    const schema = send(store, { ...request, schemaVersion: "moe-session-command/2" });
    expect(refusalOf(schema).code).toBe("SESSION_REQUEST_INVALID");
  });

  it("refuses commands over a corrupt ledger with SESSION_LEDGER_UNREADABLE", () => {
    const store = openStore();
    commitRaw(store, envelope("session.open", 0, openPayload(), "cmd-corrupt"), "garbage", SESSION_ID);
    const outcome = send(store, envelope("session.close", 1, { sessionId: SESSION_ID }, "cmd-cx"));
    expect(refusalOf(outcome)).toEqual({
      code: "SESSION_LEDGER_UNREADABLE",
      refusedBy: "DAEMON_PREREQUISITE",
    });
  });
});
