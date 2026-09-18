import { RUNTIME_QUERY_ENVELOPE_VERSION } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import type { SubscriptionPort } from "./http/event-stream-contract.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import {
  GOOD_CREDENTIAL, authenticator, bytes, envelopeObject, recordingHandler, registryOf,
} from "./http/http-test-fixtures.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import type { McpFaultFrame } from "./mcp-dispatch-port.js";

/**
 * A frame that reports the daemon's OWN fault, answered to a seat over MCP. The seat receives
 * exactly the bytes it always did; the port now also says host-side which kind, on which
 * surface, was answered with which fault. The listener has LISTENER_FAULT_FRAME for the same
 * reason; this is the seat-side twin.
 */

const STORE_REFUSED = Object.freeze({
  outcome: "REFUSED" as const,
  refusal: { code: "OUTCOME_UNKNOWN", detail: "database is locked", httpStatus: 503, layer: "DURABLE_STORE" },
});

const subscriptions: SubscriptionPort = {
  acknowledge: () => { throw new Error("not reached"); },
  readPage: () => { throw new Error("not reached"); },
  reseat: () => { throw new Error("not reached"); },
};

function deps(overrides: Partial<CommandAdapterDeps> = {}): CommandAdapterDeps {
  return {
    authenticator: authenticator(),
    decisions: { decide: () => STORE_REFUSED },
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
    ...overrides,
  };
}

const decode = (answer: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(answer)) as Record<string, unknown>;

const eventsRead = bytes({
  correlationId: "corr-fault-frame",
  payload: { projection: "moe.board", subscriberId: "control-room-1" },
  queryKind: "events.read",
  schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
  sessionCredential: GOOD_CREDENTIAL,
});

describe("createMcpDispatchPort fault frame disclosure", () => {
  it("names a command answered with the durable store's 503 frame, bytes unchanged", async () => {
    const frames: McpFaultFrame[] = [];
    const port = createMcpDispatchPort({
      deps: deps(), fallbackCredential: GOOD_CREDENTIAL, onFaultFrame: (frame) => { frames.push(frame); }, subscriptions,
    });

    const answer = decode(await port.dispatchCommandBytes(bytes(envelopeObject())));

    expect(answer).toMatchObject({ outcome: "PORT_REFUSED", refusal: { code: "OUTCOME_UNKNOWN", layer: "DURABLE_STORE" } });
    expect(frames).toEqual([{ code: "OUTCOME_UNKNOWN", kind: "goal.create", layer: "DURABLE_STORE", surface: "command" }]);
  });

  it("names a query answered with an UNREADABLE refusal, with the verbatim query kind", () => {
    const frames: McpFaultFrame[] = [];
    const port = createMcpDispatchPort({
      deps: deps({
        eventStreamAccess: {
          authorize: () => ({
            code: "EVENT_STREAM_ACCESS_UNREADABLE" as never, httpStatus: 503, layer: "DAEMON_AUTHORIZATION", ok: false,
          }),
        },
      }),
      fallbackCredential: GOOD_CREDENTIAL,
      onFaultFrame: (frame) => { frames.push(frame); },
      subscriptions,
    });

    const answer = decode(port.dispatchQueryBytes(eventsRead));

    expect(answer).toMatchObject({ code: "EVENT_STREAM_ACCESS_UNREADABLE", outcome: "REFUSED" });
    expect(frames).toEqual([{
      code: "EVENT_STREAM_ACCESS_UNREADABLE", kind: "events.read", layer: "DAEMON_AUTHORIZATION", surface: "query",
    }]);
  });

  it("says nothing for a verdict that is not a fault, and for a query the port itself refused", async () => {
    const frames: McpFaultFrame[] = [];
    const port = createMcpDispatchPort({
      deps: deps({
        decisions: {
          decide: () => ({
            outcome: "REFUSED",
            refusal: { code: "GOAL_NOT_FOUND", detail: "no such goal", httpStatus: 404, layer: "DAEMON_GOALS" },
          }),
        },
      }),
      fallbackCredential: GOOD_CREDENTIAL,
      onFaultFrame: (frame) => { frames.push(frame); },
      subscriptions,
    });

    expect(decode(await port.dispatchCommandBytes(bytes(envelopeObject())))).toMatchObject({ outcome: "PORT_REFUSED" });
    expect(decode(port.dispatchQueryBytes(bytes({ queryKind: "no.such.kind" })))).toMatchObject({ ok: false });
    expect(frames).toEqual([]);
  });

  it("answers the same bytes with no observer, and when the observer throws", async () => {
    const silent = createMcpDispatchPort({ deps: deps(), fallbackCredential: GOOD_CREDENTIAL, subscriptions });
    const throwing = createMcpDispatchPort({
      deps: deps(), fallbackCredential: GOOD_CREDENTIAL, onFaultFrame: () => { throw new Error("sink closed"); }, subscriptions,
    });

    const expected = decode(await silent.dispatchCommandBytes(bytes(envelopeObject())));
    expect(decode(await throwing.dispatchCommandBytes(bytes(envelopeObject())))).toEqual(expected);
    expect(expected).toMatchObject({ refusal: { code: "OUTCOME_UNKNOWN" } });
  });
});
