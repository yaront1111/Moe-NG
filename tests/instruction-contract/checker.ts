import { readFileSync } from "node:fs";
import { join } from "node:path";

export type InstructionFile = "AGENTS.md" | "CLAUDE.md";

export type ViolationCode =
  | "AGENTS_MISSING"
  | "CLAUDE_MISSING"
  | "CANONICAL_MARKER_MISSING"
  | "BRIDGE_MARKER_MISSING"
  | "BRIDGE_REFERENCE_MISSING"
  | "FILE_OVERSIZED"
  | "GENERATED_MARKER_PRESENT"
  | "LIVE_STATE_MARKER_PRESENT";

export interface Violation {
  readonly code: ViolationCode;
  readonly file: InstructionFile;
  readonly detail: string;
}

export interface InstructionContractInput {
  readonly agents: string | null;
  readonly claude: string | null;
}

interface FileLimit {
  readonly maxBytes: number;
  readonly maxLines: number;
}

interface ForbiddenInstructionPattern {
  readonly code: "GENERATED_MARKER_PRESENT" | "LIVE_STATE_MARKER_PRESENT";
  readonly detail: string;
  readonly pattern: RegExp;
}

export const INSTRUCTION_FILE_LIMITS: Readonly<Record<InstructionFile, FileLimit>> =
  Object.freeze({
    "AGENTS.md": Object.freeze({ maxBytes: 8192, maxLines: 120 }),
    "CLAUDE.md": Object.freeze({ maxBytes: 2048, maxLines: 40 }),
  });

export const FORBIDDEN_INSTRUCTION_PATTERNS: readonly ForbiddenInstructionPattern[] =
  Object.freeze([
    Object.freeze({
      code: "GENERATED_MARKER_PRESENT",
      detail: "contains a generated-instruction marker",
      pattern: /moe-generated/u,
    }),
    Object.freeze({
      code: "LIVE_STATE_MARKER_PRESENT",
      detail: "contains a live task, epic, or channel identifier",
      pattern: /\b(?:task|epic|chan)-[0-9a-f]{32}\b/u,
    }),
    Object.freeze({
      code: "LIVE_STATE_MARKER_PRESENT",
      detail: "contains a live worker or role identifier",
      pattern: /\b(?:worker|architect|qa|governor)-[0-9a-f]{8}\b/u,
    }),
    Object.freeze({
      code: "LIVE_STATE_MARKER_PRESENT",
      detail: "contains generated approval-mode state",
      pattern: /Approval mode:/u,
    }),
  ]);

const CANONICAL_MARKER = "<!-- instruction-contract: canonical -->";
const BRIDGE_MARKER = "<!-- instruction-contract: bridge -->";

function addViolation(
  violations: Violation[],
  code: ViolationCode,
  file: InstructionFile,
  detail: string,
): void {
  violations.push(Object.freeze({ code, detail, file }));
}

function checkSize(
  content: string,
  file: InstructionFile,
  violations: Violation[],
): void {
  const limit = INSTRUCTION_FILE_LIMITS[file];
  const lines = content.split(/\r?\n/u).length;
  const bytes = Buffer.byteLength(content, "utf8");
  if (lines <= limit.maxLines && bytes <= limit.maxBytes) return;
  addViolation(
    violations,
    "FILE_OVERSIZED",
    file,
    `${file} has ${lines} lines and ${bytes} bytes; limits are ${limit.maxLines} and ${limit.maxBytes}.`,
  );
}

function checkForbidden(
  content: string,
  file: InstructionFile,
  violations: Violation[],
): void {
  for (const forbidden of FORBIDDEN_INSTRUCTION_PATTERNS) {
    if (forbidden.pattern.test(content)) {
      addViolation(violations, forbidden.code, file, `${file} ${forbidden.detail}.`);
    }
  }
}

function checkAgents(content: string | null, violations: Violation[]): void {
  if (content === null) {
    addViolation(violations, "AGENTS_MISSING", "AGENTS.md", "AGENTS.md could not be read.");
    return;
  }
  if (!content.includes(CANONICAL_MARKER)) {
    addViolation(
      violations,
      "CANONICAL_MARKER_MISSING",
      "AGENTS.md",
      "AGENTS.md lacks the canonical contract marker.",
    );
  }
  checkSize(content, "AGENTS.md", violations);
  checkForbidden(content, "AGENTS.md", violations);
}

function checkClaude(content: string | null, violations: Violation[]): void {
  if (content === null) {
    addViolation(violations, "CLAUDE_MISSING", "CLAUDE.md", "CLAUDE.md could not be read.");
    return;
  }
  if (!content.includes(BRIDGE_MARKER)) {
    addViolation(
      violations,
      "BRIDGE_MARKER_MISSING",
      "CLAUDE.md",
      "CLAUDE.md lacks the bridge contract marker.",
    );
  }
  if (!content.includes("AGENTS.md")) {
    addViolation(
      violations,
      "BRIDGE_REFERENCE_MISSING",
      "CLAUDE.md",
      "CLAUDE.md does not reference AGENTS.md.",
    );
  }
  checkSize(content, "CLAUDE.md", violations);
  checkForbidden(content, "CLAUDE.md", violations);
}

/** Checks file contents without accessing or mutating the filesystem. */
export function checkInstructionContract(input: InstructionContractInput): Violation[] {
  const violations: Violation[] = [];
  checkAgents(input.agents, violations);
  checkClaude(input.claude, violations);
  Object.freeze(violations);
  return violations;
}

function readInstructionFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Loads the two durable files read-only and fails closed on every read error. */
export function loadInstructionFiles(rootDir: string): InstructionContractInput {
  return Object.freeze({
    agents: readInstructionFile(join(rootDir, "AGENTS.md")),
    claude: readInstructionFile(join(rootDir, "CLAUDE.md")),
  });
}
