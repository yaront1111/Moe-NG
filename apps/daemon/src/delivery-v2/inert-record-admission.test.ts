import { CAPABILITY_CATALOG_LIMITS } from "@moe/core";
import { describe, expect, it } from "vitest";

import type { DeliveryV2AppendContext } from "./contracts.js";
import {
  refuseDeliveryV2InertRead,
  validDeliveryV2InertAppendContext,
} from "./inert-record-admission.js";

const CONTEXT: DeliveryV2AppendContext = Object.freeze({
  commandId: "cmd-1",
  correlationId: "corr-1",
  decidedAt: "2026-09-17T04:00:00.000Z",
  expectedVersion: 0,
  principalId: "principal-1",
  projectId: "proj-1",
});

const valid = (overrides: Partial<Record<keyof DeliveryV2AppendContext, unknown>>): boolean =>
  validDeliveryV2InertAppendContext({ ...CONTEXT, ...overrides } as DeliveryV2AppendContext);

describe("validDeliveryV2InertAppendContext admits a first append with canonical facts", () => {
  it("admits the canonical first-append context", () => {
    expect(valid({})).toBe(true);
  });

  it("refuses any expected version but a positive zero", () => {
    for (const expectedVersion of [1, -0, 0.5]) {
      expect(valid({ expectedVersion })).toBe(false);
    }
  });

  it("refuses an empty, oversized, ill-formed or NUL-bearing identifier in every slot", () => {
    const oversized = "a".repeat(CAPABILITY_CATALOG_LIMITS.maxIdBytes + 1);
    expect(valid({ projectId: "a".repeat(CAPABILITY_CATALOG_LIMITS.maxIdBytes) })).toBe(true);
    for (const key of ["commandId", "correlationId", "principalId", "projectId"] as const) {
      for (const identifier of ["", oversized, "lone-\uD800", "nul-\0"]) {
        expect(valid({ [key]: identifier })).toBe(false);
      }
    }
  });

  it("refuses an instant that is not the canonical millisecond ISO form of a real moment", () => {
    for (const decidedAt of [
      "2026-09-17T04:00:00Z", "2026-09-17T04:00:00.000+00:00", "2026-09-17 04:00:00.000Z",
      "2026-02-30T00:00:00.000Z", "2026-09-17T24:00:00.000Z", "9999-99-99T99:99:99.999Z",
    ]) {
      expect(valid({ decidedAt })).toBe(false);
    }
  });
});

describe("refuseDeliveryV2InertRead builds a frozen reader refusal", () => {
  it("defaults to the reader layer", () => {
    const refusal = refuseDeliveryV2InertRead("DELIVERY_V2_MATERIAL_ABSENT");
    expect(refusal).toEqual({
      code: "DELIVERY_V2_MATERIAL_ABSENT", layer: "DAEMON_DELIVERY_V2_READER", ok: false,
    });
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  it("carries a named layer unchanged", () => {
    expect(refuseDeliveryV2InertRead("STORAGE_DEGRADED", "DURABLE_STORE"))
      .toEqual({ code: "STORAGE_DEGRADED", layer: "DURABLE_STORE", ok: false });
  });
});
