import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_INSTRUCTION_PATTERNS,
  INSTRUCTION_FILE_LIMITS,
  checkInstructionContract,
  loadInstructionFiles,
} from "./checker.js";
import type { Violation } from "./checker.js";

const CANONICAL_MARKER = "<!-- instruction-contract: canonical -->";
const BRIDGE_MARKER = "<!-- instruction-contract: bridge -->";
const VALID_AGENTS = `${CANONICAL_MARKER}\n# Project instructions\nDurable policy.`;
const VALID_CLAUDE = `${BRIDGE_MARKER}\nRead AGENTS.md first.`;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function check(
  agents: string | null = VALID_AGENTS,
  claude: string | null = VALID_CLAUDE,
): Violation[] {
  return checkInstructionContract({ agents, claude });
}

function summaries(violations: readonly Violation[]) {
  return violations.map(({ code, file }) => ({ code, file }));
}

describe("checkInstructionContract", () => {
  it("reports missing files with stable reason codes", () => {
    expect(summaries(check(null, null))).toEqual([
      { code: "AGENTS_MISSING", file: "AGENTS.md" },
      { code: "CLAUDE_MISSING", file: "CLAUDE.md" },
    ]);
  });

  it("requires the canonical marker", () => {
    expect(summaries(check("# Project instructions"))).toEqual([
      { code: "CANONICAL_MARKER_MISSING", file: "AGENTS.md" },
    ]);
  });

  it("requires the bridge marker", () => {
    expect(summaries(check(VALID_AGENTS, "Read AGENTS.md first."))).toEqual([
      { code: "BRIDGE_MARKER_MISSING", file: "CLAUDE.md" },
    ]);
  });

  it("requires the bridge to reference AGENTS.md", () => {
    expect(summaries(check(VALID_AGENTS, `${BRIDGE_MARKER}\nRead policy first.`))).toEqual([
      { code: "BRIDGE_REFERENCE_MISSING", file: "CLAUDE.md" },
    ]);
  });

  it.each([
    [
      "AGENTS.md line cap",
      `${CANONICAL_MARKER}\n${Array(120).fill("line").join("\n")}`,
      VALID_CLAUDE,
      "AGENTS.md",
    ],
    [
      "AGENTS.md byte cap",
      `${CANONICAL_MARKER}\n${"😀".repeat(2050)}`,
      VALID_CLAUDE,
      "AGENTS.md",
    ],
    [
      "CLAUDE.md line cap",
      VALID_AGENTS,
      `${BRIDGE_MARKER}\nAGENTS.md\n${Array(39).fill("line").join("\n")}`,
      "CLAUDE.md",
    ],
    [
      "CLAUDE.md byte cap",
      VALID_AGENTS,
      `${BRIDGE_MARKER}\nAGENTS.md\n${"😀".repeat(510)}`,
      "CLAUDE.md",
    ],
  ] as const)("enforces the %s", (_label, agents, claude, file) => {
    expect(summaries(check(agents, claude))).toEqual([
      { code: "FILE_OVERSIZED", file },
    ]);
  });

  it("rejects generated instruction markers", () => {
    const generated = `${VALID_AGENTS}\n<!-- moe-generated: sha=abc -->`;

    expect(summaries(check(generated))).toEqual([
      { code: "GENERATED_MARKER_PRESENT", file: "AGENTS.md" },
    ]);
  });

  it.each([
    ["task id", `task-${"a".repeat(32)}`],
    ["epic id", `epic-${"b".repeat(32)}`],
    ["channel id", `chan-${"c".repeat(32)}`],
    ["worker id", `worker-${"d".repeat(8)}`],
    ["architect id", `architect-${"e".repeat(8)}`],
    ["qa id", `qa-${"f".repeat(8)}`],
    ["governor id", `governor-${"0".repeat(8)}`],
    ["approval marker", "Approval mode:"],
  ])("rejects the live-state %s", (_label, marker) => {
    expect(summaries(check(`${VALID_AGENTS}\n${marker}`))).toEqual([
      { code: "LIVE_STATE_MARKER_PRESENT", file: "AGENTS.md" },
    ]);
  });

  it("allows durable policy to mention the .moe directory", () => {
    expect(check(`${VALID_AGENTS}\nDo not edit live .moe/ state.`)).toEqual([]);
  });

  it("treats empty content as present but invalid", () => {
    expect(summaries(check("", ""))).toEqual([
      { code: "CANONICAL_MARKER_MISSING", file: "AGENTS.md" },
      { code: "BRIDGE_MARKER_MISSING", file: "CLAUDE.md" },
      { code: "BRIDGE_REFERENCE_MISSING", file: "CLAUDE.md" },
    ]);
  });

  it("returns a deeply frozen deterministic result", () => {
    const result = check(`${VALID_AGENTS}\nmoe-generated`);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(result).toEqual(check(`${VALID_AGENTS}\nmoe-generated`));
  });

  it("exports the frozen contract limits and forbidden patterns", () => {
    expect(INSTRUCTION_FILE_LIMITS).toEqual({
      "AGENTS.md": { maxBytes: 8192, maxLines: 120 },
      "CLAUDE.md": { maxBytes: 2048, maxLines: 40 },
    });
    expect(Object.isFrozen(INSTRUCTION_FILE_LIMITS)).toBe(true);
    expect(Object.isFrozen(INSTRUCTION_FILE_LIMITS["AGENTS.md"])).toBe(true);
    expect(Object.isFrozen(INSTRUCTION_FILE_LIMITS["CLAUDE.md"])).toBe(true);
    expect(FORBIDDEN_INSTRUCTION_PATTERNS).toHaveLength(4);
    expect(Object.isFrozen(FORBIDDEN_INSTRUCTION_PATTERNS)).toBe(true);
  });

  it("accepts a valid synthetic instruction pair", () => {
    expect(check()).toEqual([]);
  });
});

describe("root instruction contract", () => {
  it("accepts the real root AGENTS.md", () => {
    const input = loadInstructionFiles(REPO_ROOT);

    expect(checkInstructionContract({ agents: input.agents, claude: VALID_CLAUDE })).toEqual([]);
  });

  it("accepts the real root CLAUDE.md", () => {
    const input = loadInstructionFiles(REPO_ROOT);

    expect(checkInstructionContract({ agents: VALID_AGENTS, claude: input.claude })).toEqual([]);
  });
});
