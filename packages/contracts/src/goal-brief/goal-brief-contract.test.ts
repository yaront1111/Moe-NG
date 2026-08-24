import { describe, expect, it } from "vitest";

import {
  GOAL_BRIEF_CONTRACT,
  GOAL_BRIEF_INPUT_INVALID,
  GOAL_BRIEF_LIMITS,
  admitGoalBrief,
} from "@moe/contracts";
import type {
  GoalBriefAccepted,
  GoalBriefRefused,
} from "@moe/contracts";

const encoder = new TextEncoder();

function accepted(input: unknown): GoalBriefAccepted {
  const result = admitGoalBrief(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected refusal: ${result.code}`);
  return result;
}

function expectInputRefusal(input: unknown): GoalBriefRefused {
  const result = admitGoalBrief(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected goal brief acceptance");
  expect(result).toStrictEqual({
    code: "GOAL_BRIEF_INPUT_INVALID",
    layer: "GOAL_BRIEF_CONTRACT",
    ok: false,
  });
  expect(result.code).toBe(GOAL_BRIEF_INPUT_INVALID);
  expect(result.layer).toBe(GOAL_BRIEF_CONTRACT);
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toHaveProperty("input");
  return result;
}

function accessorInput(): { readonly input: unknown; readonly reads: () => number } {
  let reads = 0;
  const input = { instructions: "safe" } as Record<string, unknown>;
  Object.defineProperty(input, "title", {
    enumerable: true,
    get: () => {
      reads += 1;
      return "do not read";
    },
  });
  return { input, reads: () => reads };
}

const revoked = Proxy.revocable({ title: "x", instructions: "y" }, {});
revoked.revoke();
const accessor = accessorInput();
const symbolKeyed = { title: "x", instructions: "y", [Symbol("hidden")]: true };

const HOSTILE_INPUTS: ReadonlyArray<readonly [string, unknown]> = Object.freeze([
  ["null", null],
  ["undefined", undefined],
  ["primitive string", "brief"],
  ["primitive number", 1],
  ["array", ["title", "instructions"]],
  ["date", new Date(0)],
  ["set", new Set()],
  ["revoked proxy", revoked.proxy],
  ["accessor property", accessor.input],
  ["symbol key", symbolKeyed],
  ["missing title", { instructions: "y" }],
  ["missing instructions", { title: "x" }],
  ["extra key", { title: "x", instructions: "y", authority: "FULL" }],
  ["non-string title", { title: 1, instructions: "y" }],
  ["non-string instructions", { title: "x", instructions: {} }],
  ["blank title", { title: " \r\n\t ", instructions: "y" }],
  ["blank instructions", { title: "x", instructions: " \r\n\t " }],
  ["ill-formed title", { title: "\ud800", instructions: "y" }],
  ["ill-formed instructions", { title: "x", instructions: "\udfff" }],
  ["over-limit title", { title: "a".repeat(1_025), instructions: "y" }],
  ["over-limit instructions", { title: "x", instructions: "a".repeat(32_769) }],
]);

describe("goal brief public contract", () => {
  it("publishes the exact frozen limits and stable refusal tuple", () => {
    expect(GOAL_BRIEF_LIMITS).toStrictEqual({
      maxInstructionsUtf8Bytes: 32 * 1_024,
      maxTitleUtf8Bytes: 1_024,
    });
    expect(Object.isFrozen(GOAL_BRIEF_LIMITS)).toBe(true);
    expect(GOAL_BRIEF_INPUT_INVALID).toBe("GOAL_BRIEF_INPUT_INVALID");
    expect(GOAL_BRIEF_CONTRACT).toBe("GOAL_BRIEF_CONTRACT");
  });

  it("normalizes multiline Unicode while preserving the normalized bytes", () => {
    const input = {
      title: "  Plan \ud83e\uddea\r\nnow  ",
      instructions: "  first\r\nsecond\rthird \ud83c\udf0d  ",
    };
    const result = accepted(input);
    const expected = {
      title: "Plan \ud83e\uddea\nnow",
      instructions: "first\nsecond\nthird \ud83c\udf0d",
    };

    expect(result.brief).toStrictEqual(expected);
    expect(encoder.encode(result.brief.title)).toStrictEqual(encoder.encode(expected.title));
    expect(encoder.encode(result.brief.instructions))
      .toStrictEqual(encoder.encode(expected.instructions));
  });

  it("returns detached frozen accepted values", () => {
    const input = { title: " title ", instructions: " instructions " };
    const result = accepted(input);
    input.title = "changed";
    input.instructions = "changed";

    expect(result.brief).toStrictEqual({ title: "title", instructions: "instructions" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.brief)).toBe(true);
    expect(result.brief).not.toBe(input);
  });

  it("measures the title boundary in normalized UTF-8 bytes", () => {
    const atLimit = "\u00e9".repeat(512);
    expect(encoder.encode(atLimit)).toHaveLength(GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes);
    expect(accepted({ title: atLimit, instructions: "y" }).brief.title).toBe(atLimit);
    expectInputRefusal({ title: `${atLimit}a`, instructions: "y" });
  });

  it("normalizes before measuring the UTF-8 byte limit", () => {
    const normalized = `${"a".repeat(512)}\n${"b".repeat(511)}`;
    const source = `  ${"a".repeat(512)}\r\n${"b".repeat(511)}  `;
    expect(encoder.encode(source).byteLength).toBeGreaterThan(
      GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes,
    );
    expect(accepted({ title: source, instructions: "y" }).brief.title).toBe(normalized);
  });

  it("measures the instructions boundary in normalized UTF-8 bytes", () => {
    const atLimit = "\ud83e\uddea".repeat(8_192);
    expect(encoder.encode(atLimit)).toHaveLength(GOAL_BRIEF_LIMITS.maxInstructionsUtf8Bytes);
    expect(accepted({ title: "x", instructions: atLimit }).brief.instructions).toBe(atLimit);
    expectInputRefusal({ title: "x", instructions: `${atLimit}a` });
  });

  it("generates a nonzero hostile input table", () => {
    expect(HOSTILE_INPUTS).toHaveLength(21);
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
});
