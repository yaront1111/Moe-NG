/**
 * The sessions read over a REAL store: the operator session the bootstrap fixture opens is
 * read back through the production session ledger; liveness and claim holdings are driven
 * by the injected clock and claim ledger, one fact per arm.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { setAgentProvider } from "../orchestrator/agent-provider-store.js";
import { recordSeatExit } from "../orchestrator/provider-pause-ledger.js";
import { SEAT_FACT_UNMEASURED } from "../orchestrator/seat-start-contracts.js";
import { recordSeatStart } from "../orchestrator/seat-start-ledger.js";
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

/**
 * WHAT EACH SEAT WAS STARTED WITH, over a DURABLE boundary.
 *
 * The point of the seat-start ledger is that a fact measured in the WRAPPER process survives to
 * the DAEMON process, so the arm that matters writes with ONE `SqliteEventStore` and reads with
 * ANOTHER against the same file, through the port's own PRODUCTION reader. An in-memory fixture
 * would prove the shape of the members and nothing about the claim.
 */
describe("the sessions read discloses what each seat was started with", () => {
  const sandboxes: string[] = [];
  const opened: SqliteEventStore[] = [];
  const openAt = (path: string): SqliteEventStore => {
    const store = SqliteEventStore.openForProject(path, PROJECT_ID);
    opened.push(store);
    return store;
  };
  const sandbox = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "moe-seat-start-"));
    sandboxes.push(directory);
    return join(directory, "store.db");
  };
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
    while (sandboxes.length > 0) {
      const directory = sandboxes.pop();
      if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
    }
  });

  /** The port over `store`, with the seat ledger REAL and only the session rows injected. */
  const viewOver = (store: SqliteEventStore, rows: Parameters<typeof ledgerWith>[0]): SessionsView =>
    sessions(createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 2, envAgentCommand: undefined, projectId: PROJECT_ID,
      readClaims: () => claims([]), readSessions: () => ledgerWith(rows), store,
    }).readSessions());

  it("reads back, from a SECOND store instance, what a FIRST one wrote at spawn", () => {
    const path = sandbox();
    const writer = openAt(path);
    const written = recordSeatStart(writer, {
      agentVersion: "2.1.263 (Claude Code)", projectId: PROJECT_ID, provider: "claude",
      sessionId: "sess-live", startedAt: "2026-09-03T09:30:00.000Z",
    });
    if (!written.ok) throw new Error(`fixture could not record: ${written.code}`);
    opened.splice(opened.indexOf(writer), 1);
    writer.close();

    // A DIFFERENT instance's view of the same database, through the port's DEFAULT reader.
    const view = viewOver(openAt(path), [session("sess-live", "2026-09-03T12:00:00.000Z")]);
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0]?.providerAtStart).toBe("claude");
    expect(view.sessions[0]?.agentVersionAtStart).toBe("2.1.263 (Claude Code)");
    // And it MOVES: a second seat with a different reading is not the first one's answer.
    const second = openAt(path);
    const codex = recordSeatStart(second, {
      agentVersion: "codex-cli 0.153.4", projectId: PROJECT_ID, provider: "codex",
      sessionId: "sess-codex", startedAt: "2026-09-03T09:40:00.000Z",
    });
    if (!codex.ok) throw new Error(`fixture could not record: ${codex.code}`);
    const both = viewOver(second, [
      session("sess-live", "2026-09-03T12:00:00.000Z"), session("sess-codex", "2026-09-03T12:00:00.000Z"),
    ]);
    expect(new Map(both.sessions.map((row) => [row.sessionId, [row.providerAtStart, row.agentVersionAtStart]])))
      .toEqual(new Map([
        ["sess-live", ["claude", "2.1.263 (Claude Code)"]],
        ["sess-codex", ["codex", "codex-cli 0.153.4"]],
      ]));
  });

  it("publishes ONE stated unknown for NO record and for a FAILED probe alike", () => {
    // DoD-4, and the arm that pins "one unknown, one meaning". A seat that predates the ledger
    // and a seat whose probe answered nothing must be indistinguishable to an operator, or the
    // screen teaches a difference that does not exist. The exact TOKEN is asserted, never
    // falsiness: "" and undefined would both satisfy a falsy check and both are the defect.
    const store = openAt(sandbox());
    const probeFailed = recordSeatStart(store, {
      agentVersion: SEAT_FACT_UNMEASURED, projectId: PROJECT_ID, provider: "claude",
      sessionId: "sess-probe-failed", startedAt: "2026-09-03T09:30:00.000Z",
    });
    if (!probeFailed.ok) throw new Error(`fixture could not record: ${probeFailed.code}`);
    const view = viewOver(store, [
      session("sess-probe-failed", "2026-09-03T12:00:00.000Z"),
      session("sess-no-record", "2026-09-03T12:00:00.000Z"),
    ]);
    const rows = new Map(view.sessions.map((row) => [row.sessionId, row]));
    expect(rows.get("sess-probe-failed")?.agentVersionAtStart).toBe("UNKNOWN");
    // The provider is still KNOWN here: the wrapper measured which command it spawned even
    // though that command would not say its version. The two members degrade independently.
    expect(rows.get("sess-probe-failed")?.providerAtStart).toBe("claude");
    // No record at all - every session opened before this ledger existed, and every paired
    // browser that never had a seat. BOTH members take the same token as the failed probe.
    expect(rows.get("sess-no-record")?.agentVersionAtStart).toBe("UNKNOWN");
    expect(rows.get("sess-no-record")?.providerAtStart).toBe("UNKNOWN");
    expect(SEAT_FACT_UNMEASURED).toBe("UNKNOWN");
  });

  it("shows NO SEAT for a start note whose session the session ledger does not know", () => {
    // A note is a decoration ON a session, never a source of one. If it could add a row, a
    // stale or forged note would put a seat on the operator's screen that never existed and
    // that no `session.close` could ever retire.
    const store = openAt(sandbox());
    expect(recordSeatStart(store, {
      agentVersion: "1.2.3", projectId: PROJECT_ID, provider: "claude",
      sessionId: "sess-orphan", startedAt: "2026-09-03T09:30:00.000Z",
    }).ok).toBe(true);
    const view = viewOver(store, [session("sess-real", "2026-09-03T12:00:00.000Z")]);
    expect(view.sessions.map((row) => row.sessionId)).toEqual(["sess-real"]);
    expect(view.totals).toEqual({ closed: 0, expired: 0, live: 1 });
    expect(view.sessions[0]?.agentVersionAtStart).toBe("UNKNOWN");
  });

  it("degrades to the stated unknown when the seat ledger CANNOT be read, not to a refusal", () => {
    // A note about which version a seat started with is not a reason to tell an operator the
    // session ledger is broken: the read still answers SESSIONS, with the unknown.
    const view = sessions(createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 2, envAgentCommand: undefined, projectId: PROJECT_ID,
      readClaims: () => claims([]), readSeatStarts: () => { throw new Error("seat ledger unreadable"); },
      readSessions: () => ledgerWith([session("sess-live", "2026-09-03T12:00:00.000Z")]), store: openStore(),
    }).readSessions());
    expect(view.outcome).toBe("SESSIONS");
    expect(view.sessions[0]?.providerAtStart).toBe("UNKNOWN");
    expect(view.sessions[0]?.agentVersionAtStart).toBe("UNKNOWN");
  });

  it("keeps the refusal shape at EXACTLY three keys and leaves the frame members untouched", () => {
    const view = sessions(createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 6, envAgentCommand: undefined, projectId: PROJECT_ID,
      readSeatStarts: () => new Map(), readSessions: () => ledgerWith([]), store: openStore(),
    }).readSessions());
    expect(view.concurrency).toEqual({ activeSeats: 0, configuredAgentLimit: 6 });
    expect(view.agentProvider).toEqual({ configured: "claude", envOverride: false });
    const refusal = createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 2, projectId: PROJECT_ID,
      readSessions: () => { throw new Error("ledger unreadable"); }, store: openStore(),
    }).readSessions();
    expect(Object.keys(refusal).sort()).toEqual(["code", "layer", "outcome"]);
  });

  it("declares BOTH members on SessionView with names that say the fact is from the START", () => {
    // DoD-1 is about the NAME, and a name is not something a value assertion can check. A
    // member called `provider` would satisfy every arm above while claiming a present-tense
    // observation the daemon cannot perform, so the declaration itself is pinned.
    const source = readFileSync(new URL("./sessions-read-contracts.ts", import.meta.url), "utf8");
    const body = /export interface SessionView \{\r?\n(?<members>[\s\S]*?)\r?\n\}/u.exec(source)?.groups?.["members"];
    if (body === undefined) throw new Error("SessionView not found in sessions-read-contracts.ts");
    const declared = [...body.matchAll(/^ {2}readonly (?<name>[A-Za-z]+)[?]?:/gmu)].map((match) => match.groups?.["name"]);
    expect(declared).toContain("providerAtStart");
    expect(declared).toContain("agentVersionAtStart");
    expect(declared).not.toContain("provider");
    expect(declared).not.toContain("agentVersion");
  });
});

/**
 * WHEN EACH SEAT STARTED AND HOW IT ENDED — the two facts the Health screen could not show.
 *
 * Measured on a live drive (2026-09-12): a seat that hung for seven minutes with zero network was
 * listed as "live until <expiry>", identical to a working seat, and its exit showed as one more
 * "closed" in a count. Both facts were already DURABLE — `startedAt` in the seat-start record and
 * kind/exit code/last line in the seat-exit record — and neither reached the read. Every arm here
 * writes through the wrapper's own record path and reads through the port's DEFAULT fold, so a
 * reader that was never wired to production could not pass.
 */
describe("the sessions read discloses when each seat started and how it exited", () => {
  const viewOver = (store: SqliteEventStore, rows: Parameters<typeof ledgerWith>[0]): SessionsView =>
    sessions(createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 2, envAgentCommand: undefined, projectId: PROJECT_ID,
      readClaims: () => claims([]), readSessions: () => ledgerWith(rows), store,
    }).readSessions());
  const rowsOf = (view: SessionsView) => new Map(view.sessions.map((row) => [row.sessionId, row]));
  const exitInput = (overrides: Partial<Parameters<typeof recordSeatExit>[1]>) => ({
    decidedAt: "2026-09-03T09:58:00.000Z", exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT",
    projectId: PROJECT_ID, provider: "claude", resetAt: null, sessionId: "sess-closed",
    workItemId: "node.deliver@node-a", ...overrides,
  });

  it("publishes the start instant the wrapper wrote at spawn, and null for a seat with no record", () => {
    const store = openStore();
    expect(recordSeatStart(store, {
      agentVersion: "2.1.263 (Claude Code)", projectId: PROJECT_ID, provider: "claude",
      sessionId: "sess-live", startedAt: "2026-09-03T09:48:00.000Z",
    }).ok).toBe(true);
    expect(recordSeatStart(store, {
      agentVersion: "2.1.263 (Claude Code)", projectId: PROJECT_ID, provider: "claude",
      sessionId: "sess-live-2", startedAt: "2026-09-03T09:55:00.000Z",
    }).ok).toBe(true);
    const rows = rowsOf(viewOver(store, [
      session("sess-live", "2026-09-03T12:00:00.000Z"), session("sess-live-2", "2026-09-03T12:00:00.000Z"),
      session("sess-no-record", "2026-09-03T12:00:00.000Z"),
    ]));
    expect(rows.get("sess-live")?.startedAt).toBe("2026-09-03T09:48:00.000Z");
    // It MOVES: a second seat's instant is not the first one's answer.
    expect(rows.get("sess-live-2")?.startedAt).toBe("2026-09-03T09:55:00.000Z");
    // NULL, not "UNKNOWN" and not the read's clock: a paired browser and every seat older than the
    // start ledger have no instant, and a placeholder here would date them to the wrong moment.
    expect(rows.get("sess-no-record")?.startedAt).toBeNull();
    // The seat's liveness words are untouched by the new member.
    expect(rows.get("sess-live")?.liveness).toBe("LIVE");
  });

  it("publishes the exit the wrapper recorded - kind, exit code, last line, instant - and null for none", () => {
    const store = openStore();
    expect(recordSeatExit(store, exitInput({})).ok).toBe(true);
    // Killed on a signal: the record's exit code is NULL and so is the view's, never 0 or -1. This
    // is the exact fact the hung seat carried and the screen could not show.
    expect(recordSeatExit(store, exitInput({ exitCode: null, kind: "FAILED", lastLine: null, sessionId: "sess-killed" })).ok).toBe(true);
    expect(recordSeatExit(store, exitInput({ exitCode: 0, kind: "COMPLETED", lastLine: "done", sessionId: "sess-done" })).ok).toBe(true);
    const rows = rowsOf(viewOver(store, [
      session("sess-closed", "2026-09-03T12:00:00.000Z", "CLOSED"), session("sess-killed", "2026-09-03T12:00:00.000Z", "CLOSED"),
      session("sess-done", "2026-09-03T09:00:00.000Z"), session("sess-quiet", "2026-09-03T09:00:00.000Z"),
    ]));
    expect(rows.get("sess-closed")?.exit).toEqual({
      at: "2026-09-03T09:58:00.000Z", exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT",
    });
    expect(rows.get("sess-killed")?.exit).toEqual({ at: "2026-09-03T09:58:00.000Z", exitCode: null, kind: "FAILED", lastLine: null });
    expect(rows.get("sess-done")?.exit).toEqual({ at: "2026-09-03T09:58:00.000Z", exitCode: 0, kind: "COMPLETED", lastLine: "done" });
    // No record: NULL, not a placeholder object. The browser renders "reason not recorded" for
    // exactly this, and a made-up kind here would put a reason on screen nobody observed.
    expect(rows.get("sess-quiet")?.exit).toBeNull();
    // EXACT keys on the exit object: the browser decodes it by exact arity.
    expect(Object.keys(rows.get("sess-closed")?.exit as object).sort()).toEqual(["at", "exitCode", "kind", "lastLine"]);
  });

  it("degrades to null when the exit ledger CANNOT be read, not to a refusal", () => {
    // How a seat ended is decoration on a session, never a source of one: the read still answers
    // SESSIONS, with the exit unknown, exactly as it does for an unreadable start ledger.
    const view = sessions(createSessionsReadPort({
      clock: () => NOW, configuredAgentLimit: 2, envAgentCommand: undefined, projectId: PROJECT_ID,
      readClaims: () => claims([]), readSeatExits: () => { throw new Error("exit ledger unreadable"); },
      readSessions: () => ledgerWith([session("sess-closed", "2026-09-03T12:00:00.000Z", "CLOSED")]), store: openStore(),
    }).readSessions());
    expect(view.outcome).toBe("SESSIONS");
    expect(view.sessions[0]?.exit).toBeNull();
    expect(view.sessions[0]?.startedAt).toBeNull();
  });

  it("declares BOTH members on SessionView, where the browser's exact-arity decode is pinned to", () => {
    const source = readFileSync(new URL("./sessions-read-contracts.ts", import.meta.url), "utf8");
    const body = /export interface SessionView \{\r?\n(?<members>[\s\S]*?)\r?\n\}/u.exec(source)?.groups?.["members"];
    if (body === undefined) throw new Error("SessionView not found in sessions-read-contracts.ts");
    const declared = [...body.matchAll(/^ {2}readonly (?<name>[A-Za-z]+)[?]?:/gmu)].map((match) => match.groups?.["name"]);
    expect(declared).toContain("startedAt");
    expect(declared).toContain("exit");
  });
});
