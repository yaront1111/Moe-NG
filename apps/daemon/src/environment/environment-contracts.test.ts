import { describe, expect, it } from "vitest";

import {
  ENVIRONMENT_CODES,
  ENVIRONMENT_CODE_LAYERS,
  ENVIRONMENT_LAYERS,
  ENVIRONMENT_NAMES,
  ENVIRONMENT_REFUSAL_DETAILS,
  ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH,
  ENVIRONMENT_VARIABLE_READ_KEYS,
  MAX_ENVIRONMENT_VALUE_BYTES,
  environmentRefusal,
  environmentValueFingerprint,
  environmentValueFingerprintOfBytes,
  isEnvironmentName,
  isEnvironmentVariableName,
  isEnvironmentValueWithinBound,
} from "./environment-contracts.js";

/**
 * The declarations every other module in this slice reads its rules from. The point of testing a
 * declaration module is that the rules are DERIVED, not restated: the code roster comes from the
 * layer map's keys and the detail roster is keyed by the same codes, so no third place can drift.
 */

describe("ENVIRONMENT_NAMES", () => {
  it("is exactly verify, preview and production", () => {
    expect([...ENVIRONMENT_NAMES]).toEqual(["preview", "production", "verify"]);
  });

  it("accepts every rostered name and refuses anything else, including case variants", () => {
    for (const name of ENVIRONMENT_NAMES) expect(isEnvironmentName(name)).toBe(true);
    for (const other of ["Production", "PRODUCTION", "staging", "", "verify ", 3, null]) {
      expect(isEnvironmentName(other)).toBe(false);
    }
  });
});

describe("the closed code -> layer map", () => {
  it("maps exactly the four refusals this slice can mint", () => {
    expect([...ENVIRONMENT_CODES]).toEqual([
      "ENV_ENVIRONMENT_UNKNOWN",
      "ENV_NAME_INVALID",
      "ENV_STORE_KEY_UNAVAILABLE",
      "ENV_VALUE_TOO_LARGE",
    ]);
  });

  it("DERIVES the code roster from the map's keys, so the two cannot disagree", () => {
    expect([...ENVIRONMENT_CODES]).toEqual(Object.keys(ENVIRONMENT_CODE_LAYERS).sort());
  });

  it("pins each code to its layer", () => {
    expect(ENVIRONMENT_CODE_LAYERS).toEqual({
      ENV_ENVIRONMENT_UNKNOWN: "SCOPE",
      ENV_NAME_INVALID: "NAME",
      ENV_STORE_KEY_UNAVAILABLE: "KEY",
      ENV_VALUE_TOO_LARGE: "VALUE",
    });
  });

  it("uses only rostered layers, and rosters no layer that no code uses", () => {
    const used = new Set(Object.values(ENVIRONMENT_CODE_LAYERS));
    expect([...used].sort()).toEqual([...ENVIRONMENT_LAYERS]);
  });

  it("carries a fixed detail for every code and for no other key", () => {
    expect(Object.keys(ENVIRONMENT_REFUSAL_DETAILS).sort()).toEqual([...ENVIRONMENT_CODES]);
  });
});

describe("environmentRefusal", () => {
  it("derives the layer from the code, so a call site cannot mint a disagreeing pair", () => {
    for (const code of ENVIRONMENT_CODES) {
      const refusal = environmentRefusal(code);
      expect(refusal.ok).toBe(false);
      expect(refusal.code).toBe(code);
      expect(refusal.layer).toBe(ENVIRONMENT_CODE_LAYERS[code]);
      expect(refusal.detail).toBe(ENVIRONMENT_REFUSAL_DETAILS[code]);
    }
  });

  it("returns a frozen record with exactly four members and no value-shaped slot", () => {
    const refusal = environmentRefusal("ENV_VALUE_TOO_LARGE");
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(Object.keys(refusal).sort()).toEqual(["code", "detail", "layer", "ok"]);
  });

  it("carries FIXED prose: no detail interpolates a name, a value or a bound", () => {
    for (const detail of Object.values(ENVIRONMENT_REFUSAL_DETAILS)) {
      expect(detail).not.toMatch(/[0-9]/u);
      expect(detail).not.toContain("${");
    }
  });
});

describe("isEnvironmentVariableName", () => {
  it.each(["A", "MOE_CANARY", "DATABASE_URL", "X9", "A_1_B"])("accepts %s", (name) => {
    expect(isEnvironmentVariableName(name)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["lowercase", "database_url"],
    ["leading underscore", "_LEADING"],
    ["leading digit", "9LIVES"],
    ["hyphen", "A-B"],
    ["dot", "A.B"],
    ["space", "A B"],
    ["equals sign", "A=B"],
    ["NUL byte", "A\u0000B"],
    ["newline", "A\nB"],
  ])("refuses a name with a %s", (_why, name) => {
    expect(isEnvironmentVariableName(name)).toBe(false);
  });

  it("refuses a name one character past the bound and accepts one exactly at it", () => {
    const atBound = `A${"B".repeat(ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH - 1)}`;
    expect(atBound.length).toBe(ENVIRONMENT_VARIABLE_NAME_MAX_LENGTH);
    expect(isEnvironmentVariableName(atBound)).toBe(true);
    expect(isEnvironmentVariableName(`${atBound}C`)).toBe(false);
  });

  it("refuses non-strings without throwing", () => {
    for (const other of [null, undefined, 7, {}, ["A"]]) {
      expect(isEnvironmentVariableName(other)).toBe(false);
    }
  });
});

describe("isEnvironmentValueWithinBound", () => {
  it("bounds by UTF-8 BYTES, not by code units", () => {
    // Each is 4 UTF-8 bytes, so the bound is reached in a quarter of the characters.
    const wide = "\u{1F600}".repeat(MAX_ENVIRONMENT_VALUE_BYTES / 4);
    expect(isEnvironmentValueWithinBound(wide)).toBe(true);
    expect(isEnvironmentValueWithinBound(`${wide}\u{1F600}`)).toBe(false);
  });

  it("accepts exactly at the bound and refuses one byte past it", () => {
    expect(isEnvironmentValueWithinBound("x".repeat(MAX_ENVIRONMENT_VALUE_BYTES))).toBe(true);
    expect(isEnvironmentValueWithinBound("x".repeat(MAX_ENVIRONMENT_VALUE_BYTES + 1))).toBe(false);
  });

  it("accepts the empty value and refuses non-strings", () => {
    expect(isEnvironmentValueWithinBound("")).toBe(true);
    for (const other of [null, undefined, 7, {}]) {
      expect(isEnvironmentValueWithinBound(other)).toBe(false);
    }
  });
});

describe("environmentValueFingerprint", () => {
  it("is the lowercase 64-hex sha256 of the value's UTF-8 bytes", () => {
    // sha256("") - a fixed vector, so a swap to another digest reddens rather than self-agrees.
    expect(environmentValueFingerprint("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(environmentValueFingerprint("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("CHANGES when the value changes and is STABLE when it does not", () => {
    expect(environmentValueFingerprint("v1")).toBe(environmentValueFingerprint("v1"));
    expect(environmentValueFingerprint("v1")).not.toBe(environmentValueFingerprint("v2"));
  });

  it("never contains the value it fingerprints", () => {
    expect(environmentValueFingerprint("deadbeef")).not.toContain("deadbeef");
  });

  it("agrees with the BYTES form the read path uses, so the two cannot drift", () => {
    const encoder = new TextEncoder();
    for (const value of ["", "abc", "a value with spaces", "\u{1F600}é"]) {
      expect(environmentValueFingerprintOfBytes(encoder.encode(value)))
        .toBe(environmentValueFingerprint(value));
    }
  });
});

describe("the READ shape", () => {
  it("is exactly name, isSet, fingerprintSha256 and updatedAt - and no value", () => {
    expect([...ENVIRONMENT_VARIABLE_READ_KEYS]).toEqual([
      "fingerprintSha256", "isSet", "name", "updatedAt",
    ]);
  });

  it("rosters no key whose name could hold a plaintext value", () => {
    for (const key of ENVIRONMENT_VARIABLE_READ_KEYS) {
      expect(key.toLowerCase()).not.toContain("value");
      expect(key.toLowerCase()).not.toContain("secret");
      expect(key.toLowerCase()).not.toContain("plaintext");
    }
  });
});
