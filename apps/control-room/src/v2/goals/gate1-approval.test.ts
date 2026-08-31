/**
 * The Gate 1 read mapper and the approval dispatch: every identity in the
 * dispatched payload must be the DAEMON's (the minted commandId and subject
 * digest from the pending answer), with `issuedAt` the one local fact.
 */
import { describe, expect, it } from "vitest";

import {
  GATE1_PENDING_READ_PATH,
  createGate1ApprovalPort,
  mapGate1Answer,
} from "./gate1-approval.js";
import type { Gate1PendingView } from "./gate1-approval.js";

const AFFORDANCE = Object.freeze({
  commandEnvelopeVersion: "moe-command-envelope/1",
  commandId: "gate1-cmd-1",
  commandKind: "product_contract.approve_gate_1",
  expectedVersion: 0,
  inputSchemaVersion: "moe-product-contract-gate-1/1",
  targetAggregateId: `product-contract-gate-1-${"a".repeat(64)}`,
});

const PENDING_BODY = Object.freeze({
  approval: {
    affordance: AFFORDANCE,
    commandId: "gate1-cmd-1",
    requestDigest: "b".repeat(64),
  },
  outcome: "PENDING",
  ref: {
    contractId: "contract-1", revisionDigest: "c".repeat(64), revisionId: "rev-1",
  },
  revision: {
    contractId: "contract-1",
    criteria: [{ criterionId: "crit-1", statement: "It works.", requirementId: "req-1" }],
    requirements: [{ requirementId: "req-1", statement: "Users can sign in." }],
    revisionId: "rev-1",
  },
});

describe("mapGate1Answer", () => {
  it("reads Gate 1 only from the activated /2 query plane", () => {
    expect(GATE1_PENDING_READ_PATH).toBe("/v2/product-contract/pending/read");
  });

  it("maps a PENDING frame with the daemon-minted approval verbatim", () => {
    const mapped = mapGate1Answer(200, PENDING_BODY);
    if (mapped.status !== "PENDING") throw new Error(`expected PENDING, got ${mapped.status}`);
    if (mapped.approval === null) throw new Error("approval withheld with nothing open");
    expect(mapped.approval.commandId).toBe("gate1-cmd-1");
    expect(mapped.approval.requestDigest).toBe("b".repeat(64));
    expect(mapped.approval.affordance).toEqual(AFFORDANCE);
    expect(mapped.requirements).toEqual([
      { requirementId: "req-1", statement: "Users can sign in." },
    ]);
    expect(mapped.criteria).toEqual([{ criterionId: "crit-1", statement: "It works." }]);
    expect(mapped.contractId).toBe("contract-1");
  });

  it("maps NONE, refusals and drifted shapes to their own outcomes", () => {
    expect(mapGate1Answer(200, { outcome: "NONE" })).toEqual({ status: "NONE" });
    expect(mapGate1Answer(200, { code: "X", layer: "L", outcome: "REFUSED" }))
      .toEqual({ code: "X", layer: "L", status: "REFUSED" });
    expect(mapGate1Answer(403, { code: "LISTENER_ORIGIN_INVALID", layer: "LISTENER" }))
      .toEqual({ code: "LISTENER_ORIGIN_INVALID", layer: "LISTENER", status: "REFUSED" });
    // A criterion whose statement is missing reddens the WHOLE answer.
    const drifted = {
      ...PENDING_BODY,
      revision: { ...PENDING_BODY.revision, criteria: [{ criterionId: "crit-1" }] },
    };
    expect(mapGate1Answer(200, drifted))
      .toEqual({ code: "GATE1_RESPONSE_INVALID", layer: "CONTROL_ROOM_GATE1", status: "ERROR" });
  });
});

describe("createGate1ApprovalPort", () => {
  const pending = mapGate1Answer(200, PENDING_BODY) as Gate1PendingView;

  function wireCapture() {
    const calls: { affordance: unknown; caller: Record<string, unknown> }[] = [];
    const sent: unknown[] = [];
    return {
      calls,
      sent,
      wire: {
        client: {
          commands: new Proxy({}, {
            get: () => (affordance: unknown, caller: Record<string, unknown>) => {
              calls.push({ affordance, caller });
              const payload = caller["payload"] as {
                authentication?: { requestId: string };
              };
              return {
                envelope: { commandId: payload.authentication?.requestId ?? "cmd-any" },
                ok: true,
              };
            },
          }) as never,
        },
        sessionCredential: "session-secret",
        transport: {
          sendCommand: (envelope: unknown) => {
            sent.push(envelope);
            return Promise.resolve({
              delivered: true as const, response: { ok: true }, status: 200,
            });
          },
        },
      },
    };
  }

  it("presents exactly the daemon-minted identity plus a fresh issuedAt", async () => {
    const { calls, wire } = wireCapture();
    const outcome = await createGate1ApprovalPort(wire as never).submit(pending);
    expect(outcome).toEqual({ commandId: "gate1-cmd-1", ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0] as { affordance: unknown; caller: Record<string, unknown> };
    expect(call.affordance).toEqual(AFFORDANCE);
    const payload = call.caller["payload"] as Record<string, unknown>;
    expect(Object.keys(payload).sort())
      .toEqual(["authentication", "contractId", "revisionDigest", "revisionId"]);
    const authentication = payload["authentication"] as Record<string, unknown>;
    expect(authentication["kind"]).toBe("BEARER");
    expect(authentication["requestId"]).toBe("gate1-cmd-1");
    expect(authentication["requestDigest"]).toBe("b".repeat(64));
    expect(typeof authentication["issuedAt"]).toBe("number");
    expect(call.caller["sessionCredential"]).toBe("session-secret");
  });

  it("withholds submit while the template is withheld, and answers by selected option id", async () => {
    const { calls, wire } = wireCapture();
    const port = createGate1ApprovalPort(wire as never);
    expect(await port.submit({ ...pending, approval: null })).toEqual({
      code: "GATE1_APPROVAL_WITHHELD", layer: "CONTROL_ROOM_GATE1", ok: false,
    });
    expect(calls).toHaveLength(0);

    const clarification = {
      answerAffordance: { ...AFFORDANCE, commandKind: "product_contract.answer_clarification" },
      answered: false,
      clarificationId: "clar-abc",
      optionDigests: [{ optionId: "opt-a", projectionDigest: "f".repeat(64) }],
      options: [{ label: "Option A", optionId: "opt-a" }],
      question: "Which way?",
    };
    await port.answer(clarification, "opt-a", "contract-1");
    expect(calls).toHaveLength(1);
    const payload = (calls[0] as { caller: Record<string, unknown> }).caller["payload"] as
      Record<string, unknown>;
    expect(payload).toEqual({
      answerOptionId: "opt-a",
      clarificationId: "clar-abc",
      contractId: "contract-1",
    });
    // An unknown option or a retired affordance dispatches nothing.
    expect(await port.answer(clarification, "opt-missing", "contract-1")).toEqual({
      code: "GATE1_ANSWER_UNAVAILABLE", layer: "CONTROL_ROOM_GATE1", ok: false,
    });
    expect(await port.answer(
      { ...clarification, answerAffordance: null }, "opt-a", "contract-1",
    )).toEqual({ code: "GATE1_ANSWER_UNAVAILABLE", layer: "CONTROL_ROOM_GATE1", ok: false });
  });

  it("carries a daemon refusal out at its own code and layer", async () => {
    const { wire } = wireCapture();
    wire.transport.sendCommand = () => Promise.resolve({
      delivered: true as const,
      response: {
        ok: false,
        refusal: { code: "PRODUCT_CONTRACT_GATE_1_BEARER_REPLAYED", layer: "DAEMON_GATE_1_BEARER" },
      },
      status: 422,
    });
    expect(await createGate1ApprovalPort(wire as never).submit(pending)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_REPLAYED", layer: "DAEMON_GATE_1_BEARER", ok: false,
    });
  });
});
