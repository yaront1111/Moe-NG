import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { expect, it } from "vitest";

import { handleCommandRequest } from "./http-adapter.js";
import {
  HTTP_BOUNDARY_ERROR_CODES,
  MAX_COMMAND_PAYLOAD_FIELDS,
  buildCommandRegistry,
} from "./http-contract.js";
import type { CommandAdapterDeps, HttpCommandResult } from "./http-contract.js";
import {
  CAPABILITY,
  DEEPEST_ADMITTED_CONTAINERS,
  UNDECODABLE_BODY,
  authenticator,
  bytes,
  decisionPort,
  envelopeObject,
  envelopeOfExactByteLength,
  nestedPayload,
  payloadWithFieldCount,
  recordingHandler,
  refusingDecisionPort,
  registryOf,
  request,
} from "./http-test-fixtures.js";

const PAYLOAD_KEYS = ["title"] as const;

function deps(options: {
  readonly capabilities?: readonly string[];
  readonly payloadKeys?: readonly string[];
} = {}): CommandAdapterDeps & { readonly calls: { count: number } } {
  const handler = recordingHandler();
  return {
    authenticator: authenticator(options.capabilities ?? [CAPABILITY]),
    calls: handler.calls,
    decisions: decisionPort(),
    registry: registryOf("goal.create", handler.handler, options.payloadKeys ?? PAYLOAD_KEYS),
  };
}

function codeOf(result: HttpCommandResult): string {
  if (result.outcome === "ACCEPTED") return "ACCEPTED";
  if (result.outcome === "PORT_REFUSED") return result.refusal.code;
  return result.error.code;
}

it("refuses an unauthenticated request before the body is decoded", () => {
  const wired = deps();
  const result = handleCommandRequest(wired, request({
    body: UNDECODABLE_BODY,
    credential: "sess-unknown",
  }));

  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") return;
  expect(result.error.code).toBe("AUTHENTICATION_FAILED");
  expect(result.stage).toBe("AUTHENTICATE");
  expect(result.httpStatus).toBe(401);
  expect(wired.calls.count).toBe(0);
});

it("refuses an unauthenticated oversize body with the authentication code, not the bound", () => {
  const wired = deps();
  const oversize = new Uint8Array(MAX_JSON_BODY_BYTES + 1);
  const result = handleCommandRequest(wired, request({ body: oversize, credential: null }));

  expect(codeOf(result)).toBe("AUTHENTICATION_FAILED");
});

it("refuses an unauthorized request distinctly from an unauthenticated one", () => {
  const wired = deps({ capabilities: [] });
  const denied = handleCommandRequest(wired, request());
  const unknown = handleCommandRequest(deps(), request({ credential: null }));

  expect(denied.outcome).toBe("REFUSED");
  if (denied.outcome !== "REFUSED") return;
  expect(denied.error.code).toBe("CAPABILITY_DENIED");
  expect(denied.stage).toBe("AUTHORIZE");
  expect(denied.httpStatus).toBe(403);
  expect(codeOf(unknown)).toBe("AUTHENTICATION_FAILED");
  expect(denied.error.code).not.toBe(codeOf(unknown));
  expect(wired.calls.count).toBe(0);
});

it("returns identical refusals whether or not the target exists", () => {
  const existing = envelopeObject({ targetAggregateId: "goal-0001" });
  const missing = envelopeObject({ targetAggregateId: "goal-does-not-exist" });

  const deniedExisting = handleCommandRequest(
    deps({ capabilities: [] }), request({ body: bytes(existing) }),
  );
  const deniedMissing = handleCommandRequest(
    deps({ capabilities: [] }), request({ body: bytes(missing) }),
  );
  expect(deniedExisting).toEqual(deniedMissing);

  const unknownExisting = handleCommandRequest(
    deps(), request({ body: bytes(existing), credential: null }),
  );
  const unknownMissing = handleCommandRequest(
    deps(), request({ body: bytes(missing), credential: null }),
  );
  expect(unknownExisting).toEqual(unknownMissing);
});

it("refuses an incompatible wire protocol version before the body is decoded", () => {
  const result = handleCommandRequest(deps(), request({
    body: UNDECODABLE_BODY,
    protocolVersion: "moe-runtime-command/0+moe-runtime-query/0+moe-runtime-error-registry/0",
  }));

  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") return;
  expect(result.error.code).toBe("DISTRIBUTION_MISMATCH");
  expect(result.stage).toBe("COMPATIBILITY");
});

it("refuses an absent or non-string wire protocol version", () => {
  expect(codeOf(handleCommandRequest(deps(), request({ protocolVersion: null }))))
    .toBe("DISTRIBUTION_MISMATCH");
  expect(codeOf(handleCommandRequest(deps(), request({ protocolVersion: 1 }))))
    .toBe("DISTRIBUTION_MISMATCH");
});

it("admits a body of exactly the byte limit and refuses one byte more", () => {
  const wired = deps({ payloadKeys: ["p0", "p1", "p2", "p3", "p4", "p5"] });
  const atLimit = envelopeOfExactByteLength(MAX_JSON_BODY_BYTES);
  expect(atLimit.length).toBe(MAX_JSON_BODY_BYTES);
  expect(handleCommandRequest(wired, request({ body: atLimit })).outcome).toBe("ACCEPTED");

  const overLimit = envelopeOfExactByteLength(MAX_JSON_BODY_BYTES + 1);
  const refused = handleCommandRequest(wired, request({ body: overLimit }));
  expect(refused.outcome).toBe("REFUSED");
  if (refused.outcome !== "REFUSED") return;
  expect(refused.error.code).toBe("INPUT_LIMIT_EXCEEDED");
  expect(refused.stage).toBe("DECODE");
  expect(refused.error.details["limitName"]).toBe("JSON_BODY_BYTES");
});

it("admits the deepest allowed nesting and refuses one container more", () => {
  const wired = deps({ payloadKeys: ["deep"] });
  const admitted = bytes(envelopeObject({
    payload: nestedPayload(DEEPEST_ADMITTED_CONTAINERS),
  }));
  expect(handleCommandRequest(wired, request({ body: admitted })).outcome).toBe("ACCEPTED");

  const tooDeep = bytes(envelopeObject({
    payload: nestedPayload(DEEPEST_ADMITTED_CONTAINERS + 1),
  }));
  const refused = handleCommandRequest(wired, request({ body: tooDeep }));
  expect(codeOf(refused)).toBe("INPUT_LIMIT_EXCEEDED");
  if (refused.outcome !== "REFUSED") return;
  expect(refused.error.details["limitName"]).toBe("JSON_DEPTH");
});

it("admits exactly the payload field limit and refuses one field more", () => {
  const keys = Array.from(
    { length: MAX_COMMAND_PAYLOAD_FIELDS + 1 },
    (_unused, index) => `f${String(index)}`,
  );
  const wired = deps({ payloadKeys: keys });

  const atLimit = bytes(envelopeObject({
    payload: payloadWithFieldCount(MAX_COMMAND_PAYLOAD_FIELDS),
  }));
  expect(handleCommandRequest(wired, request({ body: atLimit })).outcome).toBe("ACCEPTED");

  const overLimit = bytes(envelopeObject({
    payload: payloadWithFieldCount(MAX_COMMAND_PAYLOAD_FIELDS + 1),
  }));
  const refused = handleCommandRequest(wired, request({ body: overLimit }));
  expect(refused.outcome).toBe("REFUSED");
  if (refused.outcome !== "REFUSED") return;
  expect(refused.error.code).toBe("INPUT_LIMIT_EXCEEDED");
  expect(refused.stage).toBe("PAYLOAD_SHAPE");
  expect(refused.error.details["limitName"]).toBe("COMMAND_PAYLOAD_FIELDS");
});

it("refuses an unknown command kind rather than ignoring it", () => {
  const wired = deps();
  const result = handleCommandRequest(wired, request({
    body: bytes(envelopeObject({ commandKind: "goal.cancel" })),
  }));

  expect(result.outcome).toBe("REFUSED");
  if (result.outcome !== "REFUSED") return;
  expect(result.error.code).toBe("INPUT_INVALID");
  expect(result.stage).toBe("REGISTRY");
  expect(wired.calls.count).toBe(0);
});

it("refuses a payload carrying a key the registry entry does not list", () => {
  const wired = deps();
  const result = handleCommandRequest(wired, request({
    body: bytes(envelopeObject({ payload: { smuggled: 1, title: "ship it" } })),
  }));

  expect(codeOf(result)).toBe("INPUT_INVALID");
  if (result.outcome !== "REFUSED") return;
  expect(result.stage).toBe("PAYLOAD_SHAPE");
  expect(wired.calls.count).toBe(0);
});

it("refuses an empty registry rather than dispatching anything", () => {
  const wired: CommandAdapterDeps = {
    authenticator: authenticator(),
    decisions: decisionPort(),
    registry: buildCommandRegistry([]),
  };
  expect(codeOf(handleCommandRequest(wired, request()))).toBe("INPUT_INVALID");
});

/**
 * Set equality in both directions: every declared code is reachable, and no refusal path
 * produces a code outside the declared list. An ad-hoc error string added later fails the
 * second direction; a code declared but never raised fails the first.
 */
it("produces exactly the declared wire error vocabulary across every refusal path", () => {
  const probes: readonly (() => HttpCommandResult)[] = [
    () => handleCommandRequest(deps(), request({ credential: null })),
    () => handleCommandRequest(deps({ capabilities: [] }), request()),
    () => handleCommandRequest(deps(), request({ protocolVersion: "wrong" })),
    () => handleCommandRequest(deps(), request({ body: UNDECODABLE_BODY })),
    () => handleCommandRequest(deps(), request({
      body: new Uint8Array(MAX_JSON_BODY_BYTES + 1),
    })),
    () => handleCommandRequest(deps(), request({
      body: bytes({ ...envelopeObject(), schemaVersion: "moe-runtime-command/0" }),
    })),
  ];

  expect(probes.length).toBe(6);
  const observed = new Set<string>();
  for (const probe of probes) {
    const result = probe();
    expect(result.outcome).toBe("REFUSED");
    observed.add(codeOf(result));
  }

  expect([...observed].sort()).toEqual([...HTTP_BOUNDARY_ERROR_CODES].sort());
});

/**
 * Idempotency asserted by STATE. "It did not error the second time" is exactly what a
 * double write also looks like, so the effect log length carries the assertion and the
 * response equality only confirms the decision is the same one.
 */
it("replays a command to the same decision without a second durable effect", () => {
  const handler = recordingHandler();
  const port = decisionPort();
  const wired: CommandAdapterDeps = {
    authenticator: authenticator(),
    decisions: port,
    registry: registryOf("goal.create", handler.handler, PAYLOAD_KEYS),
  };

  const first = handleCommandRequest(wired, request());
  const second = handleCommandRequest(wired, request());

  expect(first.outcome).toBe("ACCEPTED");
  expect(second.outcome).toBe("ACCEPTED");
  if (first.outcome !== "ACCEPTED" || second.outcome !== "ACCEPTED") return;
  expect(second.decision.effectId).toBe(first.decision.effectId);
  expect(second.decision.resultCode).toBe(first.decision.resultCode);
  expect(first.decision.disposition).toBe("DECIDED");
  expect(second.decision.disposition).toBe("REPLAYED");
  expect(port.effects.length).toBe(1);
  expect(handler.calls.count).toBe(1);
});

it("keys the durable decision on the authenticated principal, not on the body", () => {
  const handler = recordingHandler();
  const port = decisionPort();
  const wired: CommandAdapterDeps = {
    authenticator: authenticator(),
    decisions: port,
    registry: registryOf("goal.create", handler.handler, PAYLOAD_KEYS),
  };

  handleCommandRequest(wired, request());
  handleCommandRequest(wired, request({
    body: bytes(envelopeObject({ commandId: "cmd-0002" })),
  }));

  expect(port.effects.length).toBe(2);
  expect(port.keys).toEqual([
    { commandId: "cmd-0001", principalId: "prin-0001", projectId: "proj-0001" },
    { commandId: "cmd-0002", principalId: "prin-0001", projectId: "proj-0001" },
  ]);
});

it("passes a port refusal through with its own code and layer", () => {
  const wired: CommandAdapterDeps = {
    authenticator: authenticator(),
    decisions: refusingDecisionPort(),
    registry: registryOf("goal.create", recordingHandler().handler, PAYLOAD_KEYS),
  };
  const result = handleCommandRequest(wired, request());

  expect(result.outcome).toBe("PORT_REFUSED");
  if (result.outcome !== "PORT_REFUSED") return;
  expect(result.refusal.code).toBe("IDEMPOTENCY_CONFLICT");
  expect(result.refusal.layer).toBe("DURABLE_DECISION");
  expect(result.httpStatus).toBe(409);
  expect(result.stage).toBe("DISPATCH");
});

it("keeps every refusal frozen and free of the presented credential", () => {
  const result = handleCommandRequest(deps(), request({ credential: "sess-leak-me" }));
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("sess-leak-me");
});

/**
 * Adversarial: a duplicate registration silently overwriting an earlier entry would let a
 * laxer capability replace a stricter one at startup with no signal. Registry construction
 * is startup code, so failing closed there is the safe direction.
 */
it("refuses to build a registry that registers one kind twice", () => {
  const entry = {
    handler: recordingHandler().handler,
    kind: "goal.create" as const,
    payloadKeys: PAYLOAD_KEYS,
    requiredCapability: CAPABILITY,
  };
  expect(() => buildCommandRegistry([entry, { ...entry, requiredCapability: "weaker" }]))
    .toThrow(/goal\.create/u);
  expect(() => buildCommandRegistry([entry])).not.toThrow();
});
