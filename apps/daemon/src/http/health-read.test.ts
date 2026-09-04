/**
 * The health read over a REAL store: the process facts echo the composition's own config,
 * the ledger numbers are counted from the store the bootstrap sequence wrote, and the
 * verifier standing is carried from its reader. The route gates like every other read.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { recordProviderPause } from "../orchestrator/provider-pause-ledger.js";
import { createHealthReadPort, handleHealthReadRequest } from "./health-read.js";
import type { HealthReadPort, HealthView } from "./health-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";

afterEach(closeStores);
const encoder = new TextEncoder();

function health(result: ReturnType<HealthReadPort["readHealth"]>): HealthView {
  if (result.outcome !== "HEALTH") throw new Error(`expected HEALTH, got ${result.code}`);
  return result;
}

describe("createHealthReadPort", () => {
  it("states the process facts it was composed with and counts the ledger it reads", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const view = health(createHealthReadPort({
      clock: () => "2026-09-02T20:00:00.000Z", nodeSpecsDir: "D:/specs", pid: 4242, projectId: PROJECT_ID,
      readPlane: () => "V1", readVerifier: () => ({ calibration: true, policy: true }),
      startedAt: "2026-09-02T19:00:00.000Z", store, storePath: "D:/store.sqlite",
    }).readHealth());
    expect(view.daemon).toEqual({
      commandAuthorityPlane: "V1", nodeSpecsDir: "D:/specs", pid: 4242, projectId: PROJECT_ID,
      protocolVersion: WIRE_PROTOCOL_VERSION, startedAt: "2026-09-02T19:00:00.000Z", storePath: "D:/store.sqlite",
    });
    expect(view.ledger.decisionCount).toBeGreaterThan(0);
    expect(view.ledger.aggregates).toBeGreaterThan(0);
    expect(view.ledger.commandKinds).toBeGreaterThan(0);
    expect(view.ledger.goals).toBe(0);
    expect(view.ledger.lastDecidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(view.readAt).toBe("2026-09-02T20:00:00.000Z");
    expect(view.verifier).toEqual({ calibration: true, policy: true });
  });

  it("answers an empty ledger honestly and defaults the pid to the process", () => {
    const store = openStore();
    const view = health(createHealthReadPort({
      nodeSpecsDir: null, projectId: PROJECT_ID, readPlane: () => "V2",
      readVerifier: () => ({ calibration: false, policy: false }),
      startedAt: "2026-09-02T19:00:00.000Z", store, storePath: ":memory:",
    }).readHealth());
    expect(view.ledger).toEqual({ aggregates: 0, commandKinds: 0, decisionCount: 0, goals: 0, lastDecidedAt: null });
    expect(view.daemon.pid).toBe(process.pid);
    expect(view.daemon.nodeSpecsDir).toBeNull();
  });
});

describe("handleHealthReadRequest", () => {
  const port: HealthReadPort = {
    boundProjectId: "proj-0001",
    readHealth: () => ({ code: "HEALTH_READ_UNREADABLE", layer: "HEALTH_READ", outcome: "REFUSED" }),
  };
  const request = (body: Uint8Array) => ({ body, credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });

  it("gates on capability, port presence, project and body, then forwards", () => {
    expect(handleHealthReadRequest({ authenticator: authenticator([CAPABILITIES.PLANNING]), health: port }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "HEALTH_READ_CAPABILITY_DENIED" }, kind: "REPLY" });
    expect(handleHealthReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]) }, request(encoder.encode("{}"))))
      .toEqual({ code: "LISTENER_HEALTH_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(handleHealthReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), health: { ...port, boundProjectId: "elsewhere" } }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "HEALTH_READ_PROJECT_MISMATCH" } });
    expect(handleHealthReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), health: port }, request(encoder.encode('{"pid":1}'))))
      .toEqual({ code: "LISTENER_HEALTH_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    expect(handleHealthReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), health: port }, request(new Uint8Array())))
      .toEqual({ body: { code: "HEALTH_READ_UNREADABLE", layer: "HEALTH_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
  });
});

/**
 * The claude limit line as the shipped CLI prints it, with the MIDDOT transliterated to "-" so
 * this source stays ASCII. `lastLine` is carried, never parsed, so the glyph is not load-bearing.
 */
const CLAUDE_LINE = "You've hit your weekly limit - resets Sep 8, 10:46am (Asia/Jerusalem)";
const PAUSED = Object.freeze({
  lastLine: CLAUDE_LINE,
  provider: "claude",
  resetAt: "2026-09-02T20:30:00.000Z",
  since: "2026-09-02T20:00:00.000Z",
  workItemId: "node.deliver@node-1",
});

function readAt(store: SqliteEventStore, at: string): HealthView {
  return health(createHealthReadPort({
    clock: () => at, nodeSpecsDir: null, pid: 7, projectId: PROJECT_ID, readPlane: () => "V1",
    readVerifier: () => ({ calibration: true, policy: true }),
    startedAt: "2026-09-02T19:00:00.000Z", store, storePath: ":memory:",
  }).readHealth());
}

function pause(store: SqliteEventStore, provider: string, resetAt: string): void {
  const recorded = recordProviderPause(store, {
    cause: { lastLine: CLAUDE_LINE, workItemId: "node.deliver@node-1" },
    projectId: PROJECT_ID, provider, resetAt, since: "2026-09-02T20:00:00.000Z",
  });
  if (!recorded.ok) throw new Error(`pause not recorded: ${recorded.code}`);
}

describe("createHealthReadPort agents.paused", () => {
  it("says no provider is paused while the ledger holds no pause", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    expect(readAt(store, "2026-09-02T20:10:00.000Z").agents).toEqual({ paused: null });
  });

  it("carries the live claude pause with exactly the five keys the browser decodes", () => {
    const store = openStore();
    pause(store, "claude", "2026-09-02T20:30:00.000Z");
    const paused = readAt(store, "2026-09-02T20:10:00.000Z").agents.paused;
    expect(paused).toEqual(PAUSED);
    expect(paused === null ? [] : Object.keys(paused).sort())
      .toEqual(["lastLine", "provider", "resetAt", "since", "workItemId"]);
  });

  it("stops reporting the pause at the reset instant, not a millisecond later", () => {
    const store = openStore();
    pause(store, "claude", "2026-09-02T20:30:00.000Z");
    expect(readAt(store, "2026-09-02T20:29:59.999Z").agents.paused?.provider).toBe("claude");
    expect(readAt(store, "2026-09-02T20:30:00.000Z").agents.paused).toBeNull();
  });

  it("finds a codex pause when claude is clear, and prefers claude when both are paused", () => {
    const codexOnly = openStore();
    pause(codexOnly, "codex", "2026-09-02T20:30:00.000Z");
    expect(readAt(codexOnly, "2026-09-02T20:10:00.000Z").agents.paused?.provider).toBe("codex");
    const both = openStore();
    pause(both, "codex", "2026-09-02T21:00:00.000Z");
    pause(both, "claude", "2026-09-02T20:30:00.000Z");
    expect(readAt(both, "2026-09-02T20:10:00.000Z").agents.paused?.provider).toBe("claude");
  });

  it("carries a pause whose cause never named a line as an empty line, not a refusal", () => {
    const store = openStore();
    const recorded = recordProviderPause(store, {
      cause: { lastLine: null, workItemId: "node.deliver@node-2" },
      projectId: PROJECT_ID, provider: "claude", resetAt: "2026-09-02T20:30:00.000Z",
      since: "2026-09-02T20:00:00.000Z",
    });
    expect(recorded.ok).toBe(true);
    expect(readAt(store, "2026-09-02T20:10:00.000Z").agents.paused)
      .toEqual({ ...PAUSED, lastLine: "", workItemId: "node.deliver@node-2" });
  });

  it("refuses the whole read with HEALTH_READ_UNREADABLE when the store cannot be read", () => {
    const store = openStore();
    pause(store, "claude", "2026-09-02T20:30:00.000Z");
    store.close();
    const result = createHealthReadPort({
      clock: () => "2026-09-02T20:10:00.000Z", nodeSpecsDir: null, projectId: PROJECT_ID,
      readPlane: () => "V1", readVerifier: () => ({ calibration: true, policy: true }),
      startedAt: "2026-09-02T19:00:00.000Z", store, storePath: ":memory:",
    }).readHealth();
    expect(result).toEqual({
      code: "HEALTH_READ_UNREADABLE", layer: "HEALTH_READ", outcome: "REFUSED",
    });
  });
});
