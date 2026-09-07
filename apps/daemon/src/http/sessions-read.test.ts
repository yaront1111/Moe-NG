/**
 * The sessions read over a REAL store: the operator session the bootstrap fixture opens is
 * read back through the production session ledger; liveness and claim holdings are driven
 * by the injected clock and claim ledger, one fact per arm.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { setAgentProvider } from "../orchestrator/agent-provider-store.js";
import { readWrapperKnobs } from "../orchestrator/wrapper-knobs.js";
import type { SessionLedger } from "../identity/session-read-model.js";
import type { WorkClaimLedger } from "../work/work-claim-read-model.js";
import { KNOWN_PROVIDERS } from "./health-read.js";
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

/**
 * THE DISCLOSED AGENT PROVIDER. Every arm drives the DURABLE half through the REAL store —
 * `setAgentProvider` writes it and the port's own DEFAULT reader reads it back — so a
 * `readProvider` that was never wired to production could not pass. The two DoD arms are a
 * PAIR over one store: same project setting, env set and env unset, two different answers.
 */
describe("the sessions read discloses the configured agent provider", () => {
  /** A real store whose PROJECT-scope durable setting is `provider`. */
  const storeSet = (provider: string) => {
    const store = openStore();
    const written = setAgentProvider({ now: () => NOW, projectId: PROJECT_ID, store }, { goalId: "", provider });
    if (!written.ok) throw new Error(`fixture could not record ${provider}: ${written.code}`);
    return store;
  };
  /**
   * The JSON THE HANDLER RETURNS, not an internal field. The authenticator fixture's
   * principal is bound to `proj-0001` while the real store is `project-1`, so the port is
   * re-labelled for the handler exactly as the project-mismatch arm above does; the
   * `readSessions` closure, and so the whole read, is untouched by the relabel.
   */
  const body = (options: Omit<Parameters<typeof createSessionsReadPort>[0], "clock" | "projectId">): SessionsView => {
    const port = createSessionsReadPort({ clock: () => NOW, projectId: PROJECT_ID, ...options });
    const answer = handleSessionsReadRequest(
      { authenticator: authenticator([CAPABILITIES.GOAL]), sessions: { ...port, boundProjectId: "proj-0001" } },
      { body: encoder.encode("{}"), credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION },
    );
    if (answer.kind !== "REPLY") throw new Error(answer.code);
    return sessions(answer.body as ReturnType<SessionsReadPort["readSessions"]>);
  };

  it("publishes the OVERRIDE: env set, durable setting naming the OTHER provider", () => {
    // The store genuinely says `codex`; this daemon's env says `claude`. The env wins at
    // spawn, so the disclosure must say `claude` AND say that the env is why.
    expect(body({ configuredAgentLimit: 2, envAgentCommand: "claude", store: storeSet("codex") }).agentProvider)
      .toEqual({ configured: "claude", envOverride: true });
  });

  it("publishes the SETTING when the env is unset, and says no override is in force", () => {
    // Same durable setting, env absent: the answer MOVES to the store's value and the flag
    // drops. The pair is what proves neither member is a constant.
    expect(body({ configuredAgentLimit: 2, envAgentCommand: undefined, store: storeSet("codex") }).agentProvider)
      .toEqual({ configured: "codex", envOverride: false });
  });

  it("falls to claude when the store carries no setting and no env overrides", () => {
    expect(body({ configuredAgentLimit: 2, envAgentCommand: undefined, store: openStore() }).agentProvider)
      .toEqual({ configured: "claude", envOverride: false });
  });

  it("reports a known provider by NAME when the env names a PATH, not the raw path", () => {
    // An operator reading `C:\tools\codex.exe` in a status field learns a filesystem
    // layout; the roster name is what lines up with the provider pause banner.
    expect(body({ configuredAgentLimit: 2, envAgentCommand: "C:\\tools\\codex.exe", store: storeSet("claude") }).agentProvider)
      .toEqual({ configured: "codex", envOverride: true });
    expect(body({ configuredAgentLimit: 2, envAgentCommand: "/usr/local/bin/codex", store: storeSet("claude") }).agentProvider)
      .toEqual({ configured: "codex", envOverride: true });
  });

  it("publishes an OFF-ROSTER command VERBATIM rather than collapsing it to claude", () => {
    // `pauseProviderOf` maps an unrecognised command to `claude` on purpose, because the
    // PAUSE LEDGER must be keyed by a name some row uses. A DISCLOSURE must not: reporting
    // `claude` here would show an operator a provider nobody configured, on a daemon whose
    // very next spawn would run gemini.
    expect(KNOWN_PROVIDERS).toEqual(["claude", "codex"]);
    // An off-roster command has no provider IDENTITY to report, so the configured value is
    // published exactly as it stands — the full path included. Reducing it to a basename
    // would manufacture a provider name for something that is not one, and `gemini` beside
    // a roster of ["claude", "codex"] reads as a provider the daemon knows. It does not.
    expect(body({ configuredAgentLimit: 2, envAgentCommand: "/usr/local/bin/gemini", store: storeSet("codex") }).agentProvider)
      .toEqual({ configured: "/usr/local/bin/gemini", envOverride: true });
    expect(body({ configuredAgentLimit: 2, envAgentCommand: "gemini", store: storeSet("codex") }).agentProvider)
      .toEqual({ configured: "gemini", envOverride: true });
    // Same rule for a DURABLE value that outlived a roster change. That state is NOT
    // reachable through the write path — assert the refusal rather than assume it — so the
    // stale reader has to be injected to reach the branch at all.
    const store = openStore();
    expect(setAgentProvider({ now: () => NOW, projectId: PROJECT_ID, store }, { goalId: "", provider: "gemini" }))
      .toEqual({ code: "AGENT_PROVIDER_UNKNOWN", layer: "DURABLE_STORE", ok: false });
    expect(body({ configuredAgentLimit: 2, envAgentCommand: undefined, readProvider: () => () => "gemini", store }).agentProvider)
      .toEqual({ configured: "gemini", envOverride: false });
  });

  it("treats a BLANK env variable as unset, exactly as the spawn resolver does", () => {
    // A truthiness check reports `envOverride: true` here while `resolveAgentProvider`
    // ignored the variable and resolved codex — the flag and the value would disagree.
    for (const blank of ["", "   ", "\t"]) {
      expect(body({ configuredAgentLimit: 2, envAgentCommand: blank, store: storeSet("codex") }).agentProvider)
        .toEqual({ configured: "codex", envOverride: false });
    }
  });

  it("takes the env from THIS DAEMON PROCESS when none is injected", () => {
    // The arms above prove the port publishes what it is GIVEN. This one proves the
    // DEFAULT is the live environment: an `envAgentCommand` that quietly defaulted to
    // undefined would satisfy every arm above and never disclose a real override.
    const store = storeSet("codex");
    const before = process.env["MOE_AGENT_COMMAND"];
    try {
      process.env["MOE_AGENT_COMMAND"] = "claude";
      expect(body({ configuredAgentLimit: 2, store }).agentProvider).toEqual({ configured: "claude", envOverride: true });
      delete process.env["MOE_AGENT_COMMAND"];
      expect(body({ configuredAgentLimit: 2, store }).agentProvider).toEqual({ configured: "codex", envOverride: false });
    } finally {
      if (before === undefined) delete process.env["MOE_AGENT_COMMAND"];
      else process.env["MOE_AGENT_COMMAND"] = before;
    }
  });

  it("degrades an unreadable durable setting to claude instead of wedging the read", () => {
    const view = body({
      configuredAgentLimit: 2, envAgentCommand: undefined,
      readProvider: () => () => { throw new Error("store unreadable"); }, store: openStore(),
    });
    expect(view.agentProvider).toEqual({ configured: "claude", envOverride: false });
    expect(view.outcome).toBe("SESSIONS");
  });

  it("leaves the concurrency member and the refusal shape untouched", () => {
    const view = body({ configuredAgentLimit: 6, envAgentCommand: undefined, store: storeSet("codex") });
    expect(view.concurrency).toEqual({ activeSeats: 0, configuredAgentLimit: 6 });
    // A refusal still carries EXACTLY three keys and no provider member: the browser
    // recognises a refusal by exact arity, and a refusal that grew one stops being one.
    const refusal = createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 2, projectId: PROJECT_ID,
      readSessions: () => { throw new Error("ledger unreadable"); }, store: openStore(),
    }).readSessions();
    expect(Object.keys(refusal).sort()).toEqual(["code", "layer", "outcome"]);
  });
});
