import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GOAL_SOURCE_CONTRACT,
  GOAL_SOURCE_INPUT_INVALID,
  GOAL_SOURCE_LIMITS,
  GOAL_SOURCE_MEDIA_TYPES,
  admitGoalSource,
} from "@moe/contracts";
import type {
  GoalSourceAccepted,
  GoalSourceRefused,
} from "@moe/contracts";

const encoder = new TextEncoder();
const daemonContractPath = fileURLToPath(new URL(
  "../../../../apps/daemon/src/documents/document-source-contract.ts",
  import.meta.url,
));
const controlRoomPrdPath = fileURLToPath(new URL(
  "../../../../apps/control-room/src/v2/goals/use-goal-prd.ts",
  import.meta.url,
));

function accepted(input: unknown): GoalSourceAccepted {
  const result = admitGoalSource(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected refusal: ${result.code}`);
  return result;
}

function expectInputRefusal(input: unknown): GoalSourceRefused {
  const result = admitGoalSource(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected goal source acceptance");
  expect(result).toStrictEqual({
    code: "GOAL_SOURCE_INPUT_INVALID",
    layer: "GOAL_SOURCE_CONTRACT",
    ok: false,
  });
  expect(result.code).toBe(GOAL_SOURCE_INPUT_INVALID);
  expect(result.layer).toBe(GOAL_SOURCE_CONTRACT);
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toHaveProperty("input");
  return result;
}

function accessorInput(): { readonly input: unknown; readonly reads: () => number } {
  let reads = 0;
  const input = {
    displayPath: "prd.md",
    mediaType: "text/plain",
  } as Record<string, unknown>;
  Object.defineProperty(input, "text", {
    enumerable: true,
    get: () => {
      reads += 1;
      return "do not read";
    },
  });
  return { input, reads: () => reads };
}

function capturedDeclaration(
  source: string,
  name: string,
  declarationBody: string,
): string {
  const pattern = new RegExp(
    `^[\\t ]*export[\\t ]+const[\\t ]+${name}[\\t ]*=[\\t ]*${declarationBody}`,
    "gmu",
  );
  const matches = [...source.matchAll(pattern)];
  expect(matches, `${name} declaration count`).toHaveLength(1);
  const captured = matches[0]?.[1];
  if (captured === undefined) throw new Error(`${name} declaration did not capture a value`);
  return captured;
}

function frozenStringTuple(source: string, name: string): readonly string[] {
  const body = capturedDeclaration(
    source,
    name,
    String.raw`Object\.freeze\(\s*\[([\s\S]*?)\]\s*as\s+const\s*\)\s*;`,
  );
  const literalPattern = /"(?:\\.|[^"\\])*"/gu;
  const tokens = [...body.matchAll(literalPattern)].map((match) => match[0]);
  expect(tokens.length, `${name} parsed literal count`).toBeGreaterThan(0);
  expect(body.replace(literalPattern, "").replace(/[\s,]/gu, "")).toBe("");
  return tokens.map((token) => {
    const value: unknown = JSON.parse(token);
    if (typeof value !== "string") throw new Error(`${name} contains a non-string literal`);
    return value;
  });
}

function positiveNumericProduct(source: string, name: string): number {
  const expression = capturedDeclaration(
    source,
    name,
    String.raw`([^;\r\n]+)\s*;`,
  ).trim();
  const factors = expression.split("*").map((factor) => factor.trim());
  expect(factors.length, `${name} factor count`).toBeGreaterThan(0);
  expect(factors.every((factor) => /^\d(?:_?\d)*$/u.test(factor))).toBe(true);
  if (factors.some((factor) => !/^\d(?:_?\d)*$/u.test(factor))) {
    throw new Error(`${name} is not a numeric product: ${expression}`);
  }
  const value = factors
    .map((factor) => Number(factor.replaceAll("_", "")))
    .reduce((product, factor) => product * factor, 1);
  expect(Number.isSafeInteger(value), `${name} safe integer`).toBe(true);
  expect(value, `${name} positive value`).toBeGreaterThan(0);
  return value;
}

const revoked = Proxy.revocable({}, {});
revoked.revoke();
const accessor = accessorInput();
const symbolKeyed = {
  displayPath: "prd.md",
  mediaType: "text/plain",
  text: "safe",
  [Symbol("authority")]: "FULL",
};
const HOSTILE_INPUTS: ReadonlyArray<readonly [string, unknown]> = Object.freeze([
  ["null", null],
  ["undefined", undefined],
  ["primitive string", "source"],
  ["primitive number", 1],
  ["array", ["prd.md", "text/plain", "safe"]],
  ["date", new Date(0)],
  ["set", new Set()],
  ["revoked proxy", revoked.proxy],
  ["accessor property", accessor.input],
  ["symbol key", symbolKeyed],
  ["missing displayPath", { mediaType: "text/plain", text: "safe" }],
  ["missing mediaType", { displayPath: "prd.md", text: "safe" }],
  ["missing text", { displayPath: "prd.md", mediaType: "text/plain" }],
  ["extra key", {
    authority: "FULL", displayPath: "prd.md", mediaType: "text/plain", text: "safe",
  }],
  ["non-string displayPath", { displayPath: 1, mediaType: "text/plain", text: "safe" }],
  ["non-string mediaType", { displayPath: "prd.md", mediaType: 1, text: "safe" }],
  ["non-string text", { displayPath: "prd.md", mediaType: "text/plain", text: {} }],
  ["empty displayPath", { displayPath: "", mediaType: "text/plain", text: "safe" }],
  ["empty text", { displayPath: "prd.md", mediaType: "text/plain", text: "" }],
  ["ill-formed displayPath", { displayPath: "\ud800", mediaType: "text/plain", text: "safe" }],
  ["ill-formed text", { displayPath: "prd.md", mediaType: "text/plain", text: "\udfff" }],
  ["unsupported mediaType", {
    displayPath: "prd.md", mediaType: "application/pdf", text: "safe",
  }],
  ["ASCII text above the byte bound", {
    displayPath: "prd.md",
    mediaType: "text/plain",
    text: "a".repeat(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes + 1),
  }],
]);

const MULTIBYTE_AT_LIMIT = "\u00e9".repeat(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes / 2);

describe("goal source public contract", () => {
  it("publishes the frozen contract vocabulary", () => {
    expect(Object.keys(GOAL_SOURCE_LIMITS)).toStrictEqual(["maxTextUtf8Bytes"]);
    expect(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes).toBeGreaterThan(0);
    expect(Object.isFrozen(GOAL_SOURCE_LIMITS)).toBe(true);
    expect(GOAL_SOURCE_MEDIA_TYPES.length).toBeGreaterThan(0);
    expect(new Set(GOAL_SOURCE_MEDIA_TYPES).size).toBe(GOAL_SOURCE_MEDIA_TYPES.length);
    expect(Object.isFrozen(GOAL_SOURCE_MEDIA_TYPES)).toBe(true);
    expect(GOAL_SOURCE_INPUT_INVALID).toBe("GOAL_SOURCE_INPUT_INVALID");
    expect(GOAL_SOURCE_CONTRACT).toBe("GOAL_SOURCE_CONTRACT");
  });

  it.each(GOAL_SOURCE_MEDIA_TYPES)("accepts the admitted media type: %s", (mediaType) => {
    const source = { displayPath: "prd.md", mediaType, text: "source" };
    expect(accepted(source).source).toStrictEqual(source);
  });

  it("preserves selected source bytes in a detached frozen result", () => {
    const input = {
      displayPath: " docs/prd.md ",
      mediaType: "text/markdown",
      text: "  first\r\nsecond  ",
    };
    const expected = { ...input };
    const result = accepted(input);
    input.displayPath = "changed";
    input.mediaType = "changed";
    input.text = "changed";

    expect(result).toStrictEqual({ source: expected, ok: true });
    expect(Object.keys(result.source)).toStrictEqual(["displayPath", "mediaType", "text"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(result.source).not.toBe(input);
  });

  it("accepts text at the multi-byte UTF-8 boundary", () => {
    expect(encoder.encode(MULTIBYTE_AT_LIMIT)).toHaveLength(
      GOAL_SOURCE_LIMITS.maxTextUtf8Bytes,
    );
    expect(accepted({
      displayPath: "prd.md", mediaType: "text/plain", text: MULTIBYTE_AT_LIMIT,
    }).source.text).toBe(MULTIBYTE_AT_LIMIT);
  });

  it("refuses one byte above the multi-byte UTF-8 boundary", () => {
    const overLimit = `${MULTIBYTE_AT_LIMIT}a`;
    expect(encoder.encode(overLimit)).toHaveLength(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes + 1);
    expectInputRefusal({ displayPath: "prd.md", mediaType: "text/plain", text: overLimit });
  });

  it("generates every hostile input case", () => {
    expect(HOSTILE_INPUTS).toHaveLength(23);
    expect(HOSTILE_INPUTS.length).toBeGreaterThan(0);
  });

  it.each(HOSTILE_INPUTS)("refuses hostile input: %s", (_name, input) => {
    expectInputRefusal(input);
  });

  it("does not invoke hostile accessors and reuses an input-free refusal", () => {
    expect(accessor.reads()).toBe(0);
    expect(expectInputRefusal(accessor.input)).toBe(expectInputRefusal(null));
    expect(accessor.reads()).toBe(0);
  });

  it("stays in parity with the daemon media roster and both production byte bounds", async () => {
    const [daemonSource, controlRoomSource] = await Promise.all([
      readFile(daemonContractPath, "utf8"),
      readFile(controlRoomPrdPath, "utf8"),
    ]);
    expect(daemonSource.length).toBeGreaterThan(0);
    expect(controlRoomSource.length).toBeGreaterThan(0);

    const daemonMediaTypes = frozenStringTuple(daemonSource, "DOCUMENT_INGEST_MEDIA_TYPES");
    const daemonMediaSet = new Set(daemonMediaTypes);
    const contractMediaSet = new Set<string>(GOAL_SOURCE_MEDIA_TYPES);
    expect(daemonMediaSet.size).toBe(daemonMediaTypes.length);
    expect([...contractMediaSet].filter((value) => !daemonMediaSet.has(value))).toStrictEqual([]);
    expect([...daemonMediaSet].filter((value) => !contractMediaSet.has(value))).toStrictEqual([]);

    const daemonBound = positiveNumericProduct(
      daemonSource,
      "MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES",
    );
    const controlRoomBound = positiveNumericProduct(
      controlRoomSource,
      "PRD_FILE_PREFLIGHT_MAX_BYTES",
    );
    expect(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes).toBe(daemonBound);
    expect(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes).toBe(controlRoomBound);
  });
});
