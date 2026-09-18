import { describe, expect, it } from "vitest";

import { WRAPPER_ENV_INVALID, readWrapperKnobs } from "./wrapper-knobs.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const DEFAULTS = Object.freeze({
  agentSilenceMs: TWENTY_MINUTES_MS,
  // The ABSOLUTE cap behind the silence watch, no longer the hang detector: it was the 30-minute
  // claim TTL, which killed a working node with a tool child alive (UnAI 2026-09-18).
  agentTimeoutMs: TWO_HOURS_MS,
  claimTtlMs: THIRTY_MINUTES_MS,
  intervalMs: 15_000,
  maxAgents: 2,
  maxItemAttempts: 3,
  nodeTrees: false,
  once: false,
  // Derived from the cap, so a two-hour seat's bearer still outlives its exit-path release.
  sessionTtlMs: TWO_HOURS_MS + 60_000,
});

describe("readWrapperKnobs", () => {
  it("defaults to two agents, a 15 s poll, three item attempts, and continuous mode", () => {
    expect(readWrapperKnobs({})).toEqual(DEFAULTS);
    // Empty is absent, not zero.
    expect(readWrapperKnobs({
      MOE_AGENT_SILENCE_MS: "", MOE_AGENT_TIMEOUT_MS: "", MOE_WRAPPER_INTERVAL_MS: "",
      MOE_WRAPPER_MAX_AGENTS: "",
    })).toEqual(DEFAULTS);
  });

  it("keeps the silence cap under the absolute cap by default, so a hung seat dies first", () => {
    const knobs = readWrapperKnobs({});
    expect(knobs.agentSilenceMs).toBeLessThan(knobs.agentTimeoutMs);
    expect(knobs.agentSilenceMs).toBeLessThan(knobs.claimTtlMs);
  });

  it("reads an explicit silence cap and refuses a malformed one by name", () => {
    expect(readWrapperKnobs({ MOE_AGENT_SILENCE_MS: "600000" }).agentSilenceMs).toBe(600_000);
    // The silence cap does not stretch the bearer: only the absolute cap derives it.
    expect(readWrapperKnobs({ MOE_AGENT_SILENCE_MS: "99999999" }).sessionTtlMs)
      .toBe(DEFAULTS.sessionTtlMs);
    for (const bad of ["abc", "0", "-1", "1.5", "1e3"]) {
      expect(() => readWrapperKnobs({ MOE_AGENT_SILENCE_MS: bad }))
        .toThrow(new RegExp(`${WRAPPER_ENV_INVALID}: MOE_AGENT_SILENCE_MS`, "u"));
    }
  });

  it("reads explicit values", () => {
    expect(readWrapperKnobs({
      MOE_WRAPPER_INTERVAL_MS: "10000", MOE_WRAPPER_MAX_AGENTS: "1",
      MOE_WRAPPER_MAX_ITEM_ATTEMPTS: "5", MOE_WRAPPER_ONCE: "1", MOE_NODE_TREES: "1",
    })).toEqual({ ...DEFAULTS, intervalMs: 10_000, maxAgents: 1, maxItemAttempts: 5, nodeTrees: true, once: true });
  });

  it("derives the bearer TTL from the agent lifetime so the session outlives the process", () => {
    // A three-hour agent keeps renewing a thirty-minute claim; the bearer that
    // must release on exit has to last the whole three hours plus the kill grace.
    // The claim TTL itself is NOT stretched: it stays the reap horizon.
    const long = readWrapperKnobs({ MOE_AGENT_TIMEOUT_MS: "10800000" });
    expect(long.agentTimeoutMs).toBe(10_800_000);
    expect(long.claimTtlMs).toBe(THIRTY_MINUTES_MS);
    expect(long.sessionTtlMs).toBe(10_800_000 + 60_000);
    // A short agent never shortens the bearer below the claim horizon.
    const short = readWrapperKnobs({ MOE_AGENT_TIMEOUT_MS: "60000" });
    expect(short.agentTimeoutMs).toBe(60_000);
    expect(short.sessionTtlMs).toBe(THIRTY_MINUTES_MS + 60_000);
    expect(short.sessionTtlMs).toBeGreaterThan(short.claimTtlMs);
  });

  it("refuses a malformed agent lifetime by name instead of letting the spawner default it", () => {
    expect(() => readWrapperKnobs({ MOE_AGENT_TIMEOUT_MS: "abc" }))
      .toThrow(new RegExp(`${WRAPPER_ENV_INVALID}: MOE_AGENT_TIMEOUT_MS`, "u"));
    expect(() => readWrapperKnobs({ MOE_AGENT_TIMEOUT_MS: "0" })).toThrow(WRAPPER_ENV_INVALID);
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
