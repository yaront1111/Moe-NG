import { describe, expect, it } from "vitest";

import { SESSION_AUTHORITY_SCHEMA_VERSION, sessionAuthorityCanonicalString }
  from "@moe/contracts";

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
