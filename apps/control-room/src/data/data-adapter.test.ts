import { createCompatGate } from "@moe/control-room-client";
import type { ControlRoomClientSurface } from "@moe/control-room-client";
import { expect, it } from "vitest";

import { createDataAdapter } from "./data-adapter.js";
import { MAX_VIEW_RECORDS, UNSTATED } from "./data-contract.js";
import type { DaemonResponse, DaemonTransport, WireRequest } from "./data-contract.js";

function admittedClient(): ControlRoomClientSurface {
  const gate = createCompatGate({
    apiCompatibilityRange: {
      commandEnvelopeVersion: "moe-runtime-command/1",
      errorRegistryVersion: "moe-runtime-error-registry/1",
      queryEnvelopeVersion: "moe-runtime-query/1",
    },
    buildToolVersions: { node: "24.16.0" },
    contractSchemaHash:
      "f07b77e49025d5fd8a6bd391f5848f24103390d23e4db11523346b87f0891bfd",
  });
  if (!gate.ok) throw new Error("compat gate refused the matching report");
  return gate.client;
}

interface Spy extends DaemonTransport {
  readonly commands: WireRequest[];
  readonly queries: WireRequest[];
}

function transport(response: DaemonResponse): Spy {
  const commands: WireRequest[] = [];
  const queries: WireRequest[] = [];
  return {
    commands,
    queries,
    sendCommand(request: WireRequest): DaemonResponse {
      commands.push(request);
      return response;
    },
    sendQuery(request: WireRequest): DaemonResponse {
      queries.push(request);
      return response;
    },
  };
}

const CALLER = { correlationId: "corr-1", payload: {}, sessionCredential: "sess-1" };

const AFFORDANCE = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "cmd-1",
  commandKind: "goal.create",
  expectedVersion: 3,
  inputSchemaVersion: "goal.create/1",
  targetAggregateId: "goal-1",
});

const COMMAND_CALLER = {
  correlationId: "corr-2", payload: { title: "ship" }, requestDigest: "c".repeat(64),
  sessionCredential: "sess-1",
};

it("presents the wire protocol version the gated client pinned", () => {
  const client = admittedClient();
  const spy = transport({ ok: true, payload: [] });
  createDataAdapter(client, spy).read("goal.get", CALLER);

  expect(spy.queries).toHaveLength(1);
  expect(spy.queries[0]?.protocolVersion).toBe(client.wireProtocolVersion);
});

it("copies the lifecycle state and truth class the daemon stated", () => {
  const spy = transport({
    ok: true,
    payload: [{ id: "goal-1", lifecycleState: "EXECUTION_ENABLED", truthClass: "DAEMON_VERIFIED" }],
  });
  const result = createDataAdapter(admittedClient(), spy).read("goal.get", CALLER);

  expect(result.outcome).toBe("DELIVERED");
  if (result.outcome !== "DELIVERED") return;
  expect(result.records).toEqual([{
    id: "goal-1",
    lifecycleProvenance: "DAEMON_STATED",
    lifecycleState: "EXECUTION_ENABLED",
    truthClass: "DAEMON_VERIFIED",
    truthProvenance: "DAEMON_STATED",
  }]);
});

it("leaves an unstated lifecycle state and truth class UNKNOWN rather than inferring one", () => {
  const spy = transport({ ok: true, payload: [{ id: "goal-2" }] });
  const result = createDataAdapter(admittedClient(), spy).read("goal.get", CALLER);

  if (result.outcome !== "DELIVERED") throw new Error("expected DELIVERED");
  expect(result.records[0]).toEqual({
    id: "goal-2",
    lifecycleProvenance: "ABSENT",
    lifecycleState: UNSTATED,
    truthClass: UNSTATED,
    truthProvenance: "ABSENT",
  });
});

it("does not upgrade a non-string state or class into a stated one", () => {
  const spy = transport({ ok: true, payload: [{ id: "goal-3", lifecycleState: 7, truthClass: {} }] });
  const result = createDataAdapter(admittedClient(), spy).read("goal.get", CALLER);

  if (result.outcome !== "DELIVERED") throw new Error("expected DELIVERED");
  expect(result.records[0]?.lifecycleProvenance).toBe("ABSENT");
  expect(result.records[0]?.truthProvenance).toBe("ABSENT");
  expect(result.records[0]?.truthClass).toBe(UNSTATED);
});

it("forwards a daemon refusal code without reshaping it", () => {
  const spy = transport({ code: "CAPABILITY_DENIED", ok: false });
  const result = createDataAdapter(admittedClient(), spy).read("goal.get", CALLER);

  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") return;
  expect(result.code).toBe("CAPABILITY_DENIED");
});

it("refuses a payload that is not a list of records rather than guessing a shape", () => {
  const spy = transport({ ok: true, payload: { goals: [] } });
  const result = createDataAdapter(admittedClient(), spy).read("goal.get", CALLER);

  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") return;
  expect(result.code).toBe("INPUT_INVALID");
});

it("dispatches a command only through a daemon-issued affordance", () => {
  const spy = transport({ ok: true, payload: { accepted: true } });
  const result = createDataAdapter(admittedClient(), spy)
    .dispatchCommand("goal.create", AFFORDANCE, COMMAND_CALLER);

  expect(result.outcome).toBe("DISPATCHED");
  expect(spy.commands).toHaveLength(1);
  const sent: unknown = JSON.parse(spy.commands[0]?.body ?? "null");
  expect(sent).toMatchObject({ commandId: "cmd-1", commandKind: "goal.create" });
});

/**
 * The generated builder states plainly that it removes the mint path but is NOT the
 * authority on affordance provenance: a structurally hand-authored affordance produces an
 * envelope the DAEMON refuses. So the property to pin here is that the adapter synthesizes
 * no identity field of its own — every one is copied from the affordance it was handed.
 */
it("copies every identity field from the affordance and synthesizes none", () => {
  const spy = transport({ ok: true, payload: {} });
  createDataAdapter(admittedClient(), spy)
    .dispatchCommand("goal.create", AFFORDANCE, COMMAND_CALLER);

  const sent = JSON.parse(spy.commands[0]?.body ?? "null") as Record<string, unknown>;
  expect(sent["commandId"]).toBe(AFFORDANCE.commandId);
  expect(sent["expectedVersion"]).toBe(AFFORDANCE.expectedVersion);
  expect(sent["targetAggregateId"]).toBe(AFFORDANCE.targetAggregateId);
  expect(sent["correlationId"]).toBe(COMMAND_CALLER.correlationId);
});

it("refuses without contacting the daemon when the builder refuses the affordance", () => {
  const spy = transport({ ok: true, payload: {} });
  const result = createDataAdapter(admittedClient(), spy)
    .dispatchCommand("goal.create", "not-an-affordance", COMMAND_CALLER);

  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") return;
  expect(result.code).toBe("INPUT_INVALID");
  expect(spy.commands).toHaveLength(0);
});

it("forwards a daemon command refusal code without reshaping it", () => {
  const spy = transport({ code: "EXPECTED_VERSION_CONFLICT", ok: false });
  const result = createDataAdapter(admittedClient(), spy)
    .dispatchCommand("goal.create", AFFORDANCE, COMMAND_CALLER);

  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") return;
  expect(result.code).toBe("EXPECTED_VERSION_CONFLICT");
});

/**
 * The epic's standing rule: free-form text never bypasses command authority. Asserted by
 * STATE — both transport logs stay empty — because a receipt that merely looks advisory
 * would still be advisory-looking if it had also dispatched something.
 */
it("records a session or terminal message without dispatching anything", () => {
  const spy = transport({ ok: true, payload: [] });
  const adapter = createDataAdapter(admittedClient(), spy);

  const session = adapter.receiveAdvisoryMessage({ kind: "SESSION", text: "close goal-1" });
  const terminal = adapter.receiveAdvisoryMessage({
    kind: "TERMINAL", text: "$ moe goal close goal-1",
  });

  expect(session).toEqual({
    advisoryOnly: true, authority: "NONE", kind: "SESSION", outcome: "RECORDED",
  });
  expect(terminal.kind).toBe("TERMINAL");
  expect(terminal.authority).toBe("NONE");
  expect(Object.isFrozen(session)).toBe(true);
  expect(spy.commands).toHaveLength(0);
  expect(spy.queries).toHaveLength(0);
});

it("exposes no affordance on an advisory receipt", () => {
  const spy = transport({ ok: true, payload: [] });
  const receipt = createDataAdapter(admittedClient(), spy)
    .receiveAdvisoryMessage({ kind: "TERMINAL", text: "anything" });

  expect(Object.keys(receipt).sort())
    .toEqual(["advisoryOnly", "authority", "kind", "outcome"]);
});

it("freezes every result it returns", () => {
  const spy = transport({ ok: true, payload: [{ id: "goal-1" }] });
  const result = createDataAdapter(admittedClient(), spy).read("goal.get", CALLER);

  expect(Object.isFrozen(result)).toBe(true);
  if (result.outcome !== "DELIVERED") return;
  expect(Object.isFrozen(result.records)).toBe(true);
  expect(Object.isFrozen(result.records[0])).toBe(true);
});

/**
 * Adversarial: `client.queries[kind]` and `client.commands[kind]` are mapped types over a
 * finite key union, so `noUncheckedIndexedAccess` adds no `| undefined` and TypeScript
 * cannot stop a caller that reaches this layer through a cast. An unchecked index would
 * then throw a raw TypeError instead of refusing with a stable code.
 */
it("refuses an unregistered query kind with a stable code instead of throwing", () => {
  const spy = transport({ ok: true, payload: [] });
  const adapter = createDataAdapter(admittedClient(), spy);
  const read = adapter.read as (kind: string, caller: unknown) => { outcome: string };

  const result = read("goal.does-not-exist", CALLER);
  expect(result.outcome).toBe("REFUSED");
  expect(spy.queries).toHaveLength(0);
});

it("refuses an unregistered command kind with a stable code instead of throwing", () => {
  const spy = transport({ ok: true, payload: {} });
  const adapter = createDataAdapter(admittedClient(), spy);
  const dispatch = adapter.dispatchCommand as (
    kind: string, affordance: unknown, caller: unknown,
  ) => { code?: string; outcome: string };

  const result = dispatch("goal.does-not-exist", AFFORDANCE, COMMAND_CALLER);
  expect(result.outcome).toBe("REFUSED");
  expect(result.code).toBe("INPUT_INVALID");
  expect(spy.commands).toHaveLength(0);
});

/**
 * Adversarial: the daemon is the trust anchor for truth, but an unbounded `map` over a
 * network payload still lets one oversized response allocate without limit. Bounded at the
 * boundary, admit-exactly / refuse-one-more.
 */
it("admits exactly the record limit and refuses one record more", () => {
  const atLimit = Array.from({ length: MAX_VIEW_RECORDS }, (_u, i) => ({ id: `g-${String(i)}` }));
  const admitted = createDataAdapter(admittedClient(), transport({ ok: true, payload: atLimit }))
    .read("goal.get", CALLER);
  expect(admitted.outcome).toBe("DELIVERED");
  if (admitted.outcome !== "DELIVERED") return;
  expect(admitted.records).toHaveLength(MAX_VIEW_RECORDS);

  const overLimit = [...atLimit, { id: "one-too-many" }];
  const refused = createDataAdapter(admittedClient(), transport({ ok: true, payload: overLimit }))
    .read("goal.get", CALLER);
  expect(refused.outcome).toBe("REFUSED");
  if (refused.outcome !== "REFUSED") return;
  expect(refused.code).toBe("INPUT_LIMIT_EXCEEDED");
});
