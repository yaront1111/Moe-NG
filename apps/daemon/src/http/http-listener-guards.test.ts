import { describe, expect, it } from "vitest";

import { LISTENER_REFUSAL_CODES, statusFor } from "./http-listener-guards.js";

/**
 * The transport-pair sweep. Every read route registers a `<ROUTE>_REQUEST_INVALID` /
 * `<ROUTE>_UNAVAILABLE` pair in the roster, and `statusFor` maps them by hand; a pair added to
 * the roster but not to the map fell through to the 403 default (measured 2026-09-05: the two
 * V2-current product-contract codes answered 403 for a client fault and an absent port). The
 * suffix decides the status class, so the sweep reads the roster instead of a hand list and
 * reddens the moment a new pair is registered without its mapping.
 */
describe("statusFor covers every transport pair the roster declares", () => {
  const pairs = LISTENER_REFUSAL_CODES.filter((code) =>
    code.endsWith("_REQUEST_INVALID") || code.endsWith("_UNAVAILABLE"));

  it("answers 503 for every *_UNAVAILABLE and a client-fault status for every *_REQUEST_INVALID", () => {
    expect(pairs.length).toBeGreaterThan(20);
    for (const code of pairs) {
      const status = statusFor(code);
      const expected = code.endsWith("_UNAVAILABLE") ? [503] : [400, 405];
      expect({ code, status: expected.includes(status) ? "ok" : status }).toEqual({ code, status: "ok" });
    }
  });

  it("maps the V2-current product-contract pair like its siblings", () => {
    expect(statusFor("LISTENER_PRODUCT_CONTRACT_V2_CURRENT_REQUEST_INVALID")).toBe(400);
    expect(statusFor("LISTENER_PRODUCT_CONTRACT_V2_CURRENT_UNAVAILABLE")).toBe(503);
  });
});
