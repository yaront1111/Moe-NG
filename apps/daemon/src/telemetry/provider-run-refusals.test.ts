/**
 * Runtime guards for the provider-run refusal vocabulary.
 *
 * `provider-run-refusals.ts` is mostly type declarations, which vanish before a
 * test can see them. So nothing here asserts that the module "is defined" — that
 * passes for any file, including an empty one. Every case below pins a RUNTIME
 * value: the two closed vocabularies, their freeze, and the two constructors.
 *
 * THE VOCABULARY NAMES ARE HAND-WRITTEN, NOT DERIVED. A test that built its
 * expectation from the same array it asserts would be comparing the array with
 * itself and would stay green while a code was deleted. Only the COUNT is
 * derived — from the hand-written literal, so the count cannot silently drift
 * out of step with the names beside it.
 */

import { describe, expect, it } from "vitest";

import {
  PROVIDER_RUN_LEDGER_CODES,
  PROVIDER_RUN_LEDGER_LAYERS,
  providerRunRefusal,
  providerRunUnknown,
} from "./provider-run-refusals.js";

const EXPECTED_CODES = [
  "PROVIDER_RUN_RECORD_MALFORMED",
  "PROVIDER_RUN_FIELD_INVALID",
  "PROVIDER_RUN_VERSION_UNSUPPORTED",
  "PROVIDER_RUN_HANDOFF_MALFORMED",
  "PROVIDER_RUN_USAGE_SEQUENCE_INVALID",
  "PROVIDER_RUN_MEASUREMENT_REFUSED",
  "PROVIDER_RUN_BYTES_MALFORMED",
  "PROVIDER_RUN_DIGEST_MISMATCH",
  "PROVIDER_RUN_RECORD_UNREADABLE",
  "PROVIDER_RUN_EVIDENCE_ABSENT",
  "PROVIDER_RUN_EVIDENCE_AMBIGUOUS",
  "PROVIDER_RUN_EVENT_TYPE_UNEXPECTED",
  "PROVIDER_RUN_AGGREGATE_MISMATCH",
  "PROVIDER_RUN_REPLAY_DIVERGED",
  "PROVIDER_RUN_EXPECTED_VERSION_CONFLICT",
  "PROVIDER_RUN_IDEMPOTENCY_CONFLICT",
  "PROVIDER_RUN_STORE_UNAVAILABLE",
] as const;

const EXPECTED_LAYERS = [
  "PROVIDER_RUN_COMPOSITION",
  "PROVIDER_RUN_CODEC",
  "PROVIDER_RUN_LEDGER",
  "PROVIDER_RUN_READER",
] as const;

describe("provider-run closed vocabularies", () => {
  it("publishes exactly the reviewed reason codes in declaration order", () => {
    expect([...PROVIDER_RUN_LEDGER_CODES]).toEqual([...EXPECTED_CODES]);
  });

  it("holds one entry per reviewed reason code and no duplicate", () => {
    expect(PROVIDER_RUN_LEDGER_CODES.length).toBe(EXPECTED_CODES.length);
    expect(new Set(PROVIDER_RUN_LEDGER_CODES).size).toBe(EXPECTED_CODES.length);
  });

  /**
   * Forward-declared for the codec and reader slices, which both refuse with it.
   * If it were absent they would each invent a local code and the family would
   * hold two answers to one question, so its presence is asserted by name here
   * rather than left to the membership list to imply.
   */
  it("carries the unreadable-record code its reader slices import", () => {
    expect(PROVIDER_RUN_LEDGER_CODES).toContain("PROVIDER_RUN_RECORD_UNREADABLE");
  });

  it("publishes exactly the reviewed refusing layers in declaration order", () => {
    expect([...PROVIDER_RUN_LEDGER_LAYERS]).toEqual([...EXPECTED_LAYERS]);
  });

  it("holds one entry per reviewed layer and no duplicate", () => {
    expect(PROVIDER_RUN_LEDGER_LAYERS.length).toBe(EXPECTED_LAYERS.length);
    expect(new Set(PROVIDER_RUN_LEDGER_LAYERS).size).toBe(EXPECTED_LAYERS.length);
  });

  /**
   * A missed `Object.freeze` is invisible until something mutates a shared
   * array at runtime, by which point the vocabulary is no longer closed. Assert
   * the freeze itself; a membership test cannot see it.
   */
  it("freezes both vocabularies", () => {
    expect(Object.isFrozen(PROVIDER_RUN_LEDGER_CODES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_RUN_LEDGER_LAYERS)).toBe(true);
  });
});

describe("provider-run refusals", () => {
  it("carries the exact code, layer and outcome it was given", () => {
    expect(providerRunRefusal("REFUSED", "PROVIDER_RUN_DIGEST_MISMATCH", "PROVIDER_RUN_CODEC"))
      .toEqual({
        code: "PROVIDER_RUN_DIGEST_MISMATCH",
        layer: "PROVIDER_RUN_CODEC",
        ok: false,
        outcome: "REFUSED",
        storeCode: null,
      });
  });

  it("preserves the store's own code verbatim rather than flattening it", () => {
    const refusal = providerRunRefusal(
      "REFUSED",
      "PROVIDER_RUN_STORE_UNAVAILABLE",
      "PROVIDER_RUN_LEDGER",
      "STORE_BUSY",
    );
    expect(refusal.storeCode).toBe("STORE_BUSY");
    expect(refusal.code).toBe("PROVIDER_RUN_STORE_UNAVAILABLE");
    expect(refusal.layer).toBe("PROVIDER_RUN_LEDGER");
    expect(refusal.outcome).toBe("REFUSED");
  });

  /** Epic rail 4: unverifiable evidence stays UNKNOWN and never gains authority. */
  it("answers UNKNOWN for evidence a reader cannot verify", () => {
    expect(providerRunUnknown("PROVIDER_RUN_RECORD_UNREADABLE", "PROVIDER_RUN_READER"))
      .toEqual({
        code: "PROVIDER_RUN_RECORD_UNREADABLE",
        layer: "PROVIDER_RUN_READER",
        ok: false,
        outcome: "UNKNOWN",
        storeCode: null,
      });
  });

  it("freezes the refusal it hands back", () => {
    const refusal = providerRunUnknown("PROVIDER_RUN_EVIDENCE_ABSENT", "PROVIDER_RUN_READER");
    expect(Object.isFrozen(refusal)).toBe(true);
  });
});
