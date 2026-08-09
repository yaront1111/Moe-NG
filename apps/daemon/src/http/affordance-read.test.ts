import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { runSessionCommand } from "../identity/session-services.js";
import { readAffordanceRequest } from "./affordance-contract.js";
import { DEFAULT_SESSION_SUBJECT, createAffordancePort } from "./affordance-read.js";

const PROJECT = "proj-affordance";
const directory = mkdtempSync(join(tmpdir(), "moe-affordance-"));
const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);

let minted = 0;
const port = createAffordancePort({
  mintId: () => `afford-${String(minted += 1)}`,
  projectId: PROJECT,
  store,
});

afterAll(() => {
  store.close();
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();

function commitBootstrap(kind: string, payload: Record<string, unknown>): void {
  const outcome = runBootstrapCommand(store, encoder.encode(JSON.stringify({
    commandId: `cmd-${kind}-${String(minted += 1)}`,
    correlationId: "corr-1",
    decidedAt: "2026-08-09T12:00:00.000Z",
    expectedVersion: 0,
    kind,
    payload,
    principalId: "operator-local",
    projectId: PROJECT,
    schemaVersion: "moe-bootstrap-command/1",
  })));
  expect(outcome.ok).toBe(true);
}

function surface() {
  const result = port.readSurface();
  if (result.outcome !== "SURFACE") throw new Error(`refused: ${result.code}`);
  return result;
}

function step(kind: string) {
  const found = surface().steps.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no step for ${kind}`);
  return found;
}

describe("createAffordancePort", () => {
  it("offers only the chain roots on a fresh ledger, blocking the rest by name", () => {
    expect(step("project.register")).toMatchObject({ status: "READY", version: 0 });
    expect(step("policy.install")).toMatchObject({ status: "READY" });
    expect(step("project.activate")).toMatchObject({
      missing: ["project.register", "project.bind_repository", "provider.probe"],
      status: "BLOCKED",
    });
    expect(step("goal.create")).toMatchObject({
      missing: ["project.activate"], status: "BLOCKED",
    });
    const offered = surface().nextAllowedCommands.map((command) => command.commandKind);
    expect(offered).toContain("project.register");
    expect(offered).not.toContain("goal.create");
  });

  it("moves a committed kind to COMMITTED and unblocks its dependents", () => {
    commitBootstrap("project.register", { owner: "operator-local" });
    expect(step("project.register")).toMatchObject({ status: "COMMITTED", version: 1 });
    expect(step("project.bind_repository")).toMatchObject({ status: "READY", version: 1 });
    const bind = surface().nextAllowedCommands
      .find((command) => command.commandKind === "project.bind_repository");
    // The offered identity is the daemon's: minted id, ledger-read version.
    expect(bind).toMatchObject({ expectedVersion: 1, targetAggregateId: PROJECT });
    expect(bind?.commandId).toMatch(/^afford-/u);
  });

  it("offers session.close and session.renew for a durably open session", () => {
    const outcome = runSessionCommand(store, encoder.encode(JSON.stringify({
      commandId: "cmd-session-affordance",
      correlationId: "corr-2",
      decidedAt: "2026-08-09T12:01:00.000Z",
      expectedVersion: 0,
      kind: "session.open",
      payload: {
        capabilities: ["goal.write"], credentialSha256: "a".repeat(64),
        expiresAt: "2027-01-01T00:00:00.000Z", sessionId: DEFAULT_SESSION_SUBJECT,
      },
      principalId: "operator-local",
      projectId: PROJECT,
      schemaVersion: "moe-session-command/1",
    })));
    expect(outcome.ok).toBe(true);
    expect(step("session.open")).toMatchObject({ status: "COMMITTED" });
    const kinds = surface().nextAllowedCommands.map((command) => command.commandKind);
    expect(kinds).toContain("session.close");
    expect(kinds).toContain("session.renew");
  });
});

describe("readAffordanceRequest", () => {
  it("admits an empty object and refuses a malformed body", () => {
    expect(readAffordanceRequest(encoder.encode("{}"))).toEqual({});
    expect(readAffordanceRequest(encoder.encode("[]"))).toBeNull();
    expect(readAffordanceRequest(encoder.encode("{"))).toBeNull();
    expect(readAffordanceRequest(encoder.encode('{"projectId":7}'))).toBeNull();
  });
});
