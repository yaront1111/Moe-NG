/**
 * The sessions read over a REAL store: the operator session the bootstrap fixture opens is
 * read back through the production session ledger; liveness and claim holdings are driven
 * by the injected clock and claim ledger, one fact per arm.
 */
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { SessionLedger } from "../identity/session-read-model.js";
import type { WorkClaimLedger } from "../work/work-claim-read-model.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";
import { createSessionsReadPort, handleSessionsReadRequest } from "./sessions-read.js";
import type { SessionsReadPort, SessionsView } from "./sessions-read.js";

afterEach(closeStores);
const encoder = new TextEncoder();
const NOW = "2026-09-03T10:00:00.000Z";

function sessions(result: ReturnType<SessionsReadPort["readSessions"]>): SessionsView {
  if (result.outcome !== "SESSIONS") throw new Error(`expected SESSIONS, got ${result.code}`);
  return result;
}

const ledgerWith = (rows: SessionLedger["sessions"] extends ReadonlyMap<string, infer R> ? R[] : never): SessionLedger => ({
  decisionCount: rows.length, sessions: new Map(rows.map((row) => [row.sessionId, row])), unreadable: false,
});
const session = (sessionId: string, expiresAt: string, status: "CLOSED" | "OPEN" = "OPEN") => ({
  capabilities: ["review.write", "work.write"], credentialSha256: "c".repeat(64), expiresAt,
  keyEpochRef: "epoch-1", principalId: sessionId, recoveryIncarnationRef: "inc-1", sessionId, status, version: 1,
});
const claims = (rows: readonly { claimedBy: string; expiresAt: string; workItemId: string; status?: "OPEN" | "RELEASED" }[]): WorkClaimLedger => ({
  claims: new Map(rows.map((row) => [row.workItemId, { claimedBy: row.claimedBy, expiresAt: row.expiresAt, status: row.status ?? "OPEN", version: 1, workItemId: row.workItemId }])),
  decisionCount: rows.length, unreadable: false,
});

describe("createSessionsReadPort", () => {
  it("reads the real session ledger of a bootstrapped project", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const view = sessions(createSessionsReadPort({ clock: () => NOW, projectId: PROJECT_ID, store }).readSessions());
    expect(view.readAt).toBe(NOW);
    expect(view.unreadable).toBe(false);
    expect(view.totals.live + view.totals.expired + view.totals.closed).toBe(view.sessions.length);
    for (const row of view.sessions) {
      expect(row.sessionId).toBeTypeOf("string");
      expect(Array.isArray(row.capabilities)).toBe(true);
      expect(["LIVE", "EXPIRED", "CLOSED"]).toContain(row.liveness);
    }
  });

  it("derives liveness at the clock, joins active claims, and lists live seats first", () => {
    const store = openStore();
    const port = createSessionsReadPort({
      clock: () => NOW, projectId: PROJECT_ID, store,
      readClaims: () => claims([
        { claimedBy: "sess-live", expiresAt: "2026-09-03T11:00:00.000Z", workItemId: "node.deliver@node-a" },
        { claimedBy: "sess-live", expiresAt: "2026-09-03T09:00:00.000Z", workItemId: "node.deliver@node-old" },
        { claimedBy: "sess-live", expiresAt: "2026-09-03T11:00:00.000Z", status: "RELEASED", workItemId: "node.deliver@node-done" },
      ]),
      readSessions: () => ledgerWith([
        session("sess-closed", "2026-09-03T12:00:00.000Z", "CLOSED"),
        session("sess-expired", "2026-09-03T09:59:59.000Z"),
        session("sess-live", "2026-09-03T12:00:00.000Z"),
      ]),
    });
    const view = sessions(port.readSessions());
    expect(view.sessions.map((row) => [row.sessionId, row.liveness, row.holding])).toEqual([
      ["sess-live", "LIVE", ["node.deliver@node-a"]],
      ["sess-expired", "EXPIRED", []],
      ["sess-closed", "CLOSED", []],
    ]);
    expect(view.totals).toEqual({ closed: 1, expired: 1, live: 1 });
  });
});

describe("handleSessionsReadRequest", () => {
  const port: SessionsReadPort = { boundProjectId: "proj-0001", readSessions: () => ({ code: "SESSIONS_READ_UNREADABLE", layer: "SESSIONS_READ", outcome: "REFUSED" }) };
  const request = (body: Uint8Array) => ({ body, credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });

  it("gates on capability, port presence, project and body, then forwards", () => {
    expect(handleSessionsReadRequest({ authenticator: authenticator([CAPABILITIES.PLANNING]), sessions: port }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "SESSIONS_READ_CAPABILITY_DENIED" } });
    expect(handleSessionsReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]) }, request(encoder.encode("{}"))))
      .toEqual({ code: "LISTENER_SESSIONS_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(handleSessionsReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), sessions: { ...port, boundProjectId: "elsewhere" } }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "SESSIONS_READ_PROJECT_MISMATCH" } });
    expect(handleSessionsReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), sessions: port }, request(encoder.encode('{"sessionId":"s"}'))))
      .toEqual({ code: "LISTENER_SESSIONS_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    expect(handleSessionsReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), sessions: port }, request(new Uint8Array())))
      .toEqual({ body: { code: "SESSIONS_READ_UNREADABLE", layer: "SESSIONS_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
  });
});
