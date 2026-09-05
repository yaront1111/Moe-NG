/**
 * The sessions read over a REAL store: the operator session the bootstrap fixture opens is
 * read back through the production session ledger; liveness and claim holdings are driven
 * by the injected clock and claim ledger, one fact per arm.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readWrapperKnobs } from "../orchestrator/wrapper-knobs.js";
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
    const view = sessions(createSessionsReadPort({ clock: () => NOW, configuredAgentLimit: 2, projectId: PROJECT_ID, store }).readSessions());
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
      clock: () => NOW, configuredAgentLimit: 2, projectId: PROJECT_ID, store,
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

/**
 * THE DISCLOSED CONCURRENCY. The default limit IS 2, so an arm asserting `=== 2` passes
 * against a hard-coded literal and proves nothing. Every arm here either drives the value
 * through the WRAPPER's own parser with a fake env, or varies it and asserts the answer
 * moved with it.
 */
describe("the sessions read discloses the concurrency limit", () => {
  const port = (options: { readonly claims?: Parameters<typeof claims>[0]; readonly limit: number; readonly rows?: Parameters<typeof ledgerWith>[0] }) =>
    createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: options.limit, projectId: PROJECT_ID,
      readClaims: () => claims(options.claims ?? []),
      readSessions: () => ledgerWith(options.rows ?? []),
      store: openStore(),
    });

  it("publishes the limit the WRAPPER's parser read, and it MOVES with the variable", () => {
    // Sourced exactly as production does (daemon-store-foundation-composition.ts) — the
    // production parser over an env, not a number typed into the test.
    const five = readWrapperKnobs({ MOE_WRAPPER_MAX_AGENTS: "5" }).maxAgents;
    const seven = readWrapperKnobs({ MOE_WRAPPER_MAX_AGENTS: "7" }).maxAgents;
    expect(five).toBe(5);
    expect(sessions(port({ limit: five }).readSessions()).concurrency.configuredAgentLimit).toBe(5);
    // THE ARM THAT KILLS A HARD-CODED 2: the same read, a different knob, a different answer.
    expect(sessions(port({ limit: seven }).readSessions()).concurrency.configuredAgentLimit).toBe(7);
  });

  it("falls back to the wrapper's documented default of 2 when the variable is unset", () => {
    const fallback = readWrapperKnobs({}).maxAgents;
    expect(fallback).toBe(2);
    expect(sessions(port({ limit: fallback }).readSessions()).concurrency.configuredAgentLimit).toBe(2);
  });

  it("counts an active seat as a LIVE seat that HOLDS work, and nothing else", () => {
    const holding = [
      { claimedBy: "sess-live", expiresAt: "2026-09-03T11:00:00.000Z", workItemId: "node.deliver@node-a" },
      { claimedBy: "sess-live-2", expiresAt: "2026-09-03T11:00:00.000Z", workItemId: "node.deliver@node-b" },
      // Expired claim, live seat: not work in flight, so not a seat against the limit.
      { claimedBy: "sess-idle", expiresAt: "2026-09-03T09:00:00.000Z", workItemId: "node.deliver@node-old" },
      // A held item whose seat is EXPIRED — the claim outlives the bearer; still not active.
      { claimedBy: "sess-expired", expiresAt: "2026-09-03T11:00:00.000Z", workItemId: "node.deliver@node-c" },
    ];
    const rows = [
      session("sess-live", "2026-09-03T12:00:00.000Z"), session("sess-live-2", "2026-09-03T12:00:00.000Z"),
      session("sess-idle", "2026-09-03T12:00:00.000Z"), session("sess-expired", "2026-09-03T09:59:59.000Z"),
      session("sess-closed", "2026-09-03T12:00:00.000Z", "CLOSED"),
    ];
    const view = sessions(port({ claims: holding, limit: 2, rows }).readSessions());
    // TWO of five seats, and the three near-misses are each excluded for a different reason.
    expect(view.concurrency).toEqual({ activeSeats: 2, configuredAgentLimit: 2 });
    // Cross-check against the rows the same read published, so the count is not a
    // second bookkeeping that could drift from the list an operator is looking at.
    expect(view.sessions.filter((row) => row.liveness === "LIVE" && row.holding.length > 0)).toHaveLength(2);
    // The limit is disclosed whether or not seats are busy, and the totals are untouched.
    expect(view.totals).toEqual({ closed: 1, expired: 1, live: 3 });
  });

  it("reports zero active seats on an empty ledger, and still discloses the limit", () => {
    const view = sessions(port({ limit: 4 }).readSessions());
    expect(view.concurrency).toEqual({ activeSeats: 0, configuredAgentLimit: 4 });
    expect(view.sessions).toEqual([]);
  });

  it("keeps every refusal frame at its EXACT three keys, with no concurrency member", () => {
    // The browser decodes a refusal by exact arity: a refusal that grew a concurrency
    // field would stop being recognised as a refusal at all and surface as a bad response.
    const throwing = createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 2, projectId: PROJECT_ID,
      readSessions: () => { throw new Error("ledger unreadable"); },
      store: openStore(),
    }).readSessions();
    expect(throwing).toEqual({ code: "SESSIONS_READ_UNREADABLE", layer: "SESSIONS_READ", outcome: "REFUSED" });
    expect(Object.keys(throwing).sort()).toEqual(["code", "layer", "outcome"]);

    const refusing: SessionsReadPort = { boundProjectId: "proj-0001", readSessions: () => throwing };
    const ask = (deps: Parameters<typeof handleSessionsReadRequest>[0]) => {
      const answer = handleSessionsReadRequest(deps, { body: encoder.encode("{}"), credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });
      if (answer.kind !== "REPLY") throw new Error(answer.code);
      return answer.body as unknown as Record<string, unknown>;
    };
    const denied = ask({ authenticator: authenticator([CAPABILITIES.PLANNING]), sessions: refusing });
    expect(denied.code).toBe("SESSIONS_READ_CAPABILITY_DENIED");
    expect(Object.keys(denied).sort()).toEqual(["code", "layer", "outcome"]);
    const mismatched = ask({ authenticator: authenticator([CAPABILITIES.GOAL]), sessions: { ...refusing, boundProjectId: "elsewhere" } });
    expect(mismatched.code).toBe("SESSIONS_READ_PROJECT_MISMATCH");
    expect(Object.keys(mismatched).sort()).toEqual(["code", "layer", "outcome"]);
  });

  it("takes the limit from readWrapperKnobs at the composition site, not from a literal", () => {
    // The arms above prove the PORT publishes what it is given. This one proves production
    // GIVES it the knob: a `configuredAgentLimit: 2` typed into the composition would
    // satisfy every arm above and disclose a lie on a daemon launched with any other value.
    const source = readFileSync(new URL("../daemon-store-foundation-composition.ts", import.meta.url), "utf8");
    expect(source).toContain("configuredAgentLimit: readWrapperKnobs(process.env).maxAgents");
  });
});
