import { describe, expect, it } from "vitest";

import {
  CONFIRMATORY_FREEZE_BINDING_KINDS, CONFIRMATORY_FREEZE_MANIFEST_MAX_BYTES,
  FREEZE_MANIFEST_SCHEMA_VERSION, canonicalizeConfirmatoryFreezeManifest,
  decodeConfirmatoryFreezeManifest,
} from "./freeze-manifest-contracts.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const IMPLEMENTATION_SHA = "c".repeat(40);

const manifest = (): Record<string, unknown> => ({
  schemaVersion: FREEZE_MANIFEST_SCHEMA_VERSION,
  projectId: "moe-next",
  campaignLabel: "confirmatory-r4",
  campaignId: SHA_A,
  implementationSha: IMPLEMENTATION_SHA,
  implementationFrozenAt: "2026-08-24T10:00:00.000Z",
  sealedAt: "2026-08-24T10:00:01.000Z",
  manifestRegistryRef: `sha256:${SHA_A}`,
  attestation: { status: "UNATTESTED", signerKeyId: null, publicRegistryReference: null },
  bindings: CONFIRMATORY_FREEZE_BINDING_KINDS.map((kind) => ({ kind, sha256: SHA_B })),
});

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const refusalOf = (input: unknown) => {
  const result = decodeConfirmatoryFreezeManifest(input);
  if (result.ok) throw new Error("expected a contract refusal");
  return result;
};

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

describe("confirmatory freeze manifest wire contract", () => {
  it("decodes canonical literal UTF-8 bytes and rebuilds a frozen value", () => {
    const input = manifest();
    const result = decodeConfirmatoryFreezeManifest(bytes(input));
    if (!result.ok) throw new Error(`${result.code} at ${result.layer}`);
    expect(result.manifest).toEqual(input);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.attestation)).toBe(true);
    expect(Object.isFrozen(result.manifest.bindings)).toBe(true);
    expect(Object.isFrozen(result.manifest.bindings[0])).toBe(true);
    expect(canonicalizeConfirmatoryFreezeManifest(result.manifest)).toBe(JSON.stringify(input));
  });

  it("rejects every missing or extra top-level key with exact attribution", () => {
    const base = manifest();
    let generatedCases = 0;
    for (const key of Object.keys(base)) {
      const refusal = refusalOf(bytes(without(base, key)));
      expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED");
      expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
      generatedCases += 1;
    }
    const refusal = refusalOf(bytes({ ...base, unexpected: true }));
    expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED");
    expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
    generatedCases += 1;
    expect(generatedCases).toBe(11);
    expect(generatedCases).toBeGreaterThan(0);
  });

  it("rejects every missing or extra attestation and binding key", () => {
    const base = manifest();
    const attestation = base.attestation as Record<string, unknown>;
    const binding = (base.bindings as readonly Record<string, unknown>[])[0] as Record<string, unknown>;
    let generatedCases = 0;
    for (const key of Object.keys(attestation)) {
      const refusal = refusalOf(bytes({ ...base, attestation: without(attestation, key) }));
      expect([refusal.code, refusal.layer]).toEqual([
        "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT",
      ]);
      generatedCases += 1;
    }
    for (const key of Object.keys(binding)) {
      const changed = [...base.bindings as readonly Record<string, unknown>[]];
      changed[0] = without(binding, key);
      const refusal = refusalOf(bytes({ ...base, bindings: changed }));
      expect([refusal.code, refusal.layer]).toEqual([
        "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT",
      ]);
      generatedCases += 1;
    }
    for (const [field, value] of [["attestation", { ...attestation, extra: 1 }], [
      "bindings", [{ ...binding, extra: 1 }, ...(base.bindings as readonly unknown[]).slice(1)],
    ]] as const) {
      const refusal = refusalOf(bytes({ ...base, [field]: value }));
      expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED");
      expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
      generatedCases += 1;
    }
    expect(generatedCases).toBe(7);
    expect(generatedCases).toBeGreaterThan(0);
  });

  /**
   * FOUND BY A SURVIVING MUTANT, not by inspection. Two different guards answer
   * CONFIRMATORY_FREEZE_MANIFEST_MALFORMED at the same layer for an extra member: the exact-key
   * roster inside `readAttestation`/`readBindings`, and the canonical-JSON comparison that runs
   * after the manifest has been rebuilt without the stray key. Asserting the code alone cannot
   * tell them apart, so disabling the exact-key roster left the whole suite green. These arms
   * pin the exact refusing message and require all three to differ, which grades each guard on
   * its own instead of on its downstream twin.
   */
  it("distinguishes the exact-key roster from the canonical-JSON fence by refusing message", () => {
    const base = manifest();
    const attestation = base.attestation as Record<string, unknown>;
    const bindings = base.bindings as readonly Record<string, unknown>[];
    const binding = bindings[0] as Record<string, unknown>;

    const extraAttestation = refusalOf(bytes({
      ...base, attestation: { ...attestation, extra: 1 },
    }));
    const extraBinding = refusalOf(bytes({
      ...base, bindings: [{ ...binding, extra: 1 }, ...bindings.slice(1)],
    }));
    // Every roster is intact here and only the serialized key order diverges, so this case can
    // only be answered by the canonical fence.
    const reordered = refusalOf(bytes(Object.fromEntries(Object.entries(base).reverse())));

    let generatedCases = 0;
    for (const [refusal, message] of [
      [extraAttestation, "attestation must be UNATTESTED"],
      [extraBinding, "binding entry is malformed"],
      [reordered, "manifest is not canonical JSON"],
    ] as const) {
      expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED");
      expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
      expect(refusal.message).toBe(message);
      generatedCases += 1;
    }
    expect(generatedCases).toBe(3);
    expect(generatedCases).toBeGreaterThan(0);
    expect(new Set([
      extraAttestation.message, extraBinding.message, reordered.message,
    ]).size).toBe(3);
  });

  it("guards the binding roster in both directions and rejects order changes", () => {
    const advertised = [...CONFIRMATORY_FREEZE_BINDING_KINDS].sort();
    const served = (manifest().bindings as readonly { kind: string }[]).map(({ kind }) => kind).sort();
    expect(served).toEqual(advertised);
    expect(served).toHaveLength(12);

    const base = manifest();
    const roster = [...base.bindings as readonly Record<string, unknown>[]];
    const cases: readonly unknown[][] = [
      roster.slice(1),
      [...roster, { kind: "INVENTED", sha256: SHA_B }],
      [...roster.slice(0, -1), { kind: "DESIGN", sha256: SHA_B }],
      [roster[1], roster[0], ...roster.slice(2)],
    ];
    let generatedCases = 0;
    for (const bindings of cases) {
      const refusal = refusalOf(bytes({ ...base, bindings }));
      expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED");
      expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
      generatedCases += 1;
    }
    expect(generatedCases).toBe(4);
    expect(generatedCases).toBeGreaterThan(0);
  });

  it("distinguishes a conflicting duplicate binding", () => {
    const base = manifest();
    const roster = [...base.bindings as readonly Record<string, unknown>[]];
    roster[1] = { kind: "DESIGN", sha256: SHA_A };
    const refusal = refusalOf(bytes({ ...base, bindings: roster }));
    expect(refusal.code).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONFLICTING");
    expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
  });

  it("rejects absent, non-byte, invalid, oversized, and noncanonical inputs", () => {
    const base = manifest();
    const invalidUtf8 = Uint8Array.from([0xc3, 0x28]);
    const cases: readonly [unknown, string][] = [
      [undefined, "CONFIRMATORY_FREEZE_MANIFEST_MISSING"],
      [new Uint8Array(), "CONFIRMATORY_FREEZE_MANIFEST_MISSING"],
      [null, "CONFIRMATORY_FREEZE_MANIFEST_MISSING"],
      [{}, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [[], "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      ["manifest", "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [invalidUtf8, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [new TextEncoder().encode("{"), "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [new Uint8Array(CONFIRMATORY_FREEZE_MANIFEST_MAX_BYTES + 1), "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [new TextEncoder().encode(JSON.stringify(base, null, 2)), "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
    ];
    let generatedCases = 0;
    for (const [input, code] of cases) {
      const refusal = refusalOf(input);
      expect(refusal.code).toBe(code);
      expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
      generatedCases += 1;
    }
    expect(generatedCases).toBe(10);
    expect(generatedCases).toBeGreaterThan(0);
  });

  it("rejects invalid versions, hashes, times, text bounds, and attestation claims", () => {
    const base = manifest();
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ ...base, schemaVersion: "moe-confirmatory-freeze-manifest/2" }, "CONFIRMATORY_FREEZE_MANIFEST_STALE"],
      [{ ...base, implementationSha: "A".repeat(40) }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, campaignId: "0".repeat(63) }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, campaignLabel: "" }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, projectId: " moe-next" }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, sealedAt: "not-a-time" }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, sealedAt: base.implementationFrozenAt }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, manifestRegistryRef: SHA_A }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, attestation: { status: "ATTESTED", signerKeyId: null, publicRegistryReference: null } }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
      [{ ...base, attestation: { status: "UNATTESTED", signerKeyId: "fake", publicRegistryReference: null } }, "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"],
    ];
    let generatedCases = 0;
    for (const [input, code] of cases) {
      const refusal = refusalOf(bytes(input));
      expect(refusal.code).toBe(code);
      expect(refusal.layer).toBe("CONFIRMATORY_FREEZE_MANIFEST_CONTRACT");
      generatedCases += 1;
    }
    expect(generatedCases).toBe(10);
    expect(generatedCases).toBeGreaterThan(0);
  });
});
