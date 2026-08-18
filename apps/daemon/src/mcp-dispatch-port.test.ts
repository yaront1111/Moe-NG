import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const subscriptions = provider.subscriptions?.();
if (subscriptions === undefined) throw new Error("provider serves no subscription port");

const port = createMcpDispatchPort({
  deps: provider.provide(),
  fallbackCredential: CREDENTIAL,
  subscriptions,
});

afterAll(() => {
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

  it("refuses an async-only kind here, because this port has no asynchronous answer", () => {
    // MEASURED BOUNDARY, asserted rather than assumed: `StdioDispatchPort`'s
    // `dispatchCommandBytes(bytes): Uint8Array` is declared in @moe/mcp and returned
    // straight out of a synchronous stdio call site, so this transport cannot carry a
    // command whose service answers with a promise. It refuses with the seam's own
    // stable code instead of hanging or inventing a decision. The HTTP listener, whose
    // request handler is already async, serves the same kind through the async entry.
    const payload = {
      activationRequestBytesBase64: "AAAA", binding: {}, graphSnapshot: {},
      inputManifest: {}, launchTemplate: {},
    };
    const answer = decode(port.dispatchCommandBytes(encoder.encode(JSON.stringify({
      commandId: "cmd-mcp-foundation", commandKind: "foundation.dispatch",
      correlationId: "corr-mcp-foundation", expectedVersion: 0, payload,
      requestDigest: createHash("sha256")
        .update(encoder.encode(JSON.stringify(payload))).digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL, targetAggregateId: PROJECT,
    }))));

    expect(answer).toMatchObject({
      ok: false, outcome: "PORT_REFUSED",
      refusal: { code: "COMMAND_ASYNC_ENTRY_REQUIRED", layer: "DAEMON_COMMAND_SEAM" },
      stage: "DISPATCH",
    });
  });

  it("serves events.read as the SAME wire frame the HTTP listener serves, bigint and all", () => {
    // The committed ProjectRegistered above must come back as a serialisable PAGE.
    // The store's globalPosition is a bigint; the raw store page cannot cross
    // JSON.stringify, so a port that skipped the wire encoder answered every
    // successful read with UNKNOWN_ERROR — measured live on 2026-08-15.
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q1",
      payload: { limit: 10, projection: "moe.board", subscriberId: "control-room-1" },
      queryKind: "events.read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ outcome: "PAGE" });
    const events = answer["events"] as readonly Record<string, unknown>[];
    expect(events.map((event) => event["eventType"])).toContain("ProjectRegistered");
    for (const event of events) {
      expect(typeof event["globalPosition"]).toBe("string");
      expect(event["seamObservation"]).toMatchObject({ observer: "DAEMON_SEAM" });
    }
    expect(typeof answer["checkpoint"]).toBe("string");
  });

  it("refuses an unregistered subscriber with the seam's own code, verbatim", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q1b",
      payload: { projection: "moe.board", subscriberId: "nobody" },
      queryKind: "events.read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ code: "SUBSCRIPTION_NOT_REGISTERED", outcome: "REFUSED" });
  });

  it("refuses an out-of-bounds page limit before touching the port", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-q1c",
      payload: { limit: 0, projection: "moe.board", subscriberId: "control-room-1" },
      queryKind: "events.read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));
    expect(answer).toMatchObject({ code: "EVENT_STREAM_LIMIT_INVALID", outcome: "REFUSED" });
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
