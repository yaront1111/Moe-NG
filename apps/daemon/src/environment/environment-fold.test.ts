import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_VARIABLE_SET_EVENT,
  ENVIRONMENT_VARIABLE_UNSET_EVENT,
  foldEnvironmentEvents,
} from "./environment-fold.js";
import type { EnvironmentVariableState } from "./environment-fold.js";

/**
 * The fold's decode paths. These are the branches a happy-path store suite never reaches, and
 * they decide what a CORRUPT record means - a question with a dangerous wrong answer.
 *
 * The fold never sees a credential and cannot open anything, so nothing here can leak a value.
 */

const encoder = new TextEncoder();

interface EventLike {
  readonly eventType: string;
  readonly payload: Uint8Array;
}

function event(eventType: string, payload: unknown): EventLike {
  return {
    eventType,
    payload: typeof payload === "string"
      ? encoder.encode(payload)
      : encoder.encode(JSON.stringify(payload)),
  };
}

function setEvent(name: string, sealed: string, updatedAt = "2026-09-05T00:00:00.000Z"): EventLike {
  return event(ENVIRONMENT_VARIABLE_SET_EVENT, {
    environment: "production", fingerprintSha256: "f".repeat(64), name, sealed, updatedAt,
  });
}

function fold(events: readonly EventLike[]): ReadonlyMap<string, EnvironmentVariableState> {
  return foldEnvironmentEvents(events as never);
}

const SEALED = Buffer.from("sealed-bytes-fixture").toString("base64");

describe("foldEnvironmentEvents", () => {
  it("folds a set, then an unset, to an empty current state", () => {
    const state = fold([
      setEvent("A_KEY", SEALED),
      event(ENVIRONMENT_VARIABLE_UNSET_EVENT, { name: "A_KEY" }),
    ]);
    expect([...state.keys()]).toEqual([]);
  });

  it("lets a later set win over an earlier one", () => {
    const later = Buffer.from("later-bytes").toString("base64");
    const state = fold([
      setEvent("A_KEY", SEALED, "2026-09-05T00:00:00.000Z"),
      setEvent("A_KEY", later, "2026-09-05T01:00:00.000Z"),
    ]);
    expect(state.get("A_KEY")?.updatedAt).toBe("2026-09-05T01:00:00.000Z");
    expect(Buffer.from(state.get("A_KEY")?.sealed ?? new Uint8Array()).toString("base64"))
      .toBe(later);
  });

  it("SKIPS a foreign event type without disturbing state", () => {
    const state = fold([
      setEvent("A_KEY", SEALED),
      event("moe.something.else", { name: "A_KEY" }),
    ]);
    expect([...state.keys()]).toEqual(["A_KEY"]);
  });

  it("does NOT treat the unset event as a set despite the shared prefix", () => {
    const state = fold([event(ENVIRONMENT_VARIABLE_UNSET_EVENT, {
      fingerprintSha256: "f".repeat(64), name: "A_KEY", sealed: SEALED, updatedAt: "x",
    })]);
    expect([...state.keys()]).toEqual([]);
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["a JSON array", []],
    ["a JSON null", null],
    ["a record with no name", { sealed: SEALED, updatedAt: "x" }],
  ])("ignores a set whose payload is %s, leaving the prior value untouched", (_why, payload) => {
    const state = fold([setEvent("A_KEY", SEALED), event(ENVIRONMENT_VARIABLE_SET_EVENT, payload)]);
    expect([...state.keys()]).toEqual(["A_KEY"]);
  });

  it.each([
    ["a missing sealed field", { name: "A_KEY", updatedAt: "x" }],
    ["a non-base64 sealed field", {
      fingerprintSha256: "f".repeat(64), name: "A_KEY", sealed: "!!!not base64!!!", updatedAt: "x",
    }],
    ["a missing updatedAt", { fingerprintSha256: "f".repeat(64), name: "A_KEY", sealed: SEALED }],
    ["a missing fingerprint", { name: "A_KEY", sealed: SEALED, updatedAt: "x" }],
  ])("DROPS the variable when a later set has %s, rather than resurrecting the older one",
    (_why, payload) => {
      const state = fold([
        setEvent("A_KEY", SEALED),
        event(ENVIRONMENT_VARIABLE_SET_EVENT, payload),
      ]);
      // The dangerous alternative is leaving the OLD value current: the operator would believe
      // they had updated a secret while the previous one stayed live.
      expect([...state.keys()]).toEqual([]);
    });

  it("carries sealed bytes through opaquely, byte for byte", () => {
    const raw = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const state = fold([setEvent("A_KEY", Buffer.from(raw).toString("base64"))]);
    expect([...(state.get("A_KEY")?.sealed ?? [])]).toEqual([...raw]);
  });

  it("returns an empty state for no events", () => {
    expect([...fold([]).keys()]).toEqual([]);
  });
});
