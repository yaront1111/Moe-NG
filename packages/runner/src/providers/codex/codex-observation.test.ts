import { describe, expect, it } from "vitest";

import {
  CODEX_RUNTIME_OBSERVATION_VERSION,
  buildProviderRuntimeObservation,
  codexFailure,
  observationDigestInput,
  runtimePinningIsAuthoritative,
  type BuildObservationInput,
} from "./codex-observation.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const clock = { observedAt: () => "2026-08-09T10:00:00.000Z" };

const input = (overrides: Partial<BuildObservationInput> = {}): BuildObservationInput => ({
  resolvedRuntimeClosure: [
    { kind: "PACKAGE", path: "z/package", sha256: DIGEST_B },
    { kind: "EXECUTABLE", path: "a/codex", sha256: DIGEST_A },
  ],
  reportedVersion: "codex-cli 1.0",
  adapterCapabilitySchemaDigest: DIGEST_A,
  pinningMethod: "CONTENT_ADDRESSED_COPY",
  platformIdentity: { os: "linux", arch: "x64", osVersion: "6.8" },
  clock,
  ...overrides,
});

describe("Codex runtime observation", () => {
  it("sorts closure paths before hashing and freezes the result", () => {
    const first = buildProviderRuntimeObservation(input());
    const second = buildProviderRuntimeObservation(input({
      resolvedRuntimeClosure: [...input().resolvedRuntimeClosure].reverse(),
    }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.observation.observationVersion).toBe(CODEX_RUNTIME_OBSERVATION_VERSION);
    expect(first.observation.providerId).toBe("codex");
    expect(first.observation.resolvedRuntimeClosure.map((entry) => entry.path)).toEqual([
      "a/codex",
      "z/package",
    ]);
    expect(first.observation.observationDigest).toBe(second.observation.observationDigest);
    expect(Object.isFrozen(first.observation)).toBe(true);
    expect(Object.isFrozen(first.observation.resolvedRuntimeClosure)).toBe(true);
    expect(observationDigestInput(first.observation)).not.toHaveProperty("observationDigest");
  });

  it("keeps observed truth independent from unsupported runtime pinning", () => {
    const result = buildProviderRuntimeObservation(input({ pinningMethod: "UNSUPPORTED" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.truthClass).toBe("PROVEN");
    expect(runtimePinningIsAuthoritative(result.observation)).toBe(false);
  });

  it("refuses duplicate paths with the stable duplicate code", () => {
    const duplicate = { kind: "EXECUTABLE" as const, path: "codex", sha256: DIGEST_A };
    const result = buildProviderRuntimeObservation(input({
      resolvedRuntimeClosure: [duplicate, { ...duplicate, sha256: DIGEST_B }],
    }));
    expect(result).toMatchObject({ ok: false, code: "CODEX_OBSERVATION_CLOSURE_DUPLICATE" });
  });

  it.each([
    ["non-array", null],
    ["non-record entry", [null]],
  ])("refuses a hostile %s closure without throwing", (_label, closure) => {
    const result = buildProviderRuntimeObservation(input({
      resolvedRuntimeClosure: closure as unknown as BuildObservationInput["resolvedRuntimeClosure"],
    }));
    expect(result).toMatchObject({ ok: false, code: "CODEX_OBSERVATION_CLOSURE_INVALID" });
  });

  it("uses one frozen failure shape", () => {
    const failure = codexFailure("CODEX_TEST", "refused");
    expect(Object.keys(failure).sort()).toEqual(["code", "message", "ok"]);
    expect(Object.isFrozen(failure)).toBe(true);
  });
});
