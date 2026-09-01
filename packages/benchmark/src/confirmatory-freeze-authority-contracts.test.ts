import { describe, expect, it } from "vitest";

import {
  CONFIRMATORY_FREEZE_AUTHORITY_CODES,
  validateConfirmatoryFreezeAuthorityRecord,
} from "./index.js";

const encoder = new TextEncoder();
const bytes = (value: unknown): Uint8Array => encoder.encode(
  typeof value === "string" ? value : JSON.stringify(value),
);

const validRecord = (): Record<string, unknown> => ({
  schemaVersion: 1,
  scope: "CONFIRMATORY_BENCHMARK_CORPUS",
  scopeReference: "urn:moe:benchmark:confirmatory-corpus",
  independentAuthor: "external-author-identifier",
  custodian: "external-custodian-identifier",
  allowedViewers: ["authorized-viewer-class"],
  restrictedArtifactBoundary: "confirmatory-artifacts-only",
  separationFromImplementers: "independence-attested",
  signatureAlgorithm: "human-selected-algorithm",
  signatureEncoding: "human-selected-encoding",
  signerKeyId: "human-provided-key-reference",
  trustedPublicKeyDistribution: "human-provided-distribution-semantics",
  keyRotation: "human-provided-rotation-semantics",
  canonicalBytesCovered: "human-defined-canonical-byte-domain",
  issuedAt: "2026-08-23T00:00:00.000Z",
  timestampSemantics: "utc-rfc3339",
  publicRegistryReference: "human-provided-public-registry-reference",
  registrySemantics: "append-only-public-registration",
  redactionRules: "human-defined-redaction-rules",
  staleAfter: "2998-01-01T00:00:00.000Z",
  expiresAt: "2999-01-01T00:00:00.000Z",
  revokedAt: null,
});

const FAILURE_CASES = Object.freeze([
  ["record missing", new Uint8Array(), "CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED"],
  ["malformed record", bytes("{"), "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED"],
  ["unreadable schema", bytes({ ...validRecord(), schemaVersion: 2 }), "CONFIRMATORY_FREEZE_AUTHORITY_UNREADABLE"],
  ["stale record", bytes({ ...validRecord(), issuedAt: "2000-01-01T00:00:00.000Z", staleAfter: "2001-01-01T00:00:00.000Z" }), "CONFIRMATORY_FREEZE_AUTHORITY_STALE"],
  ["expired record", bytes({ ...validRecord(), issuedAt: "1998-01-01T00:00:00.000Z", staleAfter: "1999-01-01T00:00:00.000Z", expiresAt: "2000-01-01T00:00:00.000Z" }), "CONFIRMATORY_FREEZE_AUTHORITY_EXPIRED"],
  ["revoked record", bytes({ ...validRecord(), revokedAt: "2026-08-23T01:00:00.000Z" }), "CONFIRMATORY_FREEZE_AUTHORITY_REVOKED"],
  ["foreign scope", bytes({ ...validRecord(), scope: "OTHER_CORPUS" }), "CONFIRMATORY_FREEZE_AUTHORITY_FOREIGN_SCOPE"],
  ["conflicting duplicate", [bytes(validRecord()), bytes(validRecord())], "CONFIRMATORY_FREEZE_AUTHORITY_CONFLICTING_DUPLICATE"],
] as const);

describe("confirmatory freeze authority contracts (task-3a10eb6b)", () => {
  for (const [name, source, expectedCode] of FAILURE_CASES) {
    it(`refuses ${name} with its exact code and layer`, () => {
      const result = validateConfirmatoryFreezeAuthorityRecord(source);

      expect(result).toMatchObject({
        authority: "NONE",
        code: expectedCode,
        layer: "CONFIRMATORY_FREEZE_AUTHORITY",
        ok: false,
      });
    });
  }

  it.each([null, [], "not-an-object"])(
    "refuses malformed JSON root %j at the authority layer",
    (root) => {
      const result = validateConfirmatoryFreezeAuthorityRecord(bytes(root));

      expect(result).toMatchObject({
        authority: "NONE",
        code: "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED",
        layer: "CONFIRMATORY_FREEZE_AUTHORITY",
      });
    },
  );

  it.each([null, {}, ["not-bytes"]])(
    "refuses an invalid byte source %j instead of throwing",
    (source) => {
      const forced = validateConfirmatoryFreezeAuthorityRecord as unknown as (
        value: unknown,
      ) => ReturnType<typeof validateConfirmatoryFreezeAuthorityRecord>;

      expect(forced(source)).toMatchObject({
        authority: "NONE",
        code: "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED",
        layer: "CONFIRMATORY_FREEZE_AUTHORITY",
        ok: false,
      });
    },
  );

  it("refuses a smuggled key instead of trimming it", () => {
    const result = validateConfirmatoryFreezeAuthorityRecord(bytes({
      ...validRecord(),
      injectedAuthority: "smuggled",
    }));

    expect(result).toMatchObject({
      authority: "NONE",
      code: "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED",
      layer: "CONFIRMATORY_FREEZE_AUTHORITY",
      ok: false,
    });
  });

  it("refuses an oversized record before permissive JSON whitespace can hide its size", () => {
    const oversized = bytes(`${" ".repeat(65_536)}${JSON.stringify(validRecord())}`);

    const result = validateConfirmatoryFreezeAuthorityRecord(oversized);

    expect(result).toMatchObject({
      authority: "NONE",
      code: "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED",
      layer: "CONFIRMATORY_FREEZE_AUTHORITY",
      ok: false,
    });
  });

  it("keeps the advertised and production-observed refusal codes equal", () => {
    expect(FAILURE_CASES.length).toBeGreaterThan(0);
    const observed = FAILURE_CASES.map(([, source]) => {
      const result = validateConfirmatoryFreezeAuthorityRecord(source);
      if (result.ok) throw new Error("failure case unexpectedly granted authority");
      return result.code;
    }).sort();

    expect([...new Set(observed)]).toEqual([...CONFIRMATORY_FREEZE_AUTHORITY_CODES].sort());
  });

  it("keeps authority NONE on every production-observed refusal", () => {
    expect(FAILURE_CASES.length).toBeGreaterThan(0);
    const observed = FAILURE_CASES.map(([, source]) =>
      validateConfirmatoryFreezeAuthorityRecord(source),
    );

    expect(observed.every((result) => !result.ok)).toBe(true);
    expect([...new Set(observed.map((result) => result.authority))]).toEqual(["NONE"]);
  });

  it("validates a complete record without choosing human-reserved field values", () => {
    const result = validateConfirmatoryFreezeAuthorityRecord(bytes(validRecord()));

    expect(result).toMatchObject({
      authority: "CONFIRMATORY_FREEZE_AUTHORITY",
      ok: true,
      record: validRecord(),
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.record)).toBe(true);
      expect(Object.isFrozen(result.record.allowedViewers)).toBe(true);
    }
  });
});
