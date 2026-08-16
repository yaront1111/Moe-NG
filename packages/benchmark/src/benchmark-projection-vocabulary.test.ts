import { describe, expect, it } from "vitest";

import {
  BENCHMARK_PROJECTION_CODES, BENCHMARK_PROJECTION_LAYERS, BENCHMARK_PROJECTION_MESSAGES,
  benchmarkProjectionRefusal,
} from "./benchmark-projection-vocabulary.js";

describe("benchmark projection vocabulary", () => {
  it("declares a closed, frozen, duplicate-free code list", () => {
    expect(Object.isFrozen(BENCHMARK_PROJECTION_CODES)).toBe(true);
    expect(BENCHMARK_PROJECTION_CODES.length).toBeGreaterThan(0);
    expect(new Set(BENCHMARK_PROJECTION_CODES).size).toBe(BENCHMARK_PROJECTION_CODES.length);
    expect([...BENCHMARK_PROJECTION_CODES]).toEqual([...BENCHMARK_PROJECTION_CODES].sort());
  });

  it("declares a closed, frozen, duplicate-free layer list", () => {
    expect(Object.isFrozen(BENCHMARK_PROJECTION_LAYERS)).toBe(true);
    expect(BENCHMARK_PROJECTION_LAYERS.length).toBeGreaterThan(0);
    expect(new Set(BENCHMARK_PROJECTION_LAYERS).size).toBe(BENCHMARK_PROJECTION_LAYERS.length);
  });

  it("names exactly the projection failures, and no run outcome or campaign verdict", () => {
    expect([...BENCHMARK_PROJECTION_CODES]).toEqual([
      "BENCHMARK_RECORD_FIELD_ABSENT",
      "BENCHMARK_RECORD_FIELD_MALFORMED",
      "BENCHMARK_RECORD_NOT_PLAIN_DATA",
      "BENCHMARK_RECORD_VERSION_UNRECOGNISED",
      "BENCHMARK_ROW_BASIS_ABSENT",
    ]);
    expect([...BENCHMARK_PROJECTION_LAYERS]).toEqual([
      "BENCHMARK_INPUT", "BENCHMARK_VERSION", "BENCHMARK_SHAPE", "BENCHMARK_ROW",
    ]);
  });

  it("carries one distinct static message per code and no message for anything else", () => {
    const swept = BENCHMARK_PROJECTION_CODES.map((code) => BENCHMARK_PROJECTION_MESSAGES[code]);
    expect(swept.length).toBe(BENCHMARK_PROJECTION_CODES.length);
    expect(swept.length).toBeGreaterThan(0);
    for (const message of swept) expect(message.length).toBeGreaterThan(0);
    // Distinct: a message copy-pasted onto a second code would make the two
    // indistinguishable to a reader who has only the durable bytes.
    expect(new Set(swept).size).toBe(swept.length);
    expect(Object.keys(BENCHMARK_PROJECTION_MESSAGES).sort())
      .toEqual([...BENCHMARK_PROJECTION_CODES].sort());
  });

  it("interpolates nothing into a message, so no failure path echoes its input", () => {
    let swept = 0;
    for (const code of BENCHMARK_PROJECTION_CODES) {
      const message = BENCHMARK_PROJECTION_MESSAGES[code];
      expect(message).not.toContain(code);
      expect(message).not.toMatch(/[${}]/u);
      swept += 1;
    }
    expect(swept).toBe(BENCHMARK_PROJECTION_CODES.length);
    expect(swept).toBeGreaterThan(0);
  });

  it("mints a refusal that carries its own code, layer and static message", () => {
    const refusal = benchmarkProjectionRefusal("BENCHMARK_ROW_BASIS_ABSENT", "BENCHMARK_ROW");
    expect(refusal).toEqual({
      ok: false,
      code: "BENCHMARK_ROW_BASIS_ABSENT",
      layer: "BENCHMARK_ROW",
      message: BENCHMARK_PROJECTION_MESSAGES.BENCHMARK_ROW_BASIS_ABSENT,
    });
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  it("mints a refusal for every declared code and layer pairing it is asked for", () => {
    let swept = 0;
    for (const code of BENCHMARK_PROJECTION_CODES) {
      for (const layer of BENCHMARK_PROJECTION_LAYERS) {
        const refusal = benchmarkProjectionRefusal(code, layer);
        expect(refusal.ok).toBe(false);
        expect(refusal.code).toBe(code);
        expect(refusal.layer).toBe(layer);
        expect(refusal.message).toBe(BENCHMARK_PROJECTION_MESSAGES[code]);
        swept += 1;
      }
    }
    expect(swept).toBe(BENCHMARK_PROJECTION_CODES.length * BENCHMARK_PROJECTION_LAYERS.length);
    expect(swept).toBeGreaterThan(0);
  });
});
