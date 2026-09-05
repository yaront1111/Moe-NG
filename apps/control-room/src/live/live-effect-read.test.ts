import { expect, it } from "vitest";
import { effectRefusal } from "./live-effect-read.js";
it("retains the refusing domain layer inside a transport refusal", () => {
  expect(effectRefusal({ httpStatus: 422, ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
    refusal: { code: "OWNER_CHANGED", layer: "REPOSITORY_RECOVERY", detail: "held" } })).toEqual({ status: "REFUSED", code: "OWNER_CHANGED", layer: "REPOSITORY_RECOVERY" });
});
it("does not evaluate hostile nested refusal descriptors", () => {
  const refusal = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("hostile"); } });
  expect(() => effectRefusal({ httpStatus: 422, ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH", refusal })).not.toThrow();
});
