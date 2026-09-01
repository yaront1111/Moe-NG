import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PRODUCT_CONTRACT_CODES, PRODUCT_CONTRACT_DIGEST_DOMAIN, PRODUCT_CONTRACT_LAYERS,
  PRODUCT_CONTRACT_VERSION, createProductContractRevision,
  decodeProductContractRevisionBytes, deriveProductContractRevisionDigest,
  encodeProductContractRevision,
} from "./product-contract-codec.js";
import { deeplyFrozen, hex, productContractDraft } from "./product-contract-test-fixtures.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const revisionOrThrow = (draft: unknown = productContractDraft()) => {
  const result = createProductContractRevision(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
};

const bytesOrThrow = (revision: unknown = revisionOrThrow()): Uint8Array => {
  const result = encodeProductContractRevision(revision);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.bytes;
};

const refusal = (result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
};

describe("product contract vocabulary", () => {
  it("pins the version, digest domain and stable refusal vocabularies", () => {
    expect(PRODUCT_CONTRACT_VERSION).toBe("moe-product-contract-revision/1");
    expect(PRODUCT_CONTRACT_DIGEST_DOMAIN).toBe("moe-product-contract-revision-digest/1");
    expect(PRODUCT_CONTRACT_LAYERS).toEqual([
      "PROVENANCE", "LINEAGE", "MATERIALITY", "GATE_1", "ACCEPTANCE_BINDING",
    ]);
    expect(PRODUCT_CONTRACT_CODES).toEqual([
      "PRODUCT_CONTRACT_PROVENANCE_INVALID", "PRODUCT_CONTRACT_PROVENANCE_VACUOUS",
      "PRODUCT_CONTRACT_VERSION_UNSUPPORTED", "PRODUCT_CONTRACT_LIMIT_EXCEEDED",
      "PRODUCT_CONTRACT_BYTES_INVALID", "PRODUCT_CONTRACT_DUPLICATE_KEY",
      "PRODUCT_CONTRACT_NONCANONICAL", "PRODUCT_CONTRACT_DIGEST_MISMATCH",
      "PRODUCT_CONTRACT_LINEAGE_PARENT_NOT_CURRENT", "PRODUCT_CONTRACT_LINEAGE_CONTRACT_MISMATCH",
      "PRODUCT_CONTRACT_LINEAGE_ID_REUSED", "PRODUCT_CONTRACT_LINEAGE_ID_UNSTABLE",
      "PRODUCT_CONTRACT_LINEAGE_CHANGE_UNDECLARED", "PRODUCT_CONTRACT_CLARIFICATION_INVALID",
      "PRODUCT_CONTRACT_CLARIFICATION_VACUOUS", "PRODUCT_CONTRACT_CLARIFICATION_IMMATERIAL",
      "PRODUCT_CONTRACT_GATE_1_REQUIRED", "PRODUCT_CONTRACT_GATE_1_BINDING_INVALID",
      "PRODUCT_CONTRACT_ACCEPTANCE_INVALID", "PRODUCT_CONTRACT_ACCEPTANCE_GRAPH_MISMATCH",
      "PRODUCT_CONTRACT_ACCEPTANCE_CRITERIA_MISMATCH",
      "PRODUCT_CONTRACT_ACCEPTANCE_REQUIREMENT_VACUOUS",
    ]);
    expect([Object.isFrozen(PRODUCT_CONTRACT_CODES), Object.isFrozen(PRODUCT_CONTRACT_LAYERS)])
      .toEqual([true, true]);
  });
});

describe("immutable canonical product contract revision", () => {
  it("derives a domain-separated digest, detaches, freezes and round-trips", () => {
    const draft = productContractDraft();
    const revision = revisionOrThrow(draft);
    const stable = structuredClone(revision);
    draft.requirements[0]!.statement = "caller mutation";
    draft.criteria[0]!.statement = "caller mutation";
    draft.sourceDocumentDigests[0] = hex("f");
    expect(revision).toEqual(stable);
    expect(deeplyFrozen(revision)).toBe(true);
    expect(revision.advisoryOnly).toBe(true);
    const encoded = bytesOrThrow(revision);
    const decoded = decodeProductContractRevisionBytes(encoded);
    expect(decoded).toEqual({ ok: true, revision });
    expect(Array.from(bytesOrThrow(decoded.ok ? decoded.revision : null))).toEqual(Array.from(encoded));
    const source = JSON.parse(decoder.decode(encoded)) as Record<string, unknown>;
    delete source["revisionDigest"];
    expect(revision.revisionDigest).toBe(createHash("sha256")
      .update(PRODUCT_CONTRACT_DIGEST_DOMAIN, "utf8").update(Uint8Array.of(0))
      .update(encoder.encode(JSON.stringify(source))).digest("hex"));
    expect(deriveProductContractRevisionDigest(revision))
      .toEqual({ ok: true, revisionDigest: revision.revisionDigest });
  });

  it("binds authoritative fields and rejects stale digests", () => {
    const baseline = revisionOrThrow();
    const changed = revisionOrThrow({
      ...productContractDraft(),
      requirements: [{
        ...productContractDraft().requirements[0], statement: "Registered users sign in securely.",
      }],
    });
    expect(changed.revisionDigest).not.toBe(baseline.revisionDigest);
    expect(refusal(encodeProductContractRevision({
      ...changed, revisionDigest: baseline.revisionDigest,
    }))).toEqual(["PRODUCT_CONTRACT_DIGEST_MISMATCH", "PROVENANCE"]);
  });

  it("refuses missing provenance and requirements without criteria", () => {
    expect(refusal(createProductContractRevision({
      ...productContractDraft(), sourceDocumentDigests: [],
    }))).toEqual(["PRODUCT_CONTRACT_PROVENANCE_VACUOUS", "PROVENANCE"]);
    expect(refusal(createProductContractRevision({
      ...productContractDraft(), criteria: [],
    }))).toEqual(["PRODUCT_CONTRACT_PROVENANCE_VACUOUS", "PROVENANCE"]);
    expect(refusal(createProductContractRevision({
      ...productContractDraft(),
      lineage: { parentRevisionDigest: hex("e"), parentRevisionId: "product-revision-0" },
      retiredCriterionIds: ["criterion-authentication"],
      retiredRequirementIds: ["requirement-authentication"],
    }))).toEqual(["PRODUCT_CONTRACT_PROVENANCE_INVALID", "PROVENANCE"]);
  });

  it("refuses malformed, duplicate-key, noncanonical and unsupported bytes at exact layers", () => {
    expect(refusal(createProductContractRevision({
      ...productContractDraft(), command: "execute",
    }))).toEqual(["PRODUCT_CONTRACT_PROVENANCE_INVALID", "PROVENANCE"]);
    const canonical = decoder.decode(bytesOrThrow());
    expect(refusal(decodeProductContractRevisionBytes(
      encoder.encode(canonical.replace('"revisionId":', '"revisionId":"shadow","revisionId":')),
    ))).toEqual(["PRODUCT_CONTRACT_DUPLICATE_KEY", "PROVENANCE"]);
    expect(refusal(decodeProductContractRevisionBytes(
      encoder.encode(canonical.replace("{", "{ ")),
    ))).toEqual(["PRODUCT_CONTRACT_NONCANONICAL", "PROVENANCE"]);
    expect(refusal(encodeProductContractRevision({
      ...revisionOrThrow(), version: "moe-product-contract-revision/2",
    }))).toEqual(["PRODUCT_CONTRACT_VERSION_UNSUPPORTED", "PROVENANCE"]);
  });
});
