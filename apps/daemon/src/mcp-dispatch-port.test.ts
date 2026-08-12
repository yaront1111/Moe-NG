import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";

const CREDENTIAL = "mcp-operator-credential";
const PROJECT = "proj-mcp-port";

const directory = mkdtempSync(join(tmpdir(), "moe-mcp-port-"));
const storePath = join(directory, "store.db");
const provider = createStoreDependencies({
  clock: () => "2026-08-09T12:00:00.000Z",
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();
const eventSource = SqliteEventStore.open(storePath);
const database = new DatabaseSync(storePath);

const port = createMcpDispatchPort({
  credential: CREDENTIAL,
  database,
  deps: provider.provide(),
  store: eventSource,
});

afterAll(() => {
  database.close();
  eventSource.close();
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

describe("createMcpDispatchPort", () => {
  it("refuses an unknown credential with the registry code", () => {
    const outcome = port.authenticate("wrong", "goal.create");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("admits the operator credential", () => {
    expect(port.authenticate(CREDENTIAL, "goal.create")).toEqual({ ok: true });
  });

  it("dispatches a command through the committed adapter to a durable decision", () => {
    const payload = { owner: "operator-local" };
    const envelope = {
      commandId: "cmd-mcp-register",
      commandKind: "project.register",
      correlationId: "corr-mcp-1",
      expectedVersion: 0,
      payload,
      requestDigest: createHash("sha256")
        .update(encoder.encode(JSON.stringify(payload))).digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
      targetAggregateId: PROJECT,
    };
    const answer = decode(port.dispatchCommandBytes(encoder.encode(JSON.stringify(envelope))));
    expect(answer).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });
  });

  it("serves events.read from the committed subscription seam", () => {
    // Fresh store, no generation published by this port: the honest refusal.
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q1",
      payload: { projection: "moe.board", subscriberId: "control-room-1" },
      queryKind: "events.read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({
      code: "SUBSCRIPTION_GENERATION_MISSING",
      layer: "STATE",
      outcome: "REFUSED",
    });
  });

  it("refuses every other query kind with the stable INPUT_INVALID", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q2",
      payload: {},
      queryKind: "goal.list",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ error: { code: "INPUT_INVALID" }, ok: false });
  });
});
