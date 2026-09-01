import { createHash } from "node:crypto";

import { createRuntimeError } from "@moe/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  GATE1_PENDING_READ_PATH,
  createGate1ApprovalPort,
  mapGate1Answer as mapGate1AnswerForProject,
  presentGate1Approval,
  readPendingContract,
} from "./gate1-approval.js";
import {
  GATE1_V2_ANSWER,
  GATE1_V2_ANSWERED_PENDING_BODY,
  GATE1_V2_APPROVAL,
  GATE1_V2_CURRENT_BODY,
  GATE1_V2_CURRENT_SLOT,
  GATE1_V2_IMPOSSIBLE_BODY,
  GATE1_V2_OPEN_BODY,
  GATE1_V2_READY_BODY,
  GATE1_V2_REVISION,
} from "./gate1-v2-test-fixture.js";

type PendingBody = typeof GATE1_V2_OPEN_BODY | typeof GATE1_V2_READY_BODY;
const PROJECT_ID = "project-1";
const mapGate1Answer = (status: number, body: unknown) =>
  mapGate1AnswerForProject(status, body, PROJECT_ID);

async function pendingView(body: PendingBody = GATE1_V2_READY_BODY) {
  const mapped = await mapGate1Answer(200, body);
  if (mapped.status !== "PENDING") throw new Error(`expected PENDING, got ${mapped.status}`);
  return mapped;
}

function canonicalText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value === "object") {
    const row = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(row).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalText(row[key])}`,
    ).join(",")}}`;
  }
  throw new TypeError("non-canonical test value");
}

function digestForRevision(value: Readonly<Record<string, unknown>>): string {
  const { revisionDigest: _digest, ...source } = value;
  return createHash("sha256")
    .update("moe-product-contract-revision-digest/2", "utf8")
    .update(Uint8Array.of(0))
    .update(new TextEncoder().encode(canonicalText(source)))
    .digest("hex");
}

function digestForCurrentSlot(value: Readonly<Record<string, unknown>>): string {
  const { slotDigest: _digest, ...source } = value;
  return createHash("sha256")
    .update("moe-product-contract-current-revision-slot-digest/2", "utf8")
    .update(Uint8Array.of(0))
    .update(new TextEncoder().encode(canonicalText(source)))
    .digest("hex");
}

const invalidResponse = Object.freeze({
  code: "GATE1_RESPONSE_INVALID", layer: "CONTROL_ROOM_GATE1", status: "ERROR" as const,
});

describe("the Product Contract /2 pending adapter", () => {
  it("reads only the activated query plane with the exact goal body", async () => {
    expect(GATE1_PENDING_READ_PATH).toBe("/v2/product-contract/pending/read");
    const post = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ outcome: "NONE" }), { status: 200 },
    )));
    await expect(readPendingContract({}, "goal-live-1", PROJECT_ID, post))
      .resolves.toEqual({ status: "NONE" });
    expect(post).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ goalRef: "goal-live-1" }));
  });

  it("threads the attached project into CURRENT response admission", async () => {
    const post = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify(GATE1_V2_CURRENT_BODY), { status: 200 },
    )));
    await expect(readPendingContract({}, "goal-live-1", PROJECT_ID, post))
      .resolves.toMatchObject({
        contractId: GATE1_V2_REVISION.contractId,
        status: "CURRENT",
      });
    expect(post).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ goalRef: "goal-live-1" }));
  });

  it("fails closed on a self-consistent CURRENT answer when no expected project is attached", async () => {
    await expect(mapGate1AnswerForProject(200, GATE1_V2_CURRENT_BODY))
      .resolves.toEqual(invalidResponse);
  });

  it("admits the daemon's three real pending states without combining their authorities", async () => {
    const open = await pendingView(GATE1_V2_OPEN_BODY);
    expect(open.approval).toBeNull();
    expect(open.clarifications[0]?.options[0]?.answer).toEqual(GATE1_V2_ANSWER);
    const ready = await pendingView(GATE1_V2_READY_BODY);
    expect(ready.approval).toEqual(GATE1_V2_APPROVAL);
    expect(ready.clarifications).toEqual([]);
    const answered = await mapGate1Answer(200, GATE1_V2_ANSWERED_PENDING_BODY);
    expect(answered).toMatchObject({ approval: null, clarifications: [], status: "PENDING" });
    expect(await mapGate1Answer(200, GATE1_V2_IMPOSSIBLE_BODY)).toEqual(invalidResponse);
  });

  it("admits only an exact current slot bound to the authenticated revision", async () => {
    const current = await mapGate1Answer(200, GATE1_V2_CURRENT_BODY);
    expect(current).toEqual({
      contractId: GATE1_V2_REVISION.contractId,
      revision: GATE1_V2_REVISION,
      revisionDigest: GATE1_V2_REVISION.revisionDigest,
      revisionId: GATE1_V2_REVISION.revisionId,
      slot: GATE1_V2_CURRENT_SLOT,
      status: "CURRENT",
    });
    expect(Object.keys(GATE1_V2_CURRENT_BODY).sort())
      .toEqual(["outcome", "ref", "revision", "slot"]);
    expect(Object.keys(GATE1_V2_CURRENT_SLOT).sort()).toEqual([
      "contractId", "currentRevision", "generation", "projectId", "revisionHistory",
      "slotDigest", "version",
    ]);
    expect(GATE1_V2_CURRENT_SLOT).toMatchObject({
      generation: 2,
      projectId: "project-1",
      revisionHistory: [{
        revisionDigest: GATE1_V2_REVISION.lineage?.parentRevisionDigest,
        revisionId: GATE1_V2_REVISION.lineage?.parentRevisionId,
      }],
    });
    const changedGeneration = {
      ...GATE1_V2_CURRENT_SLOT, generation: GATE1_V2_CURRENT_SLOT.generation + 1,
    };
    const changedParent = { ...GATE1_V2_CURRENT_SLOT,
      revisionHistory: [{ ...GATE1_V2_CURRENT_SLOT.revisionHistory[0],
        revisionId: "revision-parent-substituted" }] };
    const changedCurrentRef = { ...GATE1_V2_CURRENT_SLOT,
      currentRevision: { ...GATE1_V2_CURRENT_SLOT.currentRevision,
        revisionId: "revision-browser-substituted" } };
    const changedProject = {
      ...GATE1_V2_CURRENT_SLOT, projectId: "project-substituted",
    };
    for (const body of [
      { ...GATE1_V2_CURRENT_BODY, extra: true },
      { ...GATE1_V2_CURRENT_BODY, slot: { ...GATE1_V2_CURRENT_SLOT, extra: true } },
      { ...GATE1_V2_CURRENT_BODY,
        slot: { ...changedProject, slotDigest: digestForCurrentSlot(changedProject) } },
      { ...GATE1_V2_CURRENT_BODY,
        slot: { ...changedGeneration, slotDigest: digestForCurrentSlot(changedGeneration) } },
      { ...GATE1_V2_CURRENT_BODY,
        slot: { ...changedParent, slotDigest: digestForCurrentSlot(changedParent) } },
      { ...GATE1_V2_CURRENT_BODY,
        slot: { ...GATE1_V2_CURRENT_SLOT, slotDigest: "0".repeat(64) } },
      { ...GATE1_V2_CURRENT_BODY,
        slot: { ...changedCurrentRef, slotDigest: digestForCurrentSlot(changedCurrentRef) } },
    ]) await expect(mapGate1Answer(200, body)).resolves.toEqual(invalidResponse);
  });

  it("rejects a self-consistent current slot beyond the core canonical byte bound", async () => {
    const contractId = "c".repeat(512);
    const revisionId = "r".repeat(512);
    const parentRevisionId = "p".repeat(512);
    const parentRevisionDigest = "1".repeat(64);
    const revisionSource = {
      ...GATE1_V2_REVISION,
      contractId,
      lineage: { parentRevisionDigest, parentRevisionId },
      revisionId,
    };
    const revision = {
      ...revisionSource,
      revisionDigest: digestForRevision(revisionSource),
    };
    const revisionHistory = Array.from({ length: 1_024 }, (_, index) => {
      if (index === 1_023) return {
        contractId, revisionDigest: parentRevisionDigest, revisionId: parentRevisionId,
        version: revision.version,
      };
      const prefix = index.toString(16).padStart(4, "0");
      return {
        contractId,
        revisionDigest: createHash("sha256")
          .update(`overbound-current-history-${index}`, "utf8").digest("hex"),
        revisionId: `${prefix}${"h".repeat(508)}`,
        version: revision.version,
      };
    });
    const slotSource = {
      contractId,
      currentRevision: { contractId, revisionDigest: revision.revisionDigest,
        revisionId, version: revision.version },
      generation: 1_025,
      projectId: PROJECT_ID,
      revisionHistory,
      version: GATE1_V2_CURRENT_SLOT.version,
    };
    const slot = { ...slotSource, slotDigest: digestForCurrentSlot(slotSource) };
    const body = {
      outcome: "CURRENT",
      ref: { contractId, revisionDigest: revision.revisionDigest, revisionId },
      revision,
      slot,
    };
    expect(new TextEncoder().encode(canonicalText(slot)).byteLength).toBeGreaterThan(1_048_576);
    await expect(mapGate1Answer(200, body)).resolves.toEqual(invalidResponse);
  });

  it("rejects a changed body that retains the durable revision digest", async () => {
    const revision = {
      ...GATE1_V2_REVISION,
      objectives: [{
        ...GATE1_V2_REVISION.objectives[0], statement: "Browser-substituted objective.",
      }],
    };
    expect(await mapGate1Answer(200, { ...GATE1_V2_OPEN_BODY, revision }))
      .toEqual(invalidResponse);
  });

  it("rejects semantically invalid references even when their canonical digest matches", async () => {
    const draft = {
      ...GATE1_V2_REVISION,
      successMetrics: [{
        ...GATE1_V2_REVISION.successMetrics[0], objectiveIds: ["objective-unknown"],
      }],
    } as Readonly<Record<string, unknown>>;
    const revision = { ...draft, revisionDigest: digestForRevision(draft) };
    const body = {
      ...GATE1_V2_OPEN_BODY,
      ref: { ...GATE1_V2_OPEN_BODY.ref, revisionDigest: revision.revisionDigest },
      revision,
    };
    expect(await mapGate1Answer(200, body)).toEqual(invalidResponse);
  });

  it("never invokes accessors or toJSON while admitting hostile content", async () => {
    let invocations = 0;
    const accessorRevision = { ...GATE1_V2_REVISION } as Record<string, unknown>;
    Object.defineProperty(accessorRevision, "authorRef", {
      enumerable: true,
      get: () => { invocations += 1; return GATE1_V2_REVISION.authorRef; },
    });
    expect(await mapGate1Answer(200, { ...GATE1_V2_OPEN_BODY, revision: accessorRevision }))
      .toEqual(invalidResponse);
    const toJsonRevision = { ...GATE1_V2_REVISION } as Record<string, unknown>;
    Object.defineProperty(toJsonRevision, "toJSON", {
      value: () => { invocations += 1; return GATE1_V2_REVISION; },
    });
    expect(await mapGate1Answer(200, { ...GATE1_V2_OPEN_BODY, revision: toJsonRevision }))
      .toEqual(invalidResponse);
    expect(invocations).toBe(0);
  });

  it("snapshots a get-trapping proxy without invoking its value trap", async () => {
    let gets = 0;
    const revision = new Proxy(GATE1_V2_REVISION, {
      get: (target, key, receiver) => {
        gets += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(await mapGate1Answer(200, { ...GATE1_V2_OPEN_BODY, revision }))
      .toMatchObject({ status: "PENDING" });
    expect(gets).toBe(0);
  });

  it("bounds hostile presentation strings before they can reach rendering", async () => {
    expect(await mapGate1Answer(200, {
      ...GATE1_V2_OPEN_BODY,
      clarifications: [{
        ...GATE1_V2_OPEN_BODY.clarifications[0], question: "x".repeat(32_769),
      }],
    })).toEqual(invalidResponse);
  });

  it("rejects non-material or non-canonical clarification option rosters", async () => {
    const clarification = GATE1_V2_OPEN_BODY.clarifications[0]!;
    const optionAt = (index: number) => {
      const optionId = `option-${String(index).padStart(3, "0")}`;
      const commandId = `answer-limit-${index}`;
      return {
        ...clarification.options[0],
        answer: {
          ...GATE1_V2_ANSWER,
          affordance: {
            ...GATE1_V2_ANSWER.affordance,
            commandId,
            targetAggregateId: `aggregate-${commandId}`,
          },
          commandId,
          correlationId: `correlation-${commandId}`,
          payload: { ...GATE1_V2_ANSWER.payload, answerOptionId: optionId },
          requestDigest: createHash("sha256").update(`request-${index}`).digest("hex"),
        },
        label: `Qualified option ${index}`,
        optionId,
        projectionDigest: createHash("sha256").update(`projection-${index}`).digest("hex"),
        revisionDigest: createHash("sha256").update(`revision-${index}`).digest("hex"),
      };
    };
    const withOptions = (options: readonly unknown[]) => ({
      ...GATE1_V2_OPEN_BODY,
      clarifications: [{ ...clarification, options }],
    });
    const first = clarification.options[0]!;
    const second = clarification.options[1]!;
    expect(await mapGate1Answer(200, withOptions([first]))).toEqual(invalidResponse);
    expect(await mapGate1Answer(200, withOptions(Array.from({ length: 64 }, (_, i) => optionAt(i)))))
      .toMatchObject({ status: "PENDING" });
    expect(await mapGate1Answer(200, withOptions(Array.from({ length: 65 }, (_, i) => optionAt(i)))))
      .toEqual(invalidResponse);
    expect(await mapGate1Answer(200, withOptions([second, first]))).toEqual(invalidResponse);
    expect(await mapGate1Answer(200, withOptions([
      first, { ...second, projectionDigest: first.projectionDigest },
    ]))).toEqual(invalidResponse);
    expect(await mapGate1Answer(200, withOptions([
      first, { ...second, revisionDigest: first.revisionDigest },
    ]))).toEqual(invalidResponse);
  });

  it("rejects duplicate daemon command or correlation identities globally", async () => {
    const clarification = GATE1_V2_OPEN_BODY.clarifications[0]!;
    const sameAnswerIdentity = {
      ...GATE1_V2_ANSWER, correlationId: GATE1_V2_ANSWER.commandId,
    };
    expect(await mapGate1Answer(200, {
      ...GATE1_V2_OPEN_BODY,
      clarifications: [{
        ...clarification,
        options: [{ ...clarification.options[0], answer: sameAnswerIdentity }],
      }],
    })).toEqual(invalidResponse);
    expect(await mapGate1Answer(200, {
      ...GATE1_V2_READY_BODY,
      approval: { ...GATE1_V2_APPROVAL, correlationId: GATE1_V2_APPROVAL.commandId },
    })).toEqual(invalidResponse);

    const duplicate = {
      ...GATE1_V2_ANSWER,
      payload: { ...GATE1_V2_ANSWER.payload, answerOptionId: "option-b" },
    };
    const body = {
      ...GATE1_V2_OPEN_BODY,
      clarifications: [{
        ...clarification,
        options: [...clarification.options, {
          ...clarification.options[0], answer: duplicate, label: "Second", optionId: "option-b",
        }],
      }],
    };
    expect(await mapGate1Answer(200, body)).toEqual(invalidResponse);
  });

  it("keeps NONE, daemon refusals, and listener refusals distinguishable", async () => {
    expect(await mapGate1Answer(200, { outcome: "NONE" }))
      .toEqual({ status: "NONE" });
    expect(await mapGate1Answer(200, { code: "X", layer: "L", outcome: "REFUSED" }))
      .toEqual({ code: "X", layer: "L", status: "REFUSED" });
    expect(await mapGate1Answer(403, { code: "LISTENER_ORIGIN_INVALID", layer: "LISTENER" }))
      .toEqual({ code: "LISTENER_ORIGIN_INVALID", layer: "LISTENER", status: "REFUSED" });
    expect(await mapGate1Answer(401, {
      error: createRuntimeError({ code: "AUTHENTICATION_FAILED" }),
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    })).toEqual({
      code: "AUTHENTICATION_FAILED", layer: "AUTHENTICATE", status: "REFUSED",
    });
    expect(await mapGate1Answer(403, {
      httpStatus: 403,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: "SESSION_REVOKED", detail: "credential is no longer active",
        httpStatus: 403, layer: "SESSION_AUTHORITY",
      },
      stage: "AUTHENTICATE",
    })).toEqual({
      code: "SESSION_REVOKED", layer: "SESSION_AUTHORITY", status: "REFUSED",
    });
    expect(await mapGate1Answer(200, { code: "X", outcome: "REFUSED" }))
      .toEqual(invalidResponse);
    expect(await mapGate1Answer(403, { code: "X" })).toEqual(invalidResponse);
  });
});

function accepted(commandId: string, disposition: "DECIDED" | "REPLAYED" = "DECIDED") {
  return {
    decision: { commandId, disposition, effectId: "effect-1", resultCode: "EFFECTS_COMMITTED" },
    httpStatus: 200,
    ok: true,
    outcome: "ACCEPTED",
  };
}

function wireCapture() {
  const calls: { affordance: unknown; caller: Record<string, unknown> }[] = [];
  const sent: unknown[] = [];
  const wire = {
    client: {
      commands: new Proxy({}, {
        get: () => (affordance: unknown, caller: Record<string, unknown>) => {
          calls.push({ affordance, caller });
          const commandId = (affordance as Record<string, unknown>)["commandId"];
          return { envelope: { commandId }, ok: true };
        },
      }) as never,
    },
    sessionCredential: "session-secret",
    transport: {
      sendCommand: (envelope: unknown): Promise<{
        delivered: true; response: unknown; status: number;
      }> => {
        sent.push(envelope);
        const commandId = String((envelope as Record<string, unknown>)["commandId"]);
        return Promise.resolve({ delivered: true, response: accepted(commandId), status: 200 });
      },
    },
  };
  return { calls, sent, wire };
}

describe("daemon-issued Gate 1 submissions", () => {
  it("adds only the fresh human presentation to the daemon approval payload", async () => {
    expect(presentGate1Approval(GATE1_V2_APPROVAL, 1_725_000_000_000)).toEqual({
      ...GATE1_V2_APPROVAL.payload,
      authentication: {
        issuedAt: 1_725_000_000_000, kind: "BEARER",
        requestDigest: GATE1_V2_APPROVAL.requestDigest,
        requestId: GATE1_V2_APPROVAL.commandId,
      },
    });
    const pending = await pendingView(GATE1_V2_READY_BODY);
    const { calls, wire } = wireCapture();
    await expect(createGate1ApprovalPort(wire as never).submit(pending)).resolves.toEqual({
      commandId: GATE1_V2_APPROVAL.commandId, ok: true,
    });
    const call = calls[0]!;
    expect(call.affordance).toEqual(GATE1_V2_APPROVAL.affordance);
    expect(call.caller["correlationId"]).toBe(GATE1_V2_APPROVAL.correlationId);
    expect(call.caller["requestDigest"]).toBe(GATE1_V2_APPROVAL.requestDigest);
    expect(call.caller["sessionCredential"]).toBe("session-secret");
    const payload = call.caller["payload"] as Record<string, unknown>;
    expect({ ...payload, authentication: undefined }).toEqual({
      ...GATE1_V2_APPROVAL.payload, authentication: undefined,
    });
  });

  it("dispatches a clarification option without reminting any field", async () => {
    const pending = await pendingView(GATE1_V2_OPEN_BODY);
    const clarification = pending.clarifications[0]!;
    const { calls, wire } = wireCapture();
    await expect(createGate1ApprovalPort(wire as never).answer(clarification, "option-a"))
      .resolves.toEqual({ commandId: GATE1_V2_ANSWER.commandId, ok: true });
    expect(calls).toEqual([{
      affordance: GATE1_V2_ANSWER.affordance,
      caller: {
        correlationId: GATE1_V2_ANSWER.correlationId,
        payload: GATE1_V2_ANSWER.payload,
        requestDigest: GATE1_V2_ANSWER.requestDigest,
        sessionCredential: "session-secret",
      },
    }]);
  });

  it("requires an exact accepted response bound to the submitted command", async () => {
    const pending = await pendingView(GATE1_V2_READY_BODY);
    const capture = wireCapture();
    const valid = accepted(GATE1_V2_APPROVAL.commandId);
    const cases = [
      { response: accepted("other-command"), status: 200 },
      { response: valid, status: 201 },
      { response: { ...valid, httpStatus: 201 }, status: 200 },
      { response: { ...valid, outcome: "REFUSED" }, status: 200 },
      {
        response: { ...valid, decision: { ...valid.decision, disposition: "PENDING" } },
        status: 200,
      },
      {
        response: {
          ...valid, decision: { ...valid.decision, resultCode: "EXPECTED_VERSION_CONFLICT" },
        },
        status: 200,
      },
      { response: { ...valid, extra: true }, status: 200 },
      { response: { ok: true }, status: 200 },
    ];
    for (const candidate of cases) {
      capture.wire.transport.sendCommand = () => Promise.resolve({
        delivered: true, ...candidate,
      });
      await expect(createGate1ApprovalPort(capture.wire as never).submit(pending)).resolves
        .toEqual({
          code: "GATE1_ANSWER_UNREADABLE", layer: "CONTROL_ROOM_GATE1", ok: false,
        });
    }
    capture.wire.transport.sendCommand = () => Promise.resolve({
      delivered: true, response: accepted(GATE1_V2_APPROVAL.commandId, "REPLAYED"), status: 200,
    });
    await expect(createGate1ApprovalPort(capture.wire as never).submit(pending)).resolves.toEqual({
      commandId: GATE1_V2_APPROVAL.commandId, ok: true,
    });
  });

  it("preserves transport and daemon refusal provenance", async () => {
    const pending = await pendingView(GATE1_V2_READY_BODY);
    const capture = wireCapture();
    capture.wire.transport.sendCommand = () => Promise.resolve({
      code: "TRANSPORT_REQUEST_FAILED", delivered: false,
      layer: "CONTROL_ROOM_TRANSPORT",
    } as never);
    await expect(createGate1ApprovalPort(capture.wire as never).submit(pending)).resolves.toEqual({
      code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT", ok: false,
    });
    capture.wire.transport.sendCommand = () => Promise.resolve({
      delivered: true,
      response: {
        httpStatus: 422,
        ok: false,
        outcome: "PORT_REFUSED",
        refusal: {
          code: "BEARER_REPLAYED", detail: "presentation already consumed",
          httpStatus: 422, layer: "GATE1_BEARER",
        },
        stage: "DISPATCH",
      },
      status: 422,
    });
    await expect(createGate1ApprovalPort(capture.wire as never).submit(pending)).resolves.toEqual({
      code: "BEARER_REPLAYED", layer: "GATE1_BEARER", ok: false,
    });
    capture.wire.transport.sendCommand = () => Promise.resolve({
      delivered: true,
      response: {
        error: createRuntimeError({ code: "AUTHENTICATION_FAILED" }),
        httpStatus: 401,
        ok: false,
        outcome: "REFUSED",
        stage: "AUTHENTICATE",
      },
      status: 401,
    });
    await expect(createGate1ApprovalPort(capture.wire as never).submit(pending)).resolves.toEqual({
      code: "AUTHENTICATION_FAILED", layer: "AUTHENTICATE", ok: false,
    });
  });
});
