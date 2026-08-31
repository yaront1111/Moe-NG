import { createHash } from "node:crypto";
import { MAX_JSON_DEPTH, MAX_JSON_STRING_UTF8_BYTES } from "@moe/contracts";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_CONTRACT_CODES, ACCEPTANCE_CONTRACT_EVIDENCE_KINDS, ACCEPTANCE_CONTRACT_LAYERS, ACCEPTANCE_CONTRACT_LIMITS, ACCEPTANCE_CONTRACT_NODE_KINDS, ACCEPTANCE_CONTRACT_VERSION } from "./acceptance-contract.js";
import { ACCEPTANCE_CONTRACT_DIGEST_DOMAIN, createAcceptanceContract, decodeAcceptanceContractBytes, deriveAcceptanceContractDigest, encodeAcceptanceContract } from "./acceptance-contract-codec.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (digit: string): string => digit.repeat(64);
const ids = (prefix: string, count: number): string[] => Array.from(
  { length: count }, (_, index) => `${prefix}-${String(index).padStart(5, "0")}`,
);
const requirement = (index = 0) => ({
  evidenceRef: `evidence-${String(index).padStart(5, "0")}`, kind: "ARTIFACT",
  requirementId: `requirement-${String(index).padStart(5, "0")}`,
});
const obligation = (index = 0, recipes = 1, evidence = 1, statement = "Criterion holds.") => ({
  criterionId: `criterion-${String(index).padStart(5, "0")}`,
  evidenceRequirements: Array.from({ length: evidence }, (_, item) => requirement(item)),
  statement, verificationRecipeRefs: ids("recipe", recipes),
});
const baseDraft = () => ({
  applicability: { graphContentHash: hex("a"), graphRevisionRef: "graph-revision-a",
    nodeIds: ["node-a", "node-b"], nodeKind: "LEAF" },
  authorRef: "principal-a", contractId: "contract-a",
  obligations: [{ criterionId: "criterion-a",
    evidenceRequirements: [
      { evidenceRef: "artifact-a", kind: "ARTIFACT", requirementId: "requirement-a" },
      { evidenceRef: "receipt-a", kind: "VERIFICATION_RECEIPT", requirementId: "requirement-b" },
    ], statement: "The build passes its focused verification.",
    verificationRecipeRefs: ["recipe-a", "recipe-b"] }],
});
type Draft = ReturnType<typeof baseDraft>;
const changed = (change: (draft: Draft) => void): Draft => { const draft = baseDraft(); change(draft); return draft; };
function createdOrThrow(draft: unknown = baseDraft()) {
  const result = createAcceptanceContract(draft);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.contract;
}
function encodedOrThrow(contract: unknown = createdOrThrow()): Uint8Array {
  const result = encodeAcceptanceContract(contract);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.bytes;
}
function refusal(result: { readonly code?: string; readonly layer?: string; readonly ok: boolean }) {
  expect(result.ok).toBe(false); if (result.ok) throw new Error("expected refusal");
  return [result.code, result.layer];
}
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(
    (key) => deeplyFrozen((value as Readonly<Record<PropertyKey, unknown>>)[key]),
  );
}
describe("acceptance contract vocabulary", () => {
  it("pins the closed version, vocabularies, codes, layers and limits", () => {
    expect(ACCEPTANCE_CONTRACT_VERSION).toBe("moe-acceptance-contract/1");
    expect(ACCEPTANCE_CONTRACT_NODE_KINDS).toEqual([
      "LEAF", "INTEGRATION", "GLOBAL_VERIFICATION", "FINAL_REVIEW", "COMPOSITE_COMPLETION",
    ]);
    expect(ACCEPTANCE_CONTRACT_EVIDENCE_KINDS).toEqual([
      "VERIFICATION_RECEIPT", "ARTIFACT", "INTEGRATION", "REVIEW", "APPROVAL", "WITNESS",
    ]);
    expect(ACCEPTANCE_CONTRACT_CODES).toEqual([
      "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED",
      "ACCEPTANCE_CONTRACT_EMPTY_OBLIGATIONS", "ACCEPTANCE_CONTRACT_CRITERION_CONTENT_REQUIRED",
      "ACCEPTANCE_CONTRACT_DUPLICATE_ID", "ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED",
      "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_DUPLICATE_KEY",
      "ACCEPTANCE_CONTRACT_NONCANONICAL", "ACCEPTANCE_CONTRACT_DIGEST_MISMATCH",
    ]);
    expect(ACCEPTANCE_CONTRACT_LAYERS).toEqual([
      "ACCEPTANCE_CONTRACT_ADMISSION", "ACCEPTANCE_CONTRACT_VERSION", "ACCEPTANCE_CONTRACT_LIMITS",
      "ACCEPTANCE_CONTRACT_CODEC", "ACCEPTANCE_CONTRACT_CANONICALIZATION", "ACCEPTANCE_CONTRACT_DIGEST",
    ]);
    expect(ACCEPTANCE_CONTRACT_LIMITS).toEqual({ maxAggregateEntries: 20_000,
      maxBytes: 1_048_576, maxCriterionBytes: 32_768, maxEvidenceRequirementsPerObligation: 64,
      maxIdBytes: 512, maxNodeIds: 512, maxObligations: 1_024,
      maxRecipeRefsPerObligation: 64 });
  });
});
describe("nonempty canonical acceptance control", () => {
  it("derives its digest, detaches, freezes, preserves order and round-trips", () => {
    const draft = baseDraft(); const contract = createdOrThrow(draft); const stable = structuredClone(contract);
    expect(deriveAcceptanceContractDigest(contract)).toEqual({ criteriaDigest: contract.criteriaDigest, ok: true });
    expect(contract.applicability.nodeIds).toEqual(["node-a", "node-b"]);
    expect(contract.obligations[0]!.verificationRecipeRefs).toEqual(["recipe-a", "recipe-b"]);
    expect(contract.obligations[0]!.evidenceRequirements.map((item) => item.requirementId))
      .toEqual(["requirement-a", "requirement-b"]);
    const bytes = encodedOrThrow(contract); const projection = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    delete projection["criteriaDigest"];
    expect(contract.criteriaDigest).toBe(createHash("sha256").update(ACCEPTANCE_CONTRACT_DIGEST_DOMAIN, "utf8")
      .update(Uint8Array.of(0)).update(encoder.encode(JSON.stringify(projection))).digest("hex"));
    draft.applicability.nodeIds.push("node-z"); draft.obligations[0]!.statement = "caller mutation";
    draft.obligations[0]!.evidenceRequirements[0]!.evidenceRef = "caller-mutation";
    expect(contract).toEqual(stable); expect(deeplyFrozen(contract)).toBe(true);
    const source = encodedOrThrow(contract); const decoded = decodeAcceptanceContractBytes(source);
    expect(decoded).toEqual({ contract, ok: true }); source.fill(0x20); expect(decoded).toEqual({ contract, ok: true });
    if (!decoded.ok) throw new Error("expected decode");
    expect(Array.from(encodedOrThrow(decoded.contract))).toEqual(Array.from(bytes));
    expect(decoder.decode(bytes)).not.toMatch(/"(?:argv|command|effect|environment)"/u);
  });
  it("accepts every exact local N boundary and proves generated cardinalities", () => {
    const idN = "é".repeat(ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes / 2);
    const criterionN = "é".repeat(ACCEPTANCE_CONTRACT_LIMITS.maxCriterionBytes / 2);
    const aggregate = aggregateDraft(false);
    expect([encoder.encode(idN).byteLength, encoder.encode(criterionN).byteLength, aggregateCount(aggregate)])
      .toEqual([ACCEPTANCE_CONTRACT_LIMITS.maxIdBytes, ACCEPTANCE_CONTRACT_LIMITS.maxCriterionBytes, 20_000]);
    const cases: readonly (readonly [string, unknown])[] = [
      ["nodes", changed((d) => { d.applicability.nodeIds = ids("node", 512); })],
      ["obligations", changed((d) => { d.obligations = Array.from({ length: 1_024 }, (_, i) => obligation(i)); })],
      ["recipes", changed((d) => { d.obligations[0]!.verificationRecipeRefs = ids("recipe", 64); })],
      ["evidence", changed((d) => { d.obligations[0]!.evidenceRequirements = Array.from({ length: 64 }, (_, i) => requirement(i)); })],
      ["id-bytes", { ...baseDraft(), authorRef: idN }], ["criterion-bytes", changed((d) => { d.obligations[0]!.statement = criterionN; })],
      ["aggregate", aggregate],
    ];
    expect(cases.map(([name]) => name)).toEqual(["nodes", "obligations", "recipes", "evidence", "id-bytes", "criterion-bytes", "aggregate"]);
    for (const [_name, draft] of cases) expect(createAcceptanceContract(draft).ok).toBe(true);
  });
  it("decodes Buffer and typed-array subclasses without consulting Symbol.species", () => {
    class SpeciesTrap extends Uint8Array { static get [Symbol.species](): Uint8ArrayConstructor { throw new Error("species read"); } }
    for (const bytes of [Buffer.from(encodedOrThrow()), new SpeciesTrap(encodedOrThrow())]) {
      expect(decodeAcceptanceContractBytes(bytes)).toEqual({ contract: createdOrThrow(), ok: true });
    }
  });
});
type Hostile = readonly [string, () => { readonly ok: boolean }, string, string];
const hostile = (name: string, run: Hostile[1], code: string, layer: string): Hostile => [name, run, code, layer];
const malformed = (name: string, value: () => unknown): Hostile => hostile(name,
  () => createAcceptanceContract(value()), "ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION");
const limited = (name: string, run: Hostile[1]): Hostile => hostile(name, run,
  "ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED", "ACCEPTANCE_CONTRACT_LIMITS");
const duplicated = (name: string, run: Hostile[1]): Hostile => hostile(name, run,
  "ACCEPTANCE_CONTRACT_DUPLICATE_ID", "ACCEPTANCE_CONTRACT_LIMITS");
const content = (name: string, value: () => unknown): Hostile => hostile(name,
  () => createAcceptanceContract(value()), "ACCEPTANCE_CONTRACT_CRITERION_CONTENT_REQUIRED", "ACCEPTANCE_CONTRACT_ADMISSION");
const full = (draft: unknown) => ({ ...(draft as Readonly<Record<string, unknown>>), criteriaDigest: hex("0"), version: ACCEPTANCE_CONTRACT_VERSION });
const overWireDraft = (): Draft => changed((d) => { d.obligations = Array.from(
  { length: 33 }, (_, i) => obligation(i, 1, 1, "x".repeat(32_768)),
); });
function aggregateDraft(extra: boolean): Draft {
  return changed((d) => { d.applicability.nodeIds = ["node-a"]; d.obligations = Array.from(
    { length: 156 }, (_, i) => obligation(i, i < 155 ? 64 : 2, i < 155 ? 64 : extra ? 2 : 1),
  ); });
}
const aggregateCount = (draft: Draft): number => draft.applicability.nodeIds.length
  + draft.obligations.reduce((sum, item) => sum + 1 + item.verificationRecipeRefs.length + item.evidenceRequirements.length, 0);
const canonicalText = (): string => decoder.decode(encodedOrThrow());
const reorderedText = (): string => JSON.stringify(Object.fromEntries(
  Object.entries(JSON.parse(canonicalText()) as Record<string, unknown>).reverse(),
));
const bytes = (text: string): Uint8Array => encoder.encode(text);
const nested = (depth: number): Uint8Array => bytes(`${"[".repeat(depth)}null${"]".repeat(depth)}`);
const opaque = (): unknown => changed((d) => { const item = d.obligations[0]! as unknown as Record<string, unknown>;
  delete item["statement"]; item["criteriaRef"] = "criteria-ref-a"; });
const HOSTILES: readonly Hostile[] = [
  malformed("null", () => null), malformed("missing", () => { const { authorRef: _x, ...rest } = baseDraft(); return rest; }),
  malformed("extra", () => ({ ...baseDraft(), command: "run" })), malformed("caller-version", () => ({ ...baseDraft(), version: ACCEPTANCE_CONTRACT_VERSION })),
  malformed("caller-digest", () => ({ ...baseDraft(), criteriaDigest: hex("a") })), malformed("accessor", () => Object.defineProperty(baseDraft(), "authorRef", { enumerable: true, get: () => "forged" })),
  malformed("symbol", () => Object.defineProperty(baseDraft(), Symbol("x"), { enumerable: true, value: "x" })), malformed("proxy", () => new Proxy(baseDraft(), {})),
  malformed("revoked-proxy", () => { const p = Proxy.revocable(baseDraft(), {}); p.revoke(); return p.proxy; }), malformed("cyclic", () => changed((d) => { (d.obligations[0] as { statement: unknown }).statement = d; })),
  malformed("array-exotic", () => changed((d) => { Object.setPrototypeOf(d.obligations, Object.create(Array.prototype)); })), malformed("sparse", () => changed((d) => { d.obligations = Array<unknown>(1) as typeof d.obligations; })),
  malformed("node-kind-vocabulary", () => changed((d) => { d.applicability.nodeKind = "EXECUTION"; })), malformed("mixed-node-kinds", () => changed((d) => { d.applicability.nodeKind = ["LEAF", "FINAL_REVIEW"] as unknown as string; })), malformed("evidence-kind-vocabulary", () => changed((d) => { d.obligations[0]!.evidenceRequirements[0]!.kind = "LOG"; })),
  malformed("empty-applicability", () => ({ ...baseDraft(), applicability: {} })), malformed("empty-node-ids", () => changed((d) => { d.applicability.nodeIds = []; })),
  malformed("empty-recipes", () => changed((d) => { d.obligations[0]!.verificationRecipeRefs = []; })), malformed("empty-evidence", () => changed((d) => { d.obligations[0]!.evidenceRequirements = []; })),
  malformed("unsorted-nodes", () => changed((d) => { d.applicability.nodeIds = ["node-b", "node-a"]; })), malformed("unsorted-obligations", () => changed((d) => { d.obligations = [obligation(1), obligation(0)]; })),
  malformed("unsorted-recipes", () => changed((d) => { d.obligations[0]!.verificationRecipeRefs = ["recipe-b", "recipe-a"]; })), malformed("unsorted-requirements", () => changed((d) => { d.obligations[0]!.evidenceRequirements = [requirement(1), requirement(0)]; })),
  malformed("invalid-nfc", () => changed((d) => { d.obligations[0]!.statement = "e\u0301"; })), malformed("text-nul", () => changed((d) => { d.obligations[0]!.statement = "bad\0text"; })),
  malformed("text-surrogate", () => changed((d) => { d.obligations[0]!.statement = "\ud800"; })), malformed("invalid-ref", () => ({ ...baseDraft(), authorRef: "" })),
  malformed("invalid-hash", () => changed((d) => { d.applicability.graphContentHash = "BAD"; })), content("opaque-criteria-ref", opaque),
  content("empty-statement", () => changed((d) => { d.obligations[0]!.statement = ""; })), hostile("empty-obligations", () => createAcceptanceContract({ ...baseDraft(), obligations: [] }), "ACCEPTANCE_CONTRACT_EMPTY_OBLIGATIONS", "ACCEPTANCE_CONTRACT_LIMITS"),
  duplicated("duplicate-node", () => createAcceptanceContract(changed((d) => { d.applicability.nodeIds = ["node-a", "node-a"]; }))), duplicated("duplicate-criterion", () => createAcceptanceContract(changed((d) => { d.obligations = [obligation(0), obligation(0)]; }))),
  duplicated("duplicate-recipe", () => createAcceptanceContract(changed((d) => { d.obligations[0]!.verificationRecipeRefs = ["recipe-a", "recipe-a"]; }))), duplicated("duplicate-requirement", () => createAcceptanceContract(changed((d) => { d.obligations[0]!.evidenceRequirements = [requirement(0), requirement(0)]; }))),
  limited("node-limit", () => createAcceptanceContract(changed((d) => { d.applicability.nodeIds = ids("node", 513); }))), limited("obligations-limit", () => createAcceptanceContract(changed((d) => { d.obligations = Array.from({ length: 1_025 }, (_, i) => obligation(i)); }))),
  limited("recipe-limit", () => createAcceptanceContract(changed((d) => { d.obligations[0]!.verificationRecipeRefs = ids("recipe", 65); }))), limited("evidence-limit", () => createAcceptanceContract(changed((d) => { d.obligations[0]!.evidenceRequirements = Array.from({ length: 65 }, (_, i) => requirement(i)); }))),
  limited("aggregate-limit", () => createAcceptanceContract(aggregateDraft(true))), limited("id-byte-limit", () => createAcceptanceContract({ ...baseDraft(), authorRef: `${"é".repeat(256)}a` })),
  limited("criterion-byte-limit", () => createAcceptanceContract(changed((d) => { d.obligations[0]!.statement = `${"é".repeat(16_384)}a`; }))), limited("wire-limit-create", () => createAcceptanceContract(overWireDraft())),
  limited("wire-limit-digest", () => deriveAcceptanceContractDigest(full(overWireDraft()))), limited("wire-limit-encode", () => encodeAcceptanceContract(full(overWireDraft()))),
  limited("body-limit", () => decodeAcceptanceContractBytes(new Uint8Array(1_048_577))), limited("json-depth-limit", () => decodeAcceptanceContractBytes(nested(MAX_JSON_DEPTH + 1))),
  limited("json-string-limit", () => decodeAcceptanceContractBytes(bytes(JSON.stringify("x".repeat(MAX_JSON_STRING_UTF8_BYTES + 1))))),
  hostile("bytes-not-typed", () => decodeAcceptanceContractBytes("{}"), "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("bytes-proxy", () => decodeAcceptanceContractBytes(new Proxy(encodedOrThrow(), {})), "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("bytes-shared", () => decodeAcceptanceContractBytes(new Uint8Array(new SharedArrayBuffer(8))), "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("bytes-detached", () => { const b = encodedOrThrow(); structuredClone(b.buffer, { transfer: [b.buffer as ArrayBuffer] }); return decodeAcceptanceContractBytes(b); }, "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("bad-utf8", () => decodeAcceptanceContractBytes(Uint8Array.of(0xc3, 0x28)), "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("bad-json", () => decodeAcceptanceContractBytes(bytes("{")), "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("bad-number", () => decodeAcceptanceContractBytes(bytes("1e309")), "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("bad-unicode", () => decodeAcceptanceContractBytes(bytes('"\\ud800"')), "ACCEPTANCE_CONTRACT_BYTES_INVALID", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("duplicate-key", () => decodeAcceptanceContractBytes(bytes(canonicalText().replace('"contractId":', '"contractId":"shadow","contractId":'))), "ACCEPTANCE_CONTRACT_DUPLICATE_KEY", "ACCEPTANCE_CONTRACT_CODEC"),
  hostile("whitespace", () => decodeAcceptanceContractBytes(bytes(canonicalText().replace("{", "{ "))), "ACCEPTANCE_CONTRACT_NONCANONICAL", "ACCEPTANCE_CONTRACT_CANONICALIZATION"),
  hostile("key-order", () => decodeAcceptanceContractBytes(bytes(reorderedText())), "ACCEPTANCE_CONTRACT_NONCANONICAL", "ACCEPTANCE_CONTRACT_CANONICALIZATION"),
  hostile("version", () => encodeAcceptanceContract({ ...createdOrThrow(), version: "moe-acceptance-contract/2" }), "ACCEPTANCE_CONTRACT_VERSION_UNSUPPORTED", "ACCEPTANCE_CONTRACT_VERSION"),
  hostile("digest", () => encodeAcceptanceContract({ ...createdOrThrow(), criteriaDigest: hex("f") }), "ACCEPTANCE_CONTRACT_DIGEST_MISMATCH", "ACCEPTANCE_CONTRACT_DIGEST"),
];
describe("hostile admission and codec refusals", () => {
  it("runs the exact nonempty hostile roster and N decoder controls", () => {
    expect(HOSTILES.map(([name]) => name)).toEqual([
      "null", "missing", "extra", "caller-version", "caller-digest", "accessor", "symbol", "proxy", "revoked-proxy", "cyclic", "array-exotic", "sparse",
      "node-kind-vocabulary", "mixed-node-kinds", "evidence-kind-vocabulary", "empty-applicability", "empty-node-ids", "empty-recipes", "empty-evidence", "unsorted-nodes", "unsorted-obligations", "unsorted-recipes", "unsorted-requirements", "invalid-nfc", "text-nul", "text-surrogate", "invalid-ref", "invalid-hash", "opaque-criteria-ref", "empty-statement", "empty-obligations",
      "duplicate-node", "duplicate-criterion", "duplicate-recipe", "duplicate-requirement", "node-limit", "obligations-limit", "recipe-limit", "evidence-limit", "aggregate-limit", "id-byte-limit", "criterion-byte-limit", "wire-limit-create", "wire-limit-digest", "wire-limit-encode", "body-limit", "json-depth-limit", "json-string-limit", "bytes-not-typed", "bytes-proxy", "bytes-shared", "bytes-detached", "bad-utf8", "bad-json", "bad-number", "bad-unicode", "duplicate-key", "whitespace", "key-order", "version", "digest",
    ]);
    expect(HOSTILES.length).toBe(61); expect(new Set(HOSTILES.map(([name]) => name)).size).toBe(61);
    const exactBody = bytes(`{${" ".repeat(ACCEPTANCE_CONTRACT_LIMITS.maxBytes - 2)}}`);
    expect(exactBody.byteLength).toBe(ACCEPTANCE_CONTRACT_LIMITS.maxBytes);
    expect(refusal(decodeAcceptanceContractBytes(exactBody))).toEqual(["ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION"]);
    expect(refusal(decodeAcceptanceContractBytes(nested(MAX_JSON_DEPTH)))).toEqual(["ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION"]);
    expect(refusal(decodeAcceptanceContractBytes(bytes(JSON.stringify("x".repeat(MAX_JSON_STRING_UTF8_BYTES)))))).toEqual(["ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION"]);
  });
  it.each(HOSTILES)("pins %s", (_name, run, code, layer) => { expect(refusal(run())).toEqual([code, layer]); });
  it("rejects an accessor without executing its getter", () => {
    let hits = 0; const input = Object.defineProperty(baseDraft(), "authorRef", { enumerable: true,
      get: () => { hits += 1; return "forged"; } });
    expect(refusal(createAcceptanceContract(input))).toEqual(["ACCEPTANCE_CONTRACT_MALFORMED", "ACCEPTANCE_CONTRACT_ADMISSION"]);
    expect(hits).toBe(0);
  });
});
const MUTATIONS: readonly (readonly [string, (draft: Draft) => void])[] = [
  ["contractId", (d) => { d.contractId = "contract-b"; }], ["authorRef", (d) => { d.authorRef = "principal-b"; }],
  ["applicability.graphRevisionRef", (d) => { d.applicability.graphRevisionRef = "graph-revision-b"; }], ["applicability.graphContentHash", (d) => { d.applicability.graphContentHash = hex("b"); }],
  ["applicability.nodeKind", (d) => { d.applicability.nodeKind = "INTEGRATION"; }], ["applicability.nodeIds", (d) => { d.applicability.nodeIds.push("node-c"); }],
  ["obligations.criterionId", (d) => { d.obligations[0]!.criterionId = "criterion-b"; }], ["obligations.statement", (d) => { d.obligations[0]!.statement = "A different criterion holds."; }],
  ["obligations.verificationRecipeRefs", (d) => { d.obligations[0]!.verificationRecipeRefs.push("recipe-c"); }],
  ["obligations.evidenceRequirements.requirementId", (d) => { d.obligations[0]!.evidenceRequirements[0]!.requirementId = "requirement-0"; }],
  ["obligations.evidenceRequirements.kind", (d) => { d.obligations[0]!.evidenceRequirements[0]!.kind = "WITNESS"; }],
  ["obligations.evidenceRequirements.evidenceRef", (d) => { d.obligations[0]!.evidenceRequirements[0]!.evidenceRef = "artifact-b"; }],
];
describe("authoritative-field digest sweep", () => {
  it("pins every draft field and nested field by name", () => {
    expect(MUTATIONS.map(([name]) => name)).toEqual([
      "contractId", "authorRef", "applicability.graphRevisionRef", "applicability.graphContentHash", "applicability.nodeKind", "applicability.nodeIds",
      "obligations.criterionId", "obligations.statement", "obligations.verificationRecipeRefs", "obligations.evidenceRequirements.requirementId", "obligations.evidenceRequirements.kind", "obligations.evidenceRequirements.evidenceRef",
    ]);
    expect(MUTATIONS.length).toBe(12); expect(new Set(MUTATIONS.map(([name]) => name)).size).toBe(12);
  });
  it.each(MUTATIONS)("binds %s", (_name, change) => {
    const baseline = createdOrThrow(); const draft = baseDraft(); change(draft); const mutated = createdOrThrow(draft);
    expect(mutated.criteriaDigest).not.toBe(baseline.criteriaDigest);
    expect(refusal(encodeAcceptanceContract({ ...mutated, criteriaDigest: baseline.criteriaDigest })))
      .toEqual(["ACCEPTANCE_CONTRACT_DIGEST_MISMATCH", "ACCEPTANCE_CONTRACT_DIGEST"]);
    const forged = decoder.decode(encodedOrThrow(mutated)).replace(mutated.criteriaDigest, baseline.criteriaDigest);
    expect(refusal(decodeAcceptanceContractBytes(bytes(forged))))
      .toEqual(["ACCEPTANCE_CONTRACT_DIGEST_MISMATCH", "ACCEPTANCE_CONTRACT_DIGEST"]);
  });
});
