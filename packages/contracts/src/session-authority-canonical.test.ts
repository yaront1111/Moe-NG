import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  SESSION_AUTHORITY_SCHEMA_VERSION,
  SESSION_PROOF_ALGORITHM,
  SESSION_PROOF_DOMAIN,
  SESSION_PROOF_PROTOCOL_VERSION,
  canonicalSessionProofBytes,
  sessionAuthorityCanonicalString,
} from "@moe/contracts";
import type { SessionProofChallengeFields } from "@moe/contracts";
const PROOF_FIELD_ORDER = Object.freeze([
  "principalId",
  "projectId",
  "recoveryIncarnationRef",
  "keyEpochRef",
  "sessionId",
  "credentialId",
  "generation",
  "clientKeyId",
  "transportId",
  "requestId",
  "requestDigest",
  "issuedAt",
  "nonce",
] as const satisfies readonly (keyof SessionProofChallengeFields)[]);
const COMPACT_CHALLENGE = Object.freeze({
  principalId: "p",
  projectId: "q",
  recoveryIncarnationRef: "i",
  keyEpochRef: "k",
  sessionId: "s",
  credentialId: "c",
  generation: 1,
  clientKeyId: "x",
  transportId: "t",
  requestId: "r",
  requestDigest: "d",
  issuedAt: 0,
  nonce: "n",
} satisfies SessionProofChallengeFields);

const COMPACT_PROOF_HEX = "6d6f652e73657373696f6e2d70726f6f662e7631" +
  "000000017000000001710000000169000000016b00000001730000000163" +
  "000000013100000001780000000174000000017200000001640000000130" +
  "000000016e";

const UTF8 = new TextEncoder();

function challenge(overrides: Partial<SessionProofChallengeFields> = {}): SessionProofChallengeFields {
  return { ...COMPACT_CHALLENGE, ...overrides };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function proofError(input: unknown): TypeError {
  try {
    canonicalSessionProofBytes(input as SessionProofChallengeFields);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    if (error instanceof TypeError) return error;
    throw error;
  }
  throw new Error("expected session proof challenge refusal");
}

const missingNonce: Record<string, unknown> = { ...COMPACT_CHALLENGE };
delete missingNonce["nonce"];

const accessorChallenge: Record<string, unknown> = { ...COMPACT_CHALLENGE };
let accessorReads = 0;
Object.defineProperty(accessorChallenge, "nonce", {
  enumerable: true,
  get: () => {
    accessorReads += 1;
    return "n";
  },
});

const symbolChallenge: Record<PropertyKey, unknown> = { ...COMPACT_CHALLENGE };
symbolChallenge[Symbol("hidden")] = true;

const revokedChallenge = Proxy.revocable(challenge(), {});
revokedChallenge.revoke();

const HOSTILE_SHAPES: ReadonlyArray<readonly [string, unknown]> = Object.freeze([
  ["missing required field", missingNonce],
  ["extra string field", { ...COMPACT_CHALLENGE, authority: "FULL" }],
  ["extra symbol field", symbolChallenge],
  ["accessor required field", accessorChallenge],
  ["revoked proxy", revokedChallenge.proxy],
]);

const INVALID_NUMERICS: ReadonlyArray<readonly [
  string, "generation" | "issuedAt", number, string,
]> = Object.freeze([
  ["negative generation", "generation", -1, "invalid generation"],
  ["fractional generation", "generation", 1.5, "invalid generation"],
  ["unsafe generation", "generation", Number.MAX_SAFE_INTEGER + 1, "invalid generation"],
  ["negative issuedAt", "issuedAt", -1, "invalid issuedAt"],
  ["fractional issuedAt", "issuedAt", 1.5, "invalid issuedAt"],
  ["unsafe issuedAt", "issuedAt", Number.MAX_SAFE_INTEGER + 1, "invalid issuedAt"],
]);

/**
 * The canonicalization every OPEN_SESSION signature is computed over, extracted so a
 * browser can produce the same bytes the daemon does (task-2f554e29 gates on it).
 *
 * These arms pin the two clauses that distinguish this canonicalizer from the sibling
 * at `distribution/distribution-contract.ts` — the depth cap and the safe-integer
 * refusal. Reusing that sibling instead would change the output for inputs this
 * protocol accepts and would invalidate every persisted signature, so the arms exist
 * to make the difference falsifiable rather than a comment.
 */
describe("session authority canonical string", () => {
  it("normalises key order, which is the property the whole protocol rests on", () => {
    const a = sessionAuthorityCanonicalString({ alpha: 1, beta: 2, gamma: 3 });
    const b = sessionAuthorityCanonicalString({ gamma: 3, alpha: 1, beta: 2 });
    expect(a).toBe(b);
    // Asserted positively too: equality alone would hold if both sides returned "".
    expect(a).toContain('"alpha":1');
  });

  it("sorts OBJECT keys but preserves ARRAY order", () => {
    // One arm for both, because conflating them is the regression that would survive
    // two separate arms each passing for the wrong reason.
    const canonical = sessionAuthorityCanonicalString({ b: [3, 1, 2], a: "x" });
    expect(canonical.indexOf('"a"')).toBeLessThan(canonical.indexOf('"b"'));
    expect(canonical).toContain("[3,1,2]");
  });

  it("carries the schema version prefix exactly once", () => {
    const canonical = sessionAuthorityCanonicalString({ a: 1 });
    expect(canonical.startsWith(`${SESSION_AUTHORITY_SCHEMA_VERSION}:`)).toBe(true);
    expect(canonical.split(SESSION_AUTHORITY_SCHEMA_VERSION)).toHaveLength(2);
  });

  it("throws past the depth cap and accepts the value one level inside it", () => {
    const nest = (depth: number): unknown => (depth === 0 ? 1 : { a: nest(depth - 1) });
    // The innermost value of nest(k) is visited at depth k, and the guard is `depth > 8`.
    expect(() => sessionAuthorityCanonicalString(nest(8))).not.toThrow();
    expect(() => sessionAuthorityCanonicalString(nest(9)))
      .toThrow("canonical value nested too deeply");
  });

  it("refuses a non-safe-integer number and serialises a safe one", () => {
    expect(() => sessionAuthorityCanonicalString({ a: 1.5 }))
      .toThrow("canonical numbers are safe integers");
    expect(() => sessionAuthorityCanonicalString({ a: Number.MAX_SAFE_INTEGER + 2 }))
      .toThrow("canonical numbers are safe integers");
    expect(sessionAuthorityCanonicalString({ a: 42 })).toContain('"a":42');
  });

  it("throws on values it cannot canonicalise rather than dropping them", () => {
    // A silent drop is the dangerous failure: two different requests would canonicalise
    // to the same bytes and therefore share a signature.
    expect(() => sessionAuthorityCanonicalString({ a: undefined }))
      .toThrow("unsupported canonical value");
    expect(() => sessionAuthorityCanonicalString({ a: () => 1 }))
      .toThrow("unsupported canonical value");
    expect(() => sessionAuthorityCanonicalString({ a: Symbol("s") }))
      .toThrow("unsupported canonical value");
  });

  it("serialises null, booleans and strings the way the wire format requires", () => {
    expect(sessionAuthorityCanonicalString(null)).toBe(`${SESSION_AUTHORITY_SCHEMA_VERSION}:null`);
    expect(sessionAuthorityCanonicalString({ a: true, b: false })).toContain('"a":true,"b":false');
    expect(sessionAuthorityCanonicalString({ a: 'q"uote' })).toContain('"a":"q\\"uote"');
  });
});

describe("session proof canonical bytes", () => {
  it("publishes the exact shared literals and thirteen-field structural type", () => {
    expect(SESSION_PROOF_PROTOCOL_VERSION).toBe(1);
    expect(SESSION_PROOF_ALGORITHM).toBe("Ed25519");
    expect(SESSION_PROOF_DOMAIN).toBe("moe.session-proof.v1");
    expect(PROOF_FIELD_ORDER).toHaveLength(13);
    expect(Object.keys(COMPACT_CHALLENGE)).toStrictEqual(PROOF_FIELD_ORDER);
  });

  it("pins the full domain plus u32be-framed field-order oracle", () => {
    const reversedOrder = [...PROOF_FIELD_ORDER].reverse();
    const reordered = Object.fromEntries(
      reversedOrder.map((field) => [field, COMPACT_CHALLENGE[field]]),
    );
    expect(Reflect.ownKeys(reordered)).toStrictEqual(reversedOrder);

    const bytes = canonicalSessionProofBytes(reordered as SessionProofChallengeFields);
    const domainBytes = UTF8.encode(SESSION_PROOF_DOMAIN);
    const firstHeader = bytes.subarray(domainBytes.byteLength, domainBytes.byteLength + 4);

    expect(bytes.subarray(0, domainBytes.byteLength)).toStrictEqual(domainBytes);
    expect([...firstHeader]).toStrictEqual([0, 0, 0, 1]);
    expect(new DataView(firstHeader.buffer, firstHeader.byteOffset, 4).getUint32(0, false)).toBe(1);
    expect(toHex(bytes)).toBe(COMPACT_PROOF_HEX);
    expect(bytes).toHaveLength(85);
  });

  it("frames multibyte values by UTF-8 byte length rather than JS string length", () => {
    const principalId = "é🧪";
    const principalBytes = UTF8.encode(principalId);
    expect(principalId).toHaveLength(3);
    expect(principalBytes).toHaveLength(6);

    const bytes = canonicalSessionProofBytes(challenge({ principalId }));
    const headerOffset = UTF8.encode(SESSION_PROOF_DOMAIN).byteLength;
    const principalLength = new DataView(
      bytes.buffer,
      bytes.byteOffset + headerOffset,
      4,
    ).getUint32(0, false);

    expect(principalLength).toBe(6);
    expect(bytes.subarray(headerOffset + 4, headerOffset + 10)).toStrictEqual(principalBytes);
    expect(bytes).toHaveLength(90);
  });

  it("generates the exact nonzero hostile-shape and numeric tables", () => {
    expect(HOSTILE_SHAPES.length).toBeGreaterThan(0);
    expect(HOSTILE_SHAPES).toHaveLength(5);
    expect(HOSTILE_SHAPES.map(([name]) => name)).toStrictEqual([
      "missing required field",
      "extra string field",
      "extra symbol field",
      "accessor required field",
      "revoked proxy",
    ]);
    expect(INVALID_NUMERICS.length).toBeGreaterThan(0);
    expect(INVALID_NUMERICS).toHaveLength(6);
    expect(INVALID_NUMERICS.map(([name]) => name)).toStrictEqual([
      "negative generation",
      "fractional generation",
      "unsafe generation",
      "negative issuedAt",
      "fractional issuedAt",
      "unsafe issuedAt",
    ]);
  });

  it.each(HOSTILE_SHAPES)("refuses hostile own-data shape: %s", (_name, input) => {
    expect(proofError(input).message).toBe("invalid session proof challenge fields");
  });

  it("contains an accessor without invoking it", () => {
    expect(accessorReads).toBe(0);
    expect(proofError(accessorChallenge).message).toBe("invalid session proof challenge fields");
    expect(accessorReads).toBe(0);
  });

  it.each(INVALID_NUMERICS)("refuses invalid numeric scalar: %s", (
    _name,
    field,
    value,
    expectedMessage,
  ) => {
    const overrides = field === "generation" ? { generation: value } : { issuedAt: value };
    expect(proofError(challenge(overrides)).message).toBe(expectedMessage);
  });

  it.each([
    ["zero", 0, "0000000130"],
    [
      "maximum safe integer",
      Number.MAX_SAFE_INTEGER,
      "0000001039303037313939323534373430393931",
    ],
  ] as const)("accepts the unsigned numeric boundary: %s", (_name, boundary, expectedFrame) => {
    const bytes = canonicalSessionProofBytes(challenge({
      generation: boundary,
      issuedAt: boundary,
    }));
    expect(toHex(bytes).split(expectedFrame)).toHaveLength(3);
  });

  it("keeps the browser production module free of Node, Buffer, and verifier exports", async () => {
    const source = await readFile(
      new URL("./session-authority-canonical.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']node:/u,
    );
    expect(source).not.toMatch(
      /(?:\bBuffer\s*(?:\.|\(|<|\[)|\bimport\b[^\n]*\bBuffer\b)/u,
    );
    expect(source).not.toMatch(
      /\bexport\s+(?:(?:async|declare)\s+)*(?:class|const|function|let|var)\s+verify\w*/u,
    );
    expect(source).not.toMatch(/\bexport\s*\{[^}]*\bverify\w*/su);
  });
});
