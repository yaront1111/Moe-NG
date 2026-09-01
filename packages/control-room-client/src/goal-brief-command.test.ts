import {
  GOAL_BRIEF_CONTRACT,
  GOAL_BRIEF_INPUT_INVALID,
  GOAL_BRIEF_LIMITS,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  admitGoalBrief,
  buildNextAllowedCommands,
} from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { buildGoalBriefCommand } from "./goal-brief-command.js";
import type { GoalBriefCommandInput } from "./goal-brief-command.js";
import {
  COMMAND_ENVELOPE_KEYS,
} from "./generated/generated-client.js";
import type { CommandAffordance } from "./generated/generated-client.js";

const CORRELATION_ID = "corr-0001";
const REQUEST_DIGEST = "c".repeat(64);
const SESSION_CREDENTIAL = "sess-0001";
const TITLE = "  Ship it  ";
const INSTRUCTIONS = "  Land the live board\u0301s node  ";

const SHARED_REFUSAL = Object.freeze({
  code: GOAL_BRIEF_INPUT_INVALID,
  layer: GOAL_BRIEF_CONTRACT,
  ok: false,
});

const HOSTILE_AUTHORITY_EXTRAS = Object.freeze([
  "__proto__", "actor", "budgetAccountRef", "commandId", "expectedVersion", "goalId",
  "planningRunRef", "principalId", "projectId", "targetAggregateId", "witness",
] as const);

function affordance<K extends "goal.create" | "goal.close">(
  commandKind: K,
): CommandAffordance<K> {
  const built = buildNextAllowedCommands({ aggregate: "GOAL", state: "DRAFT" }, [{
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: commandKind === "goal.create" ? "cmd-0001" : "cmd-close-0001",
    commandKind,
    expectedVersion: 7,
    inputSchemaVersion: `${commandKind}/1`,
    targetAggregateId: "goal-0001",
  }]);
  const first = built[0];
  if (first === undefined || first.commandKind !== commandKind) {
    throw new Error(`affordance fixture rejected for ${commandKind}`);
  }
  return first as CommandAffordance<K>;
}

function validInput(): GoalBriefCommandInput {
  return {
    affordance: affordance("goal.create"),
    correlationId: CORRELATION_ID,
    instructions: INSTRUCTIONS,
    requestDigest: REQUEST_DIGEST,
    sessionCredential: SESSION_CREDENTIAL,
    title: TITLE,
  };
}

function expectSharedRefusal(input: unknown): void {
  const result = buildGoalBriefCommand(input as GoalBriefCommandInput);
  expect(result).toEqual(SHARED_REFUSAL);
  expect("envelope" in result).toBe(false);
}

describe("typed goal-brief command edge", () => {
  it("normalizes through the shared contract and takes identity only from the affordance", () => {
    const input = validInput();
    const admitted = admitGoalBrief({ title: input.title, instructions: input.instructions });
    if (!admitted.ok) throw new Error("shared contract refused the valid fixture");

    const result = buildGoalBriefCommand(input);
    if (!result.ok) throw new Error("goal-brief command helper refused valid input");
    expect(result.envelope.commandId).toBe(input.affordance.commandId);
    expect(result.envelope.targetAggregateId).toBe(input.affordance.targetAggregateId);
    expect(result.envelope.expectedVersion).toBe(input.affordance.expectedVersion);
    expect(result.envelope.commandKind).toBe("goal.create");
    expect(result.envelope.schemaVersion).toBe(RUNTIME_COMMAND_ENVELOPE_VERSION);
    expect(Object.keys(result.envelope).every((key) =>
      (COMMAND_ENVELOPE_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(result.envelope.payload).toEqual(admitted.brief);
  });

  it("carries the normalized payload as a digestable shared-contract fixed point", () => {
    const result = buildGoalBriefCommand(validInput());
    if (!result.ok) throw new Error("goal-brief command helper refused valid input");
    const admitted = admitGoalBrief(result.envelope.payload);
    if (!admitted.ok) throw new Error("envelope payload was not a valid goal brief");
    expect(admitted.brief).toEqual(result.envelope.payload);
    expect(JSON.stringify(result.envelope.payload)).toBe(JSON.stringify(admitted.brief));
  });

  const { instructions: _missingInstructions, ...missingInstructions } = validInput();
  const malformedCases: readonly { readonly input: unknown; readonly label: string }[] = [
    { input: missingInstructions, label: "missing instructions" },
    { input: { ...validInput(), title: "" }, label: "empty title" },
    { input: { ...validInput(), title: "a".repeat(GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes + 1) },
      label: "oversized title" },
    { input: { ...validInput(), instructions: "a".repeat(
      GOAL_BRIEF_LIMITS.maxInstructionsUtf8Bytes + 1) }, label: "oversized instructions" },
    { input: { ...validInput(), title: 42 }, label: "non-string title" },
  ];

  it.each(malformedCases)("refuses $label with shared stable evidence", ({ input }) => {
    expectSharedRefusal(input);
  });

  it("refuses every named hostile authority extra through the shared contract", () => {
    expect(HOSTILE_AUTHORITY_EXTRAS).toHaveLength(11);
    expect(HOSTILE_AUTHORITY_EXTRAS.length).toBeGreaterThan(0);
    expect(new Set(HOSTILE_AUTHORITY_EXTRAS).size).toBe(HOSTILE_AUTHORITY_EXTRAS.length);
    for (const key of HOSTILE_AUTHORITY_EXTRAS) {
      expectSharedRefusal({ ...validInput(), [key]: "caller-authority" });
    }
  });

  it("refuses every non-record shape with shared stable evidence without throwing", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    let accessorReads = 0;
    const accessorInput = { ...validInput() };
    Object.defineProperty(accessorInput, "title", {
      enumerable: true,
      get(): string { accessorReads += 1; return "getter title"; },
    });
    const hostile = [
      { label: "null", value: null },
      { label: "string", value: "brief" },
      { label: "array", value: [] },
      { label: "revoked proxy", value: revoked.proxy },
      { label: "accessor record", value: accessorInput },
    ];
    expect(hostile).toHaveLength(5);
    for (const entry of hostile) expectSharedRefusal(entry.value);
    expect(accessorReads).toBe(0);
  });

  it("preserves the generated builder's distinguishable wrong-kind refusal", () => {
    const result = buildGoalBriefCommand({
      ...validInput(),
      affordance: affordance("goal.close") as unknown as CommandAffordance<"goal.create">,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("wrong-kind affordance unexpectedly built an envelope");
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("wrong-kind refusal lost generated evidence");
    expect(result.error.code).toBe("INPUT_INVALID");
    expect("layer" in result).toBe(false);
  });
});
