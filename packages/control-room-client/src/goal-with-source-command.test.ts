import {
  GOAL_BRIEF_CONTRACT,
  GOAL_BRIEF_INPUT_INVALID,
  GOAL_BRIEF_LIMITS,
  GOAL_SOURCE_CONTRACT,
  GOAL_SOURCE_INPUT_INVALID,
  GOAL_SOURCE_LIMITS,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  admitGoalBrief,
  admitGoalSource,
  buildNextAllowedCommands,
} from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { buildGoalWithSourceCommand } from "./goal-with-source-command.js";
import type { GoalWithSourceCommandInput } from "./goal-with-source-command.js";
import { COMMAND_ENVELOPE_KEYS } from "./generated/generated-client.js";
import type { CommandAffordance } from "./generated/generated-client.js";

const CORRELATION_ID = "corr-0002";
const REQUEST_DIGEST = "d".repeat(64);
const SESSION_CREDENTIAL = "sess-0002";
const TITLE = "  Ship the source leg  ";
const INSTRUCTIONS = "  Land the atomic source leg  ";
const SOURCE = Object.freeze({
  displayPath: "prd.md",
  mediaType: "text/markdown",
  text: "# PRD\nbuild it",
});

/**
 * The two contracts refuse at DIFFERENT layers, and the helper must carry each
 * one verbatim rather than collapsing both into one house code. These are
 * TEST-SIDE literals on purpose: re-deriving them from the module under test
 * would make a renamed code a fixed point that no arm could red.
 */
const BRIEF_REFUSAL = Object.freeze({
  code: GOAL_BRIEF_INPUT_INVALID,
  layer: GOAL_BRIEF_CONTRACT,
  ok: false,
});
const SOURCE_REFUSAL = Object.freeze({
  code: GOAL_SOURCE_INPUT_INVALID,
  layer: GOAL_SOURCE_CONTRACT,
  ok: false,
});

const HOSTILE_AUTHORITY_EXTRAS = Object.freeze([
  "__proto__", "actor", "budgetAccountRef", "commandId", "documentId", "expectedVersion",
  "goalId", "principalId", "projectId", "sourceRef", "targetAggregateId", "witness",
] as const);

function affordance<K extends "goal.create_with_source" | "goal.close">(
  commandKind: K,
): CommandAffordance<K> {
  const built = buildNextAllowedCommands({ aggregate: "GOAL", state: "DRAFT" }, [{
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: commandKind === "goal.close" ? "cmd-close-0002" : "cmd-0002",
    commandKind,
    expectedVersion: 11,
    inputSchemaVersion: `${commandKind}/1`,
    targetAggregateId: "goal-0002",
  }]);
  const first = built[0];
  if (first === undefined || first.commandKind !== commandKind) {
    throw new Error(`affordance fixture rejected for ${commandKind}`);
  }
  return first as CommandAffordance<K>;
}

function validInput(): GoalWithSourceCommandInput {
  return {
    affordance: affordance("goal.create_with_source"),
    correlationId: CORRELATION_ID,
    instructions: INSTRUCTIONS,
    requestDigest: REQUEST_DIGEST,
    sessionCredential: SESSION_CREDENTIAL,
    source: SOURCE,
    title: TITLE,
  };
}

function refusalOf(input: unknown): unknown {
  const result = buildGoalWithSourceCommand(input as GoalWithSourceCommandInput);
  expect("envelope" in result).toBe(false);
  return result;
}

describe("typed goal-with-source command edge", () => {
  it("carries the payload the daemon's vocabulary declares, in that key order", () => {
    const input = validInput();
    const admittedBrief = admitGoalBrief({
      instructions: input.instructions, title: input.title,
    });
    const admittedSource = admitGoalSource(SOURCE);
    if (!admittedBrief.ok) throw new Error("shared brief contract refused the valid fixture");
    if (!admittedSource.ok) throw new Error("shared source contract refused the valid fixture");

    const result = buildGoalWithSourceCommand(input);
    if (!result.ok) throw new Error("goal-with-source helper refused valid input");
    // The daemon declares ["instructions", "source", "title"] for this kind
    // (apps/daemon/src/daemon-command-vocabulary.ts:229); order is asserted, not just membership.
    expect(Object.keys(result.envelope.payload)).toEqual(["instructions", "source", "title"]);
    expect(result.envelope.payload).toEqual({
      instructions: admittedBrief.brief.instructions,
      source: admittedSource.source,
      title: admittedBrief.brief.title,
    });
    // The NORMALIZED brief, not the raw input: both fixtures arrive padded.
    expect(result.envelope.payload["title"]).toBe("Ship the source leg");
    expect(result.envelope.payload["instructions"]).toBe("Land the atomic source leg");
  });

  it("takes identity only from the affordance and never from the caller", () => {
    const input = validInput();
    const result = buildGoalWithSourceCommand(input);
    if (!result.ok) throw new Error("goal-with-source helper refused valid input");
    expect(result.envelope.commandKind).toBe("goal.create_with_source");
    expect(result.envelope.commandId).toBe(input.affordance.commandId);
    expect(result.envelope.targetAggregateId).toBe(input.affordance.targetAggregateId);
    expect(result.envelope.expectedVersion).toBe(input.affordance.expectedVersion);
    expect(result.envelope.schemaVersion).toBe(RUNTIME_COMMAND_ENVELOPE_VERSION);
    expect(Object.keys(result.envelope).every((key) =>
      (COMMAND_ENVELOPE_KEYS as readonly string[]).includes(key))).toBe(true);
  });

  it("emits a source the shared contract re-admits unchanged", () => {
    const result = buildGoalWithSourceCommand(validInput());
    if (!result.ok) throw new Error("goal-with-source helper refused valid input");
    const readmitted = admitGoalSource(result.envelope.payload["source"]);
    if (!readmitted.ok) throw new Error("the emitted source was not an admissible goal source");
    expect(readmitted.source).toEqual(result.envelope.payload["source"]);
    expect(Object.isFrozen(result.envelope.payload["source"])).toBe(true);
  });

  const { instructions: _dropped, ...missingInstructions } = validInput();

  /**
   * Each case names the LAYER that must answer it. A case that only asserted
   * "refused" would stay green if the source half started answering for the
   * brief half, or the reverse - which is the whole point of admitting through
   * two separate contracts.
   */
  const hostileCases: readonly {
    readonly expected: unknown; readonly input: unknown; readonly label: string;
  }[] = [
    { expected: BRIEF_REFUSAL, input: missingInstructions, label: "missing instructions" },
    { expected: BRIEF_REFUSAL, input: { ...validInput(), title: "" }, label: "empty title" },
    { expected: BRIEF_REFUSAL, input: { ...validInput(), title: 42 },
      label: "non-string title" },
    { expected: BRIEF_REFUSAL, input: { ...validInput(),
      instructions: "a".repeat(GOAL_BRIEF_LIMITS.maxInstructionsUtf8Bytes + 1) },
      label: "oversized instructions" },
    { expected: SOURCE_REFUSAL, input: { ...validInput(),
      source: { ...SOURCE, sourceRef: "caller-authority" } },
      label: "extra key on the source" },
    { expected: SOURCE_REFUSAL, input: { ...validInput(),
      source: { ...SOURCE, text: "a".repeat(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes + 1) } },
      label: "oversized source text" },
    { expected: SOURCE_REFUSAL, input: { ...validInput(),
      source: { ...SOURCE, mediaType: "application/pdf" } },
      label: "unknown mediaType" },
    { expected: SOURCE_REFUSAL, input: { ...validInput(), source: { ...SOURCE, displayPath: 7 } },
      label: "non-string displayPath" },
    { expected: SOURCE_REFUSAL, input: { ...validInput(), source: { ...SOURCE, displayPath: "" } },
      label: "empty displayPath" },
    { expected: SOURCE_REFUSAL, input: { ...validInput(), source: { ...SOURCE, text: "" } },
      label: "empty source text" },
    { expected: SOURCE_REFUSAL, input: { ...validInput(), source: null },
      label: "absent source record" },
  ];

  it("generates a nonzero hostile roster covering both admitted halves", () => {
    expect(hostileCases.length).toBeGreaterThan(0);
    expect(hostileCases).toHaveLength(11);
    expect(new Set(hostileCases.map((entry) => entry.label)).size).toBe(hostileCases.length);
    expect(hostileCases.filter((entry) => entry.expected === BRIEF_REFUSAL)).toHaveLength(4);
    expect(hostileCases.filter((entry) => entry.expected === SOURCE_REFUSAL)).toHaveLength(7);
  });

  it.each(hostileCases)("refuses $label at its own contract's layer", ({ expected, input }) => {
    expect(refusalOf(input)).toEqual(expected);
  });

  it("admits exactly at the shared bound and refuses one byte past it", () => {
    const atBound = "a".repeat(GOAL_SOURCE_LIMITS.maxTextUtf8Bytes);
    const admitted = buildGoalWithSourceCommand({
      ...validInput(), source: { ...SOURCE, text: atBound },
    });
    if (!admitted.ok) throw new Error("the shared bound refused a source exactly at its limit");
    const emitted = admitGoalSource(admitted.envelope.payload["source"]);
    if (!emitted.ok) throw new Error("the at-bound source was not re-admissible");
    expect(emitted.source.text).toBe(atBound);
    expect(refusalOf({ ...validInput(), source: { ...SOURCE, text: `${atBound}a` } }))
      .toEqual(SOURCE_REFUSAL);
  });

  it("refuses every named hostile authority extra at the brief's layer", () => {
    expect(HOSTILE_AUTHORITY_EXTRAS.length).toBeGreaterThan(0);
    expect(HOSTILE_AUTHORITY_EXTRAS).toHaveLength(12);
    expect(new Set(HOSTILE_AUTHORITY_EXTRAS).size).toBe(HOSTILE_AUTHORITY_EXTRAS.length);
    for (const key of HOSTILE_AUTHORITY_EXTRAS) {
      expect(refusalOf({ ...validInput(), [key]: "caller-authority" })).toEqual(BRIEF_REFUSAL);
    }
  });

  it("refuses every non-record shape without throwing and without reading accessors", () => {
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
    for (const entry of hostile) expect(refusalOf(entry.value)).toEqual(BRIEF_REFUSAL);
    expect(accessorReads).toBe(0);
  });

  it("preserves the generated builder's distinguishable wrong-kind refusal", () => {
    const result = buildGoalWithSourceCommand({
      ...validInput(),
      affordance: affordance("goal.close") as unknown as
        CommandAffordance<"goal.create_with_source">,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("wrong-kind affordance unexpectedly built an envelope");
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("wrong-kind refusal lost generated evidence");
    expect(result.error.code).toBe("INPUT_INVALID");
    // The generated refusal carries no `layer`; conflating it with a contract
    // refusal would hide WHICH mechanism declined.
    expect("layer" in result).toBe(false);
  });
});
