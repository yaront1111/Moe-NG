import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { startDaemon } from "../../../apps/daemon/src/daemon-entry.js";
import type {
  DaemonDependencyProvider,
  StartedDaemon,
} from "../../../apps/daemon/src/daemon-entry.js";
import { readEventPage } from "../../../apps/daemon/src/http/event-stream.js";
import type { EventReadRequest } from "../../../apps/daemon/src/http/event-stream-contract.js";
import { streamPort } from "../../../apps/daemon/src/http/event-stream-fixtures.js";
import {
  CAPABILITY,
  GOOD_CREDENTIAL,
  authenticator,
  decisionPort,
  recordingHandler,
  registryOf,
} from "../../../apps/daemon/src/http/http-test-fixtures.js";
import { createCompatGate } from "../../../packages/control-room-client/src/index.js";
import { createControlRoomTransport } from "../../../packages/control-room-client/src/index.js";
import type {
  ControlRoomTransport,
  FetchLike,
} from "../../../packages/control-room-client/src/index.js";
import { GENERATED_CONTRACT_PINS } from "../../../packages/control-room-client/src/generated/generated-client.js";
import type { ControlRoomClientSurface } from "../../../packages/control-room-client/src/client-compat.js";

/**
 * The real consumer edge: a started daemon on one side, the shipped client
 * transport on the other, and a payload equality between them.
 *
 * The equality is the point. A 200, or "a response arrived", proves the socket
 * works; only comparing the transported payload against what the daemon's
 * IN-PROCESS handler returns for the SAME input proves the transport is
 * faithful rather than merely responsive.
 */
const CSRF = "integration-csrf-token";

/**
 * Every page frame carries ONE `DAEMON_WALL_CLOCK` reading stamped at encode time.
 * The equality below compares two independent encodes of the same page inside ONE
 * process (the daemon is started in-process and the transport is a loopback round
 * trip), so pinning `Date` makes both readings identical without dropping the field
 * from the comparison — a transport that stopped carrying the reading still fails.
 *
 * `toFake: ["Date"]` is load-bearing: the test awaits a REAL HTTP round trip, so
 * faking timers wholesale would hang the socket rather than fail the assertion.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const READ_REQUEST: EventReadRequest = Object.freeze({
  limit: 3,
  projection: "moe.board",
  subscriberId: "control-room-1",
});

function provider(): DaemonDependencyProvider {
  return {
    provide: () => ({
      authenticator: authenticator([CAPABILITY]),
      decisions: decisionPort(),
      registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
    }),
    // A FRESH port per daemon, and the in-process comparison below builds its
    // own. Sharing one stateful double would let a read mutate the baseline it
    // is being compared against.
    subscriptions: () => streamPort(),
  };
}

type CommandEnvelope = Parameters<ControlRoomTransport["sendCommand"]>[0];

/** Everything the client is fed comes through the compat gate, as in production. */
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
  if (!gate.ok) throw new Error("compat gate refused the matching report");
  return gate.client;
}

/**
 * The FETCH LAYER supplies `Origin`, exactly as a browser does.
 *
 * `Origin` is a forbidden header name, so the transport cannot set it: a browser
 * would drop whatever it sent and substitute its own. A non-browser caller must
 * therefore supply it here, and that is the only arrangement under which the
 * daemon's guard is exercised the way a real browser client exercises it. Setting
 * it inside the transport instead would satisfy the guard by a route no browser
 * can take — the illusion this whole seam exists to remove.
 */
function fetchSupplyingOrigin(origin: string): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    return await fetch(input, { ...init, headers });
  };
}

/**
 * `browserOrigin` undefined means NO wrapper: the shipped transport sends what
 * it sends, which is no Origin at all. That is a real caller shape, not a
 * contrivance, so it is spelled as the absence of a wrapper rather than as a
 * header the test deletes.
 */
function transportFor(daemon: StartedDaemon, browserOrigin?: string): ControlRoomTransport {
  return createControlRoomTransport({
    csrfToken: daemon.csrfToken,
    fetch: browserOrigin === undefined ? undefined : fetchSupplyingOrigin(browserOrigin),
    // Still the request URL PREFIX, and still correct: only the HEADER was ever
    // the defect, so a refusal below cannot be blamed on a missing target.
    origin: daemon.origin,
    sessionCredential: GOOD_CREDENTIAL,
    wireProtocolVersion: gatedSurface().wireProtocolVersion,
  });
}

/** Shut down on EVERY exit path: a leaked handle surfaces later as EBUSY, not as this error. */
async function withDaemon(
  run: (daemon: StartedDaemon, transport: ControlRoomTransport) => Promise<void>,
): Promise<void> {
  const started = await startDaemon({ csrfToken: CSRF, dependencies: provider() });
  if (!started.ok) throw new Error(`daemon refused to start: ${started.code}`);
  try {
    await run(started, transportFor(started, started.origin));
  } finally {
    await started.shutdown();
  }
}

it("transports a committed read whose payload EQUALS the in-process handler's", async () => {
  await withDaemon(async (_daemon, transport) => {
    const transported = await transport.readEventPage(READ_REQUEST);
    expect(transported).toMatchObject({ delivered: true, status: 200 });
    if (!transported.delivered) throw new Error("expected the daemon's answer to be delivered");

    // Same input, same fresh port state, compared as whole payloads. A transport
    // that dropped, renamed, reordered or re-typed one field fails here even
    // though the request would still have "worked".
    const inProcess = readEventPage(streamPort(), READ_REQUEST);
    expect(transported.response).toEqual(JSON.parse(JSON.stringify(inProcess)));
    // Not vacuous: the frame really carries the page it claims to.
    expect(inProcess).toMatchObject({ outcome: "PAGE" });
    expect((inProcess as { events: readonly unknown[] }).events.length).toBeGreaterThan(0);
  });
});

it("presents and exactly acknowledges an issued page before the next read advances", async () => {
  await withDaemon(async (_daemon, transport) => {
    const first = await transport.readEventPage(READ_REQUEST);
    if (!first.delivered || typeof first.response !== "object" || first.response === null) {
      throw new Error("expected the first page to be delivered");
    }
    const cursor = (first.response as { nextCursor?: unknown }).nextCursor;
    if (typeof cursor !== "object" || cursor === null) throw new Error("expected an issued cursor");

    const acknowledged = await transport.acknowledgeEventPage({
      presentedCursor: cursor as { generation: number; position: string },
      subscriberId: READ_REQUEST.subscriberId,
    });
    expect(acknowledged).toMatchObject({
      delivered: true,
      response: { cursor, outcome: "ACKNOWLEDGED" },
      status: 200,
    });

    const stale = await transport.acknowledgeEventPage({
      presentedCursor: cursor as { generation: number; position: string },
      subscriberId: READ_REQUEST.subscriberId,
    });
    expect(stale).toMatchObject({
      delivered: true,
      response: { code: "SUBSCRIPTION_CURSOR_NOT_ISSUED", layer: "STATE", outcome: "REFUSED" },
    });
  });
});

/** Always the GENERATED builder's envelope, so no hand-rolled shape reaches the daemon. */
function commandEnvelope(id: string): CommandEnvelope {
  const built = gatedSurface().commands["goal.create"](
    {
      commandEnvelopeVersion: GENERATED_CONTRACT_PINS.commandEnvelopeVersion,
      commandId: `cmd-${id}`,
      commandKind: "goal.create" as const,
      expectedVersion: 0,
      inputSchemaVersion: "goal.create/1",
      targetAggregateId: `goal-${id}`,
    },
    {
      correlationId: `corr-${id}`,
      payload: { title: "ship it" },
      requestDigest: "c".repeat(64),
      sessionCredential: GOOD_CREDENTIAL,
    },
  );
  if (!built.ok) throw new Error("generated builder refused the affordance fixture");
  return built.envelope;
}

it("carries a command to the committed adapter and returns its decision unchanged", async () => {
  await withDaemon(async (daemon, transport) => {
    const answer = await transport.sendCommand(commandEnvelope("integration-1"));
    expect(answer).toMatchObject({ delivered: true });
    if (!answer.delivered) throw new Error("expected the daemon's answer to be delivered");
    // ACCEPTED proves the fix that mattered: the listener hands the adapter
    // BYTES. While it passed a string, every well-formed command refused at
    // DECODE with JSON_INPUT_TYPE_INVALID and the socket still looked healthy.
    expect(answer.response).toMatchObject({ httpStatus: 200, ok: true, outcome: "ACCEPTED" });
    expect(daemon.port).toBeGreaterThan(0);
  });
});

it("refuses an unknown route with the LISTENER's specific code and layer", async () => {
  await withDaemon(async (daemon) => {
    const response = await fetch(`${daemon.origin}/not-a-route`, {
      body: "{}",
      headers: { "content-type": "application/json", origin: daemon.origin },
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "LISTENER_ROUTE_UNKNOWN",
      layer: "CONTROL_ROOM_LISTENER",
    });
  });
});

it("refuses a malformed body at the ADAPTER, not the listener, naming its stage", async () => {
  await withDaemon(async (daemon) => {
    const response = await fetch(`${daemon.origin}/command`, {
      body: "{not json",
      headers: {
        "content-type": "application/json",
        origin: daemon.origin,
        "x-moe-csrf": daemon.csrfToken,
        "x-moe-protocol-version": gatedSurface().wireProtocolVersion,
        "x-moe-session-credential": GOOD_CREDENTIAL,
      },
      method: "POST",
    });
    // Two layers can refuse here. Naming which one is the whole assertion: the
    // listener passed the headers, so the committed adapter's DECODE stage owns
    // this refusal and the listener must not have pre-empted it.
    expect(await response.json()).toMatchObject({
      ok: false,
      outcome: "REFUSED",
      stage: "DECODE",
    });
  });
});

/**
 * THE COVERAGE GAP THIS FILE EXISTS TO CLOSE.
 *
 * The daemon's Origin guard used to be reachable only through the vite dev proxy
 * or a hand-built request that happened to carry an Origin. The shipped transport
 * itself set the header, so in Node it satisfied the guard by a route no browser
 * can take, and in a browser the header was dropped before it left. Either way
 * the real client path never met the guard.
 *
 * All three arms below drive the REAL transport. The Origin the daemon sees comes
 * from the fetch layer or from nowhere — never from the transport's own headers.
 */
it("meets the daemon's Origin guard on the REAL transport path: admitted, foreign, absent", async () => {
  await withDaemon(async (daemon) => {
    // ADMITTED. The fetch layer supplies the matching Origin, as a browser does.
    const admitted = await transportFor(daemon, daemon.origin).sendCommand(
      commandEnvelope("origin-admitted"),
    );
    if (!admitted.delivered) throw new Error("expected the daemon's answer to be delivered");
    expect(admitted.status).toBe(200);
    // Named positively: the ADAPTER answered, so the listener passed it through.
    // "not refused" would still pass if a different listener guard had refused.
    expect(admitted.response).toMatchObject({ httpStatus: 200, ok: true, outcome: "ACCEPTED" });

    // FOREIGN. Same transport, same correct URL prefix, only the Origin differs.
    const foreign = await transportFor(daemon, "http://evil.example.com").sendCommand(
      commandEnvelope("origin-foreign"),
    );
    if (!foreign.delivered) throw new Error("expected the daemon's answer to be delivered");
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    // Exact code AND refusing layer. Two layers can refuse a /command request, so
    // naming which one answered is half the assertion.
    expect(foreign.response).toEqual({
      code: "LISTENER_ORIGIN_INVALID",
      layer: "CONTROL_ROOM_LISTENER",
    });

    // ABSENT. NO fetch wrapper, so the shipped transport sends exactly what it
    // sends — and it sets no Origin header. This arm is the one that was
    // impossible before: while headersFor set the header, this request was
    // admitted, and the guard looked covered while nothing exercised it.
    const absent = await transportFor(daemon).sendCommand(commandEnvelope("origin-absent"));
    if (!absent.delivered) throw new Error("expected the daemon's answer to be delivered");
    expect(absent.status).toBeGreaterThanOrEqual(400);
    expect(absent.response).toEqual({
      code: "LISTENER_ORIGIN_INVALID",
      layer: "CONTROL_ROOM_LISTENER",
    });
  });
});
