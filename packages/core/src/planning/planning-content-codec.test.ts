import { describe, expect, it } from "vitest";

import {
  MAX_JSON_BODY_BYTES, MAX_JSON_DEPTH, MAX_JSON_STRING_UTF8_BYTES,
} from "@moe/contracts";

import * as acceptanceCodec from "./acceptance-contract-codec.js";
import * as planCodec from "./plan-revision-codec.js";

type CodecFunction = (...args: readonly unknown[]) => unknown;
type CodecResult = Readonly<Record<string, unknown>> & { readonly ok: boolean };

const planDraft = () => ({
  affectedCriterionIds: ["criterion-a", "criterion-b"],
  affectedNodeIds: ["node-a", "node-b"],
  steps: [
    { description: "Analyse the graph.", kind: "ANALYSIS", stepId: "step-a" },
    { description: "Implement the change.", kind: "IMPLEMENTATION", stepId: "step-b" },
  ],
  verificationRecipeRefs: ["verify-a", "verify-b"],
});

const obligation = (id: string, statement: string, kind: string) => ({
  criterionId: `criterion-${id}`,
  evidenceRequirements: [{
    evidenceRef: `evidence-${id}`, kind, requirementId: `requirement-${id}`,
  }],
  statement,
  verificationRecipeRefs: [`recipe-${id}`],
});

const acceptanceDraft = () => ({
  nodeKind: "LEAF",
  obligations: [
    obligation("a", "The focused suite passes.", "ARTIFACT"),
    obligation("b", "The repository typecheck passes.", "VERIFICATION_RECEIPT"),
  ],
});

function functionOf(surface: object, name: string): CodecFunction {
  const candidate = (surface as Readonly<Record<string, unknown>>)[name];
  expect(typeof candidate, `${name} must be exported`).toBe("function");
  return typeof candidate === "function" ? candidate as CodecFunction : () => undefined;
}

function accepted(result: unknown): CodecResult {
  expect(result).toMatchObject({ ok: true });
  return result as CodecResult;
}

function bytesOf(result: CodecResult): Uint8Array {
  expect(result["bytes"]).toBeInstanceOf(Uint8Array);
  return result["bytes"] as Uint8Array;
}

function withTrailingSpace(bytes: Uint8Array): Uint8Array {
  const changed = new Uint8Array(bytes.byteLength + 1);
  changed.set(bytes); changed[changed.length - 1] = 0x20;
  return changed;
}

function withDuplicateVersion(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const duplicate = text.replace('"version":', '"version":"duplicate","version":');
  expect(duplicate).not.toBe(text);
  return new TextEncoder().encode(duplicate);
}

const PLAN_GOLDEN = [
  '{"affectedCriterionIds":["criterion-a","criterion-b"],',
  '"affectedNodeIds":["node-a","node-b"],"steps":',
  '[{"description":"Analyse the graph.","kind":"ANALYSIS","stepId":"step-a"},',
  '{"description":"Implement the change.","kind":"IMPLEMENTATION","stepId":"step-b"}],',
  '"verificationRecipeRefs":["verify-a","verify-b"],"version":"moe-plan-revision/1"}',
].join("");
const ACCEPTANCE_GOLDEN = [
  '{"nodeKind":"LEAF","obligations":[{"criterionId":"criterion-a",',
  '"evidenceRequirements":[{"evidenceRef":"evidence-a","kind":"ARTIFACT",',
  '"requirementId":"requirement-a"}],"statement":"The focused suite passes.",',
  '"verificationRecipeRefs":["recipe-a"]},{"criterionId":"criterion-b",',
  '"evidenceRequirements":[{"evidenceRef":"evidence-b","kind":"VERIFICATION_RECEIPT",',
  '"requirementId":"requirement-b"}],"statement":"The repository typecheck passes.",',
  '"verificationRecipeRefs":["recipe-b"]}],"version":"moe-acceptance-contract/1"}',
].join("");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const reordered = (text: string): Uint8Array => utf8(JSON.stringify(Object.fromEntries(
  Object.entries(JSON.parse(text) as Record<string, unknown>).reverse(),
)));
const parserLimits = (): readonly Uint8Array[] => [
  new Uint8Array(MAX_JSON_BODY_BYTES + 1),
  utf8(`${"[".repeat(MAX_JSON_DEPTH + 1)}0${"]".repeat(MAX_JSON_DEPTH + 1)}`),
  utf8(JSON.stringify("x".repeat(MAX_JSON_STRING_UTF8_BYTES + 1))),
];

function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(
    (key) => deeplyFrozen((value as Readonly<Record<PropertyKey, unknown>>)[key]),
  );
}

describe("graph-independent planning content codecs", () => {
  it("round-trips canonical plan execution content and rederives its identity", () => {
    const created = planCodec.createPlanExecutionContent(planDraft());
    if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
    const encode = functionOf(planCodec, "encodePlanExecutionContent");
    const decode = functionOf(planCodec, "decodePlanExecutionContentBytes");

    const encoded = accepted(encode(created.content));
    const text = new TextDecoder().decode(bytesOf(encoded));
    expect(text).toBe(PLAN_GOLDEN);
    expect(text).not.toContain("planExecutionContentDigest");
    expect(JSON.parse(text)).toStrictEqual(created.content);
    const decoded = accepted(decode(bytesOf(encoded)));
    expect(decoded).toStrictEqual(created);
    expect(decoded["planExecutionContentDigest"])
      .toBe("e16e800a23348b17919e2af8c4ea5c5328b27a5195bdbf9cf03d468964dd3e23");
    expect(deeplyFrozen(decoded)).toBe(true);
  });

  it("refuses alternate spellings and invalid plan execution bytes exactly", () => {
    const created = planCodec.createPlanExecutionContent(planDraft());
    if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
    const encode = functionOf(planCodec, "encodePlanExecutionContent");
    const decode = functionOf(planCodec, "decodePlanExecutionContentBytes");
    const encoded = accepted(encode(created.content));

    expect(decode(withTrailingSpace(bytesOf(encoded)))).toStrictEqual({
      code: "PLAN_REVISION_NONCANONICAL",
      layer: "PLAN_REVISION_CANONICALIZATION",
      ok: false,
    });
    expect(decode(reordered(PLAN_GOLDEN))).toStrictEqual({
      code: "PLAN_REVISION_NONCANONICAL",
      layer: "PLAN_REVISION_CANONICALIZATION",
      ok: false,
    });
    expect(decode(new Uint8Array([0xff]))).toStrictEqual({
      code: "PLAN_REVISION_BYTES_INVALID", layer: "PLAN_REVISION_CODEC", ok: false,
    });
    expect(decode(withDuplicateVersion(bytesOf(encoded)))).toStrictEqual({
      code: "PLAN_REVISION_DUPLICATE_KEY", layer: "PLAN_REVISION_CODEC", ok: false,
    });
    expect(encode(planDraft())).toStrictEqual({
      code: "PLAN_REVISION_MALFORMED", layer: "PLAN_REVISION_ADMISSION", ok: false,
    });
    expect(decode(utf8(JSON.stringify(planDraft())))).toStrictEqual({
      code: "PLAN_REVISION_MALFORMED", layer: "PLAN_REVISION_ADMISSION", ok: false,
    });
    for (const bytes of parserLimits()) expect(decode(bytes)).toStrictEqual({
      code: "PLAN_REVISION_BYTES_INVALID", layer: "PLAN_REVISION_CODEC", ok: false,
    });
  });

  it("round-trips canonical acceptance criteria content and rederives its roster", () => {
    const created = acceptanceCodec.createAcceptanceCriterionContent(acceptanceDraft());
    if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
    const encode = functionOf(acceptanceCodec, "encodeAcceptanceCriteriaContent");
    const decode = functionOf(acceptanceCodec, "decodeAcceptanceCriteriaContentBytes");

    const encoded = accepted(encode(created.content));
    const text = new TextDecoder().decode(bytesOf(encoded));
    expect(text).toBe(ACCEPTANCE_GOLDEN);
    expect(text).not.toContain('"criteria"');
    expect(JSON.parse(text)).toStrictEqual(created.content);
    const decoded = accepted(decode(bytesOf(encoded)));
    expect(decoded).toStrictEqual(created);
    expect(decoded["criteria"]).toStrictEqual([
      { contentDigest: "5f19caae3b5c57d3f5551a2a49cbdb649bcdfd9fe53ab6e7a3c7254136d5e594",
        criterionId: "criterion-a" },
      { contentDigest: "1dbfed8481956d65d7b8abc1e9b5f51589861c5d8f7bda9c3579a137b4d5cb9e",
        criterionId: "criterion-b" },
    ]);
    expect(deeplyFrozen(decoded)).toBe(true);
  });

  it("refuses alternate spellings and invalid acceptance criteria bytes exactly", () => {
    const created = acceptanceCodec.createAcceptanceCriterionContent(acceptanceDraft());
    if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
    const encode = functionOf(acceptanceCodec, "encodeAcceptanceCriteriaContent");
    const decode = functionOf(acceptanceCodec, "decodeAcceptanceCriteriaContentBytes");
    const encoded = accepted(encode(created.content));

    expect(decode(withTrailingSpace(bytesOf(encoded)))).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_NONCANONICAL",
      layer: "ACCEPTANCE_CONTRACT_CANONICALIZATION",
      ok: false,
    });
    expect(decode(reordered(ACCEPTANCE_GOLDEN))).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_NONCANONICAL",
      layer: "ACCEPTANCE_CONTRACT_CANONICALIZATION",
      ok: false,
    });
    expect(decode(new Uint8Array([0xff]))).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_BYTES_INVALID",
      layer: "ACCEPTANCE_CONTRACT_CODEC",
      ok: false,
    });
    expect(decode(withDuplicateVersion(bytesOf(encoded)))).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_DUPLICATE_KEY",
      layer: "ACCEPTANCE_CONTRACT_CODEC",
      ok: false,
    });
    expect(encode(acceptanceDraft())).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_MALFORMED",
      layer: "ACCEPTANCE_CONTRACT_ADMISSION",
      ok: false,
    });
    expect(decode(utf8(JSON.stringify(acceptanceDraft())))).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_MALFORMED",
      layer: "ACCEPTANCE_CONTRACT_ADMISSION",
      ok: false,
    });
    for (const bytes of parserLimits()) expect(decode(bytes)).toStrictEqual({
      code: "ACCEPTANCE_CONTRACT_LIMIT_EXCEEDED",
      layer: "ACCEPTANCE_CONTRACT_LIMITS",
      ok: false,
    });
  });

});
