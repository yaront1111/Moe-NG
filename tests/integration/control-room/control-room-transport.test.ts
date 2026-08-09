import { expect, it } from "vitest";

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
import type { ControlRoomTransport } from "../../../packages/control-room-client/src/index.js";
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

function transportFor(daemon: StartedDaemon): ControlRoomTransport {
  return createControlRoomTransport({
    csrfToken: daemon.csrfToken,
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
    await run(started, transportFor(started));
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

it("carries a command to the committed adapter and returns its decision unchanged", async () => {
  await withDaemon(async (daemon, transport) => {
    const affordance = {
      commandEnvelopeVersion: GENERATED_CONTRACT_PINS.commandEnvelopeVersion,
      commandId: "cmd-integration-1",
      commandKind: "goal.create" as const,
      expectedVersion: 0,
      inputSchemaVersion: "goal.create/1",
      targetAggregateId: "goal-integration-1",
    };
    const built = gatedSurface().commands["goal.create"](affordance, {
      correlationId: "corr-integration-1",
      payload: { title: "ship it" },
      requestDigest: "c".repeat(64),
      sessionCredential: GOOD_CREDENTIAL,
    });
    if (!built.ok) throw new Error("generated builder refused the affordance fixture");

    const answer = await transport.sendCommand(built.envelope);
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
