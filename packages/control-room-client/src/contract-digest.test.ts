import { expect, it } from "vitest";

import { canonicalContractSurface, deriveContractDigest } from "./contract-digest.js";
import { GENERATED_CONTRACT_DIGEST } from "./generated/generated-client.js";

const CONTRACT_SURFACE_KEYS = Object.freeze([
  "aggregates",
  "commandEnvelopeVersion",
  "commandKinds",
  "errorRegistryVersion",
  "errors",
  "lifecycles",
  "limits",
  "queryEnvelopeVersion",
  "queryKinds",
  "safeDetailKeys",
  "telemetryKinds",
] as const);

it("the generated pin equals the derived contract digest", () => {
  expect(deriveContractDigest()).toBe(GENERATED_CONTRACT_DIGEST);
});

it("emits a lowercase 64-hex digest", () => {
  expect(deriveContractDigest()).toMatch(/^[0-9a-f]{64}$/u);
});

it("is byte-stable across repeated derivations", () => {
  expect(deriveContractDigest()).toBe(deriveContractDigest());
});

it("serializes exactly the generated contract surface keys", () => {
  const parsed: unknown = JSON.parse(canonicalContractSurface());
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  expect(Array.isArray(parsed)).toBe(false);
  expect(Object.keys(parsed as Readonly<Record<string, unknown>>).sort()).toEqual(
    [...CONTRACT_SURFACE_KEYS].sort(),
  );
});
