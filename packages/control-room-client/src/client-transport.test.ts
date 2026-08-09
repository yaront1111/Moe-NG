import { RUNTIME_COMMAND_ENVELOPE_VERSION, buildNextAllowedCommands } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { expect, it } from "vitest";

import { createCompatGate } from "./client-compat.js";
import type { ControlRoomClientSurface } from "./client-compat.js";
import {
  CONTROL_ROOM_TRANSPORT_LAYER,
  TRANSPORT_REFUSAL_CODES,
  createControlRoomTransport,
} from "./client-transport.js";
import type { ControlRoomTransport, TransportOptions } from "./client-transport.js";
import { GENERATED_CONTRACT_PINS } from "./generated/generated-client.js";
import type { CommandAffordance } from "./generated/generated-client.js";

/**
 * Everything the transport is fed comes through the COMPAT GATE, never from the
 * generated module directly. That is the whole consumer edge: the builders and
 * the protocol version are reachable only behind a matching pin, so a suite that
 * reached past the gate would prove the transport works in a configuration
 * production can never reach.
 */
function gatedSurface(): ControlRoomClientSurface {
  const gate = createCompatGate({
    apiCompatibilityRange: {
      commandEnvelopeVersion: GENERATED_CONTRACT_PINS.commandEnvelopeVersion,
      errorRegistryVersion: GENERATED_CONTRACT_PINS.errorRegistryVersion,
      queryEnvelopeVersion: GENERATED_CONTRACT_PINS.queryEnvelopeVersion,
    },
    buildToolVersions: { node: "24.16.0", typescript: "7.0.2" },
    contractSchemaHash: GENERATED_CONTRACT_PINS.contractDigest,
  });
  if (!gate.ok) throw new Error("compat gate refused the matching fixture report");
  return gate.client;
}

const ORIGIN = "http://127.0.0.1:54321";
const CSRF = "csrf-token-for-test";
const CREDENTIAL = "sess-transport-0001";

const AFFORDANCE_INPUT = Object.freeze({
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  commandId: "cmd-0001",
  commandKind: "goal.create",
  expectedVersion: 7,
  graphRevisionHash: "a".repeat(64),
  inputSchemaVersion: "goal.create/1",
  policyRevisionHash: "b".repeat(64),
  targetAggregateId: "goal-0001",
});

/** Built through the real contracts parser, so the fixture carries no hand-rolled shape. */
function affordance(): CommandAffordance<"goal.create"> {
  const built = buildNextAllowedCommands({ aggregate: "GOAL", state: "DRAFT" }, [AFFORDANCE_INPUT]);
  const first = built[0];
  if (first === undefined || first.commandKind !== "goal.create") {
    throw new Error("affordance fixture rejected by buildNextAllowedCommands");
  }
  return first as CommandAffordance<"goal.create">;
}

/**
 * The envelope always comes from the GENERATED builder. Hand-rolling one here
 * would let the client drift from the schema design section 17 requires HTTP,
 * MCP, UI and IDE to share, and the drift would be invisible to this suite.
 */
function builtEnvelope(): RuntimeCommandEnvelope {
  const result = gatedSurface().commands["goal.create"](affordance(), {
    correlationId: "corr-0001",
    payload: { title: "ship it" },
    requestDigest: "c".repeat(64),
    sessionCredential: CREDENTIAL,
  });
  if (!result.ok) throw new Error("generated builder refused the fixture affordance");
  return result.envelope;
}

interface Captured {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: string;
}

interface Stub {
  readonly calls: Captured[];
  readonly fetch: TransportOptions["fetch"];
}

function stubFetch(reply: () => Promise<Response>): Stub {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      body: String(init?.body ?? ""),
      headers: Object.fromEntries(headers.entries()),
      method: init?.method ?? "GET",
      url: String(input),
    });
    return await reply();
  };
  return { calls, fetch: fetch as TransportOptions["fetch"] };
}

function jsonReply(status: number, body: unknown): () => Promise<Response> {
  return async () =>
    await Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      }),
    );
}

function transportWith(stub: Stub): ControlRoomTransport {
  return createControlRoomTransport({
    csrfToken: CSRF,
    fetch: stub.fetch,
    origin: ORIGIN,
    sessionCredential: CREDENTIAL,
    wireProtocolVersion: gatedSurface().wireProtocolVersion,
  });
}

it("declares every refusal code it can emit in one frozen vocabulary", () => {
  expect(Object.isFrozen(TRANSPORT_REFUSAL_CODES)).toBe(true);
  expect(new Set(TRANSPORT_REFUSAL_CODES).size).toBe(TRANSPORT_REFUSAL_CODES.length);
  expect(CONTROL_ROOM_TRANSPORT_LAYER).toBe("CONTROL_ROOM_TRANSPORT");
});

it("sends the GENERATED builder's envelope verbatim, constructing none of its own", async () => {
  const stub = stubFetch(jsonReply(200, { ok: true }));
  const envelope = builtEnvelope();
  await transportWith(stub).sendCommand(envelope);

  const call = stub.calls[0];
  expect(call?.method).toBe("POST");
  // Byte-for-byte the builder's envelope: a hand-rolled or reshaped body fails here.
  expect(JSON.parse(call?.body ?? "null")).toEqual(envelope);
});

it("carries the credential in a HEADER and never in the URL", async () => {
  const stub = stubFetch(jsonReply(200, { ok: true }));
  await transportWith(stub).sendCommand(builtEnvelope());

  const call = stub.calls[0];
  // Design 19.2: credentials never appear in URLs. The whole URL is asserted,
  // not merely the absence of a query string, so a path-embedded token fails too.
  expect(call?.url).toBe(`${ORIGIN}/command`);
  expect(call?.url).not.toContain(CREDENTIAL);
  expect(call?.headers["x-moe-session-credential"]).toBe(CREDENTIAL);
  expect(call?.headers["x-moe-csrf"]).toBe(CSRF);
  expect(call?.headers["origin"]).toBe(ORIGIN);
  // Taken from the GATED surface, never restated, so a client whose pins failed
  // cannot announce a protocol version it does not implement.
  expect(call?.headers["x-moe-protocol-version"]).toBe(gatedSurface().wireProtocolVersion);
});

it("returns a daemon refusal with the daemon's OWN code and layer, re-coding nothing", async () => {
  const daemonRefusal = {
    error: { code: "AUTHENTICATION_FAILED" },
    httpStatus: 401,
    ok: false,
    outcome: "REFUSED",
    stage: "AUTHENTICATE",
  };
  const stub = stubFetch(jsonReply(401, daemonRefusal));
  const result = await transportWith(stub).sendCommand(builtEnvelope());

  // Delivered is TRUE: the daemon answered. Its answer is a refusal, which is
  // the daemon's business and not the transport's to translate.
  expect(result).toMatchObject({ delivered: true, status: 401 });
  if (!result.delivered) throw new Error("expected the daemon's answer to be delivered");
  expect(result.response).toEqual(daemonRefusal);
  // The proof there is no translation table: the daemon's code is not, and can
  // never become, a member of this layer's vocabulary.
  expect(TRANSPORT_REFUSAL_CODES as readonly string[]).not.toContain("AUTHENTICATION_FAILED");
});

it("distinguishes a transport failure from a daemon refusal by its own code", async () => {
  const stub = stubFetch(async () => await Promise.reject(new Error("socket refused")));
  const result = await transportWith(stub).sendCommand(builtEnvelope());

  expect(result).toMatchObject({
    code: "TRANSPORT_REQUEST_FAILED",
    delivered: false,
    layer: CONTROL_ROOM_TRANSPORT_LAYER,
  });
  // No daemon answer exists, so no daemon field may be invented for one.
  expect(result).not.toHaveProperty("response");
  expect(result).not.toHaveProperty("status");
});

it("refuses an unreadable answer with a DISTINCT code from a failed request", async () => {
  const stub = stubFetch(
    async () => await Promise.resolve(new Response("<html>not json</html>", { status: 200 })),
  );
  const result = await transportWith(stub).sendCommand(builtEnvelope());

  expect(result).toMatchObject({
    code: "TRANSPORT_RESPONSE_UNREADABLE",
    delivered: false,
    layer: CONTROL_ROOM_TRANSPORT_LAYER,
  });
});

it("reads an event page over the same header discipline and returns the frame verbatim", async () => {
  const frame = { events: [], outcome: "PAGE" };
  const stub = stubFetch(jsonReply(200, frame));
  const result = await transportWith(stub).readEventPage({
    limit: 2,
    projection: "goal",
    subscriberId: "sub-0001",
  });

  const call = stub.calls[0];
  expect(call?.url).toBe(`${ORIGIN}/events/read`);
  expect(call?.url).not.toContain(CREDENTIAL);
  expect(call?.headers["x-moe-session-credential"]).toBe(CREDENTIAL);
  expect(JSON.parse(call?.body ?? "null")).toEqual({
    limit: 2,
    projection: "goal",
    subscriberId: "sub-0001",
  });
  expect(result).toMatchObject({ delivered: true });
  if (!result.delivered) throw new Error("expected the daemon's answer to be delivered");
  expect(result.response).toEqual(frame);
});

it("reads the authenticated document dossier with an exact empty request", async () => {
  const dossier = {
    advisoryOnly: true,
    authority: "NONE",
    ok: true,
    outcome: "DOSSIER",
  };
  const stub = stubFetch(jsonReply(200, dossier));
  const result = await transportWith(stub).readDocumentDossier();

  const call = stub.calls[0];
  expect(call?.method).toBe("POST");
  expect(call?.url).toBe(`${ORIGIN}/documents/dossier/read`);
  expect(call?.url).not.toContain(CREDENTIAL);
  expect(call?.headers["x-moe-session-credential"]).toBe(CREDENTIAL);
  expect(call?.headers["x-moe-csrf"]).toBe(CSRF);
  expect(call?.headers["x-moe-protocol-version"]).toBe(gatedSurface().wireProtocolVersion);
  expect(call?.body).toBe("{}");
  expect(result).toMatchObject({ delivered: true, status: 200 });
  if (!result.delivered) throw new Error("expected the daemon's dossier answer to be delivered");
  expect(result.response).toEqual(dossier);
});
