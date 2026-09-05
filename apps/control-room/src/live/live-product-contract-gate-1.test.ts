/**
 * The Gate 1 read decoder, graded against a REAL daemon frame.
 *
 * The frame is built by the production core entry points the daemon itself reaches
 * (see product-contract-gate-1-frame.fixture.ts), so a decoder that passes here decodes
 * what the daemon actually sends. The three arms the row demands are the exact-key fence:
 * a real frame decodes, an EXTRA key is refused, a MISSING key is refused.
 */
import { describe, expect, it } from "vitest";

import {
  mapProductContractGate1Answer, readProductContractGate1,
} from "./live-product-contract-gate-1.js";
import {
  REAL_GATE_1_FRAME, REAL_GATE_1_REF, REAL_GATE_1_REVISION_DIGEST,
} from "./product-contract-gate-1-frame.fixture.js";

function gateOf(frame: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return frame["gate"] as Readonly<Record<string, unknown>>;
}

describe("mapProductContractGate1Answer", () => {
  it("decodes the real daemon GATE frame and carries the revision digest verbatim", () => {
    // The fixture is production-built, so this also proves the four keys are still the four.
    expect(Object.keys(gateOf(REAL_GATE_1_FRAME)).sort())
      .toEqual(["advisoryOnly", "gate", "ok", "revisionDigest"]);
    const mapped = mapProductContractGate1Answer(200, REAL_GATE_1_FRAME);
    expect(mapped).toEqual({
      advisoryOnly: true,
      gate: "GATE_1",
      revisionDigest: REAL_GATE_1_REVISION_DIGEST,
      status: "GATE",
    });
  });

  it("refuses a frame with an EXTRA key, at the envelope and inside the gate", () => {
    const extraEnvelope = mapProductContractGate1Answer(
      200, { ...REAL_GATE_1_FRAME, requirements: [] },
    );
    expect(extraEnvelope).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT",
      status: "ERROR",
    });
    const extraGate = mapProductContractGate1Answer(200, {
      ...REAL_GATE_1_FRAME,
      gate: { ...gateOf(REAL_GATE_1_FRAME), coverage: "VERIFIED" },
    });
    expect(extraGate).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT",
      status: "ERROR",
    });
  });

  it("refuses a frame MISSING a key, at the envelope and inside the gate", () => {
    const missingEnvelope = mapProductContractGate1Answer(
      200, { gate: gateOf(REAL_GATE_1_FRAME) },
    );
    expect(missingEnvelope.status).toBe("ERROR");
    expect(missingEnvelope).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT",
      status: "ERROR",
    });
    const { revisionDigest: _dropped, ...withoutDigest } = gateOf(REAL_GATE_1_FRAME) as {
      readonly revisionDigest: unknown;
    };
    const missingGateKey = mapProductContractGate1Answer(
      200, { ...REAL_GATE_1_FRAME, gate: withoutDigest },
    );
    expect(missingGateKey).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT",
      status: "ERROR",
    });
  });

  it("carries a route refusal out with the code and layer its owner stamped", () => {
    // The route forwards an upstream pair untouched; both of these are real daemon codes.
    expect(mapProductContractGate1Answer(200, {
      code: "PRODUCT_CONTRACT_GATE_1_READ_CAPABILITY_DENIED",
      layer: "PRODUCT_CONTRACT_GATE_1_READ",
      outcome: "REFUSED",
    })).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_READ_CAPABILITY_DENIED",
      layer: "PRODUCT_CONTRACT_GATE_1_READ",
      status: "REFUSED",
    });
    expect(mapProductContractGate1Answer(200, {
      code: "APPROVAL_HUMAN_AUTHORITY_REQUIRED", layer: "HUMAN_AUTHORITY_GATE",
      outcome: "REFUSED",
    })).toEqual({
      code: "APPROVAL_HUMAN_AUTHORITY_REQUIRED", layer: "HUMAN_AUTHORITY_GATE",
      status: "REFUSED",
    });
    expect(mapProductContractGate1Answer(400, {
      code: "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID", layer: "LISTENER",
    })).toEqual({
      code: "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID", layer: "LISTENER",
      status: "REFUSED",
    });
  });

  it("reddens a non-200 answer that is not a refusal envelope", () => {
    expect(mapProductContractGate1Answer(503, REAL_GATE_1_FRAME)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT",
      status: "ERROR",
    });
  });
});

describe("readProductContractGate1", () => {
  it("POSTs exactly { ref } with the three admitted identity fields", async () => {
    let sent = "";
    const outcome = await readProductContractGate1({}, REAL_GATE_1_REF, async (body) => {
      sent = body;
      return new Response(JSON.stringify(REAL_GATE_1_FRAME), { status: 200 });
    });
    expect(JSON.parse(sent)).toEqual({ ref: {
      contractId: REAL_GATE_1_REF.contractId,
      revisionDigest: REAL_GATE_1_REF.revisionDigest,
      revisionId: REAL_GATE_1_REF.revisionId,
    } });
    expect(outcome.status).toBe("GATE");
  });

  it("names the transport when nothing was delivered", async () => {
    const outcome = await readProductContractGate1({}, REAL_GATE_1_REF, async () => {
      throw new Error("offline");
    });
    expect(outcome).toEqual({
      code: "TRANSPORT_REQUEST_FAILED",
      layer: "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT",
      status: "ERROR",
    });
  });

  it("reddens an unreadable body rather than reporting a gate", async () => {
    const outcome = await readProductContractGate1({}, REAL_GATE_1_REF, async () =>
      new Response("not json", { status: 200 }));
    expect(outcome).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PRODUCT_CONTRACT",
      status: "ERROR",
    });
  });
});
