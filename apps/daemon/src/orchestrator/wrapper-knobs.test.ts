import { describe, expect, it } from "vitest";

import { WRAPPER_ENV_INVALID, readWrapperKnobs } from "./wrapper-knobs.js";

describe("readWrapperKnobs", () => {
  it("defaults to two agents, a 15 s poll, three item attempts, and continuous mode", () => {
    expect(readWrapperKnobs({}))
      .toEqual({ intervalMs: 15_000, maxAgents: 2, maxItemAttempts: 3, once: false });
    // Empty is absent, not zero.
    expect(readWrapperKnobs({ MOE_WRAPPER_INTERVAL_MS: "", MOE_WRAPPER_MAX_AGENTS: "" }))
      .toEqual({ intervalMs: 15_000, maxAgents: 2, maxItemAttempts: 3, once: false });
  });

  it("reads explicit values", () => {
    expect(readWrapperKnobs({
      MOE_WRAPPER_INTERVAL_MS: "10000", MOE_WRAPPER_MAX_AGENTS: "1",
      MOE_WRAPPER_MAX_ITEM_ATTEMPTS: "5", MOE_WRAPPER_ONCE: "1",
    })).toEqual({ intervalMs: 10_000, maxAgents: 1, maxItemAttempts: 5, once: true });
  });

  it("refuses a non-numeric or zero attempt cap by name instead of suppressing every item", () => {
    expect(() => readWrapperKnobs({ MOE_WRAPPER_MAX_ITEM_ATTEMPTS: "three" }))
      .toThrow(new RegExp(`${WRAPPER_ENV_INVALID}: MOE_WRAPPER_MAX_ITEM_ATTEMPTS`, "u"));
    expect(() => readWrapperKnobs({ MOE_WRAPPER_MAX_ITEM_ATTEMPTS: "0" }))
      .toThrow(WRAPPER_ENV_INVALID);
  });

  it("refuses a non-numeric interval by name instead of busy-looping on NaN", () => {
    expect(() => readWrapperKnobs({ MOE_WRAPPER_INTERVAL_MS: "abc" }))
      .toThrow(new RegExp(`${WRAPPER_ENV_INVALID}: MOE_WRAPPER_INTERVAL_MS`, "u"));
  });

  it("refuses a non-numeric agent cap by name instead of staffing nothing forever", () => {
    expect(() => readWrapperKnobs({ MOE_WRAPPER_MAX_AGENTS: "two" }))
      .toThrow(new RegExp(`${WRAPPER_ENV_INVALID}: MOE_WRAPPER_MAX_AGENTS`, "u"));
  });

  it("refuses zero, negatives, fractions and a sub-100ms poll", () => {
    for (const bad of ["0", "-1", "1.5", "1e3"]) {
      expect(() => readWrapperKnobs({ MOE_WRAPPER_MAX_AGENTS: bad })).toThrow(WRAPPER_ENV_INVALID);
    }
    expect(() => readWrapperKnobs({ MOE_WRAPPER_INTERVAL_MS: "50" })).toThrow(WRAPPER_ENV_INVALID);
    expect(readWrapperKnobs({ MOE_WRAPPER_INTERVAL_MS: "100" }).intervalMs).toBe(100);
  });

  it("treats anything but the literal 1 as continuous mode", () => {
    expect(readWrapperKnobs({ MOE_WRAPPER_ONCE: "true" }).once).toBe(false);
    expect(readWrapperKnobs({ MOE_WRAPPER_ONCE: "0" }).once).toBe(false);
  });
});
