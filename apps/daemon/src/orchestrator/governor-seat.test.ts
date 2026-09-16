import { describe, expect, it } from "vitest";

import type { GovernanceBrief } from "../review/governance-escalation-decider.js";
import {
  GOVERNANCE_FENCE_BEGIN,
  GOVERNANCE_FENCE_END,
  createGovernorSeat,
  governorPrompt,
  readGovernorAnswer,
} from "./governor-seat.js";
import type { GovernorRunner } from "./governor-seat.js";

/**
 * The seat that answers an exhausted review, and — mostly — every way it is not allowed to.
 *
 * Governance answering WRONGLY is a worse failure than governance not answering: a wrong answer
 * is recorded durably, cited by later rounds and acted on by a node. So every ambiguity here
 * must resolve to no answer, which replans the node rather than retrying it. Most of this suite
 * is that property.
 */

const BRIEF: GovernanceBrief = Object.freeze({
  questions: Object.freeze([
    Object.freeze({
      criterionId: "CRT-REG-03-A",
      detail: "Should shared.obligation.description be FUNCTIONAL or SET? An agent cannot decide.",
      findingId: "registry-review-obligation-description-cardinality",
      severity: "MAJOR",
    }),
  ]),
  reviewVersion: 4,
  subjectRef: "node:v1:registry-release",
});

const fenced = (body: unknown): string =>
  `chatter before\n${GOVERNANCE_FENCE_BEGIN}\n${JSON.stringify(body)}\n${GOVERNANCE_FENCE_END}\nchatter after`;

const DECIDED = {
  answer: "shared.obligation.description is SET.",
  basis: "GOVERNANCE_DECIDED",
  citation: null,
  findingId: "registry-review-obligation-description-cardinality",
  rationale: "The record is silent, and SET is the lossless choice.",
};

const CITED = {
  answer: "shared.obligation.description is SET.",
  basis: "PRD_CITED",
  citation: "PRD 26.1",
  findingId: "registry-review-obligation-description-cardinality",
  rationale: "",
};

const answered = (output: string): GovernorRunner => () => ({ ok: true, output });
const seatOver = (run: GovernorRunner) => {
  const lines: string[] = [];
  return { lines, seat: createGovernorSeat({ log: (line) => lines.push(line), run }) };
};

describe("reading the governor's answer", () => {
  it("binds the answer to the brief, not to what the model said it was answering", () => {
    // The node, the review version and the question text are the daemon's facts. A seat that
    // could supply them could record an answer against another node, or against a question
    // review never asked.
    const answer = readGovernorAnswer(fenced({
      decisions: [{ ...DECIDED, reviewVersion: 99, subjectRef: "node:v1:somewhere-else" }],
      guidance: "description is SET; record it in ADR 0011.",
    }), BRIEF);

    expect(answer?.decisions).toHaveLength(1);
    expect(answer?.decisions[0]).toMatchObject({
      criterionId: "CRT-REG-03-A",
      reviewVersion: 4,
      subjectRef: "node:v1:registry-release",
    });
  });

  it("reads an answer that restates the template before giving it", () => {
    // A model that echoes the requested shape first would otherwise have its own instructions
    // parsed as its answer.
    const echoed = [
      GOVERNANCE_FENCE_BEGIN, '{ "guidance": "...", "decisions": [] }', GOVERNANCE_FENCE_END,
      "that is the shape; here is my answer:",
      GOVERNANCE_FENCE_BEGIN,
      JSON.stringify({ decisions: [DECIDED], guidance: "description is SET." }),
      GOVERNANCE_FENCE_END,
    ].join("\n");

    expect(readGovernorAnswer(echoed, BRIEF)?.decisions).toHaveLength(1);
  });

  it("keeps a citation only when the answer claims to have read one", () => {
    const cited = readGovernorAnswer(fenced({
      decisions: [CITED], guidance: "The PRD already answers this: SET.",
    }), BRIEF);
    expect(cited?.decisions[0]).toMatchObject({ basis: "PRD_CITED", citation: "PRD 26.1" });

    // A decided answer may not also carry a source, or it would read as sourced when it is not.
    const decided = readGovernorAnswer(fenced({
      decisions: [{ ...DECIDED, citation: "PRD 26.1" }], guidance: "SET.",
    }), BRIEF);
    expect(decided?.decisions[0]?.citation).toBeNull();
  });
});

describe("what the governor is not allowed to get away with", () => {
  const refused: readonly (readonly [string, string])[] = [
    ["no fence at all", "I think it should be SET."],
    ["an unclosed fence", `${GOVERNANCE_FENCE_BEGIN}\n{"guidance":"SET"}`],
    ["a body that is not JSON", `${GOVERNANCE_FENCE_BEGIN}\nSET, obviously\n${GOVERNANCE_FENCE_END}`],
    ["an empty answer", fenced({ decisions: [], guidance: "SET." })],
    ["no guidance", fenced({ decisions: [DECIDED], guidance: "   " })],
    ["guidance beyond what can be stored", fenced({ decisions: [DECIDED], guidance: "x".repeat(4_001) })],
    ["decisions that are not a list", fenced({ decisions: "SET", guidance: "SET." })],
    ["a citation that cites nothing", fenced({ decisions: [{ ...CITED, citation: "" }], guidance: "SET." })],
    ["a decision that reasons nothing", fenced({ decisions: [{ ...DECIDED, rationale: "" }], guidance: "SET." })],
    ["an answer that answers nothing", fenced({ decisions: [{ ...DECIDED, answer: "" }], guidance: "SET." })],
    ["an unknown basis", fenced({ decisions: [{ ...DECIDED, basis: "BECAUSE_I_SAY_SO" }], guidance: "SET." })],
    ["a question review never asked", fenced({ decisions: [{ ...DECIDED, findingId: "invented" }], guidance: "SET." })],
  ];

  it("refuses every malformed answer rather than acting on part of one", () => {
    expect(refused.length).toBe(12);

    for (const [why, output] of refused) {
      expect(readGovernorAnswer(output, BRIEF), why).toBeNull();
    }
  });

  it("voids the whole answer when one decision in it is bad", () => {
    // A partial answer would fund an attempt while the record claimed fewer decisions than the
    // guidance the node is acting on.
    const mixed = fenced({
      decisions: [DECIDED, { ...DECIDED, findingId: "invented" }],
      guidance: "SET.",
    });

    expect(readGovernorAnswer(mixed, BRIEF)).toBeNull();
  });
});

describe("running the seat", () => {
  it("answers when the seat answers", () => {
    const { lines, seat } = seatOver(answered(fenced({
      decisions: [CITED], guidance: "The PRD already answers this: SET.",
    })));

    expect(seat(BRIEF)?.decisions).toHaveLength(1);
    expect(lines[0]).toContain("1 from the product record");
  });

  it("gives no answer when the seat fails, times out, or dies", () => {
    const failed = seatOver(() => ({ ok: false, output: "killed" }));
    expect(failed.seat(BRIEF)).toBeNull();
    expect(failed.lines[0]).toContain("failed");

    const died = seatOver(() => { throw new Error("ENOENT"); });
    expect(died.seat(BRIEF)).toBeNull();
    expect(died.lines[0]).toContain("could not be run");
  });

  it("gives no answer when the seat says nothing usable", () => {
    const { lines, seat } = seatOver(answered("I would rather not say."));

    expect(seat(BRIEF)).toBeNull();
    expect(lines[0]).toContain("no usable decision");
  });

  it("still answers when the product record cannot be read", () => {
    // Background is background. Losing it means the seat will usually have to decide rather
    // than cite, which is a worse answer — but not no answer.
    const lines: string[] = [];
    const seat = createGovernorSeat({
      documents: () => { throw new Error("the PRD is unreadable"); },
      log: (line) => lines.push(line),
      run: answered(fenced({ decisions: [DECIDED], guidance: "SET." })),
    });

    expect(seat(BRIEF)?.decisions).toHaveLength(1);
  });
});

describe("what the governor is asked", () => {
  it("asks the review's own question, and says the product record decides first", () => {
    const prompt = governorPrompt(BRIEF, "PRD 26.1: obligations carry descriptions.");

    expect(prompt).toContain("registry-review-obligation-description-cardinality");
    expect(prompt).toContain("Should shared.obligation.description be FUNCTIONAL or SET?");
    expect(prompt).toContain("CRT-REG-03-A");
    expect(prompt).toContain("THE PRODUCT RECORD DECIDES FIRST");
    expect(prompt).toContain("PRD 26.1: obligations carry descriptions.");
    expect(prompt).toContain(GOVERNANCE_FENCE_BEGIN);
    // It must not invite a waiver: that is the one thing an answer may never buy.
    expect(prompt).toContain("Do not waive any approved");
  });

  it("omits the product record section entirely when there is none to show", () => {
    // An empty "PRODUCT RECORD:" heading reads as a record that says nothing, which is a
    // different claim from having none.
    expect(governorPrompt(BRIEF, "   ")).not.toContain("PRODUCT RECORD:");
  });
});
