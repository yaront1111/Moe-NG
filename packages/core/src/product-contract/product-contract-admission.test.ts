import { describe, expect, it } from "vitest";
import { admitProductContractRevisionRef } from "./product-contract-admission.js";
import { PRODUCT_CONTRACT_REVISION_REF_KEYS } from "./product-contract-contract.js";
import { createProductContractRevision } from "./product-contract-codec.js";
import { deeplyFrozen, hex, productContractDraft } from "./product-contract-test-fixtures.js";

/**
 * Expected codes and layers are STRING LITERALS here on purpose. Imported from
 * the module under test they would make every refusal arm a fixed point: a
 * hardcoded-return mutant would rewrite the expectation along with the answer.
 */
const INVALID = "PRODUCT_CONTRACT_PROVENANCE_INVALID";
const EXCEEDED = "PRODUCT_CONTRACT_LIMIT_EXCEEDED";
const PROVENANCE = "PROVENANCE";

const revisionOrThrow = () => {
  const result = createProductContractRevision(productContractDraft());
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
};

/** A REAL revision's identity, never a hand-built triple. */
const triple = () => {
  const revision = revisionOrThrow();
  return {
    contractId: revision.contractId,
    revisionDigest: revision.revisionDigest,
    revisionId: revision.revisionId,
  };
};

type Case = readonly [string, unknown, string];

const EXTRA_KEYS = ["authorRef", "criteria", "version", "advisoryOnly", "gate", "workRef"] as const;
const REF_KEYS = ["contractId", "revisionDigest", "revisionId"] as const;
const ID_KEYS = ["contractId", "revisionId"] as const;
const HOSTILE_IDS: readonly (readonly [string, unknown, string])[] = [
  ["a non-string", 42, INVALID],
  ["empty", "", INVALID],
  // Escaped, not pasted: a literal NUL byte and a literal combining acute do
  // not survive every editor, shell or normalising save, and a fixture that
  // got silently repaired would assert nothing while still reading green.
  ["NUL-bearing", "a\u0000b", INVALID],
  ["non-NFC", "e\u0301", INVALID],
  ["513 bytes", "x".repeat(513), EXCEEDED],
];

const withoutKey = (key: string): Record<string, unknown> => {
  const value: Record<string, unknown> = { ...triple() };
  delete value[key];
  return value;
};

const CASES: readonly Case[] = [
  ...EXTRA_KEYS.map((key): Case =>
    [`an extra ${key} key`, { ...triple(), [key]: "extra-value" }, INVALID]),
  ...REF_KEYS.map((key): Case => [`a missing ${key}`, withoutKey(key), INVALID]),
  ...ID_KEYS.flatMap((key): readonly Case[] => HOSTILE_IDS.map(
    ([title, value, code]): Case => [`${key} is ${title}`, { ...triple(), [key]: value }, code],
  )),
  ["a 63-character digest", { ...triple(), revisionDigest: "a".repeat(63) }, INVALID],
  ["an uppercase digest", { ...triple(), revisionDigest: hex("f").toUpperCase() }, INVALID],
  ["a 65-character digest", { ...triple(), revisionDigest: "a".repeat(65) }, INVALID],
  ["a non-string digest", { ...triple(), revisionDigest: 42 }, INVALID],
  ["null", null, INVALID],
  ["an array", [], INVALID],
  ["a string", "x", INVALID],
  ["a full admitted revision", revisionOrThrow(), INVALID],
];

describe("bounded product contract revision ref admission", () => {
  it("admits exactly the identity triple of a real revision, deeply frozen", () => {
    const result = admitProductContractRevisionRef(triple());
    expect(result).toEqual({ ok: true, ref: triple() });
    expect(deeplyFrozen(result)).toBe(true);
    if (!result.ok) throw new Error("expected an admission");
    expect(Object.keys(result.ref).toSorted()).toEqual([...PRODUCT_CONTRACT_REVISION_REF_KEYS]);
  });

  it("publishes a frozen, sorted, three-key roster", () => {
    expect(Object.isFrozen(PRODUCT_CONTRACT_REVISION_REF_KEYS)).toBe(true);
    expect(PRODUCT_CONTRACT_REVISION_REF_KEYS.length).toBe(3);
    expect([...PRODUCT_CONTRACT_REVISION_REF_KEYS])
      .toEqual([...PRODUCT_CONTRACT_REVISION_REF_KEYS].toSorted());
  });

  // A sweep that silently generates zero cases passes. Pin the count as its sum.
  it("generates one hostile case per bounded refusal this admission owes", () => {
    expect(CASES.length).toBe(6 + 3 + 10 + 4 + 3 + 1);
  });

  it.each(CASES)("refuses %s", (_title, value, code) => {
    const result = admitProductContractRevisionRef(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect([result.code, result.layer]).toEqual([code, PROVENANCE]);
  });
});
