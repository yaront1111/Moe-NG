import { hasExactKeys, isPlainRecord } from "../runtime/runtime-guards.js";

export const GOAL_BRIEF_INPUT_INVALID = "GOAL_BRIEF_INPUT_INVALID" as const;
export const GOAL_BRIEF_CONTRACT = "GOAL_BRIEF_CONTRACT" as const;

export const GOAL_BRIEF_LIMITS = Object.freeze({
  maxInstructionsUtf8Bytes: 32 * 1_024,
  maxTitleUtf8Bytes: 1_024,
} as const);

export interface GoalBrief {
  readonly instructions: string;
  readonly title: string;
}

export interface GoalBriefAccepted {
  readonly brief: GoalBrief;
  readonly ok: true;
}

export interface GoalBriefRefused {
  readonly code: typeof GOAL_BRIEF_INPUT_INVALID;
  readonly layer: typeof GOAL_BRIEF_CONTRACT;
  readonly ok: false;
}

export type GoalBriefResult = GoalBriefAccepted | GoalBriefRefused;

const BRIEF_KEYS = Object.freeze(["instructions", "title"] as const);
const UTF8 = new TextEncoder();
const INPUT_REFUSED: GoalBriefRefused = Object.freeze({
  code: GOAL_BRIEF_INPUT_INVALID,
  layer: GOAL_BRIEF_CONTRACT,
  ok: false,
});

function normalizedText(value: unknown, maxUtf8Bytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || !normalized.isWellFormed()) return undefined;
  if (normalized.length > maxUtf8Bytes) return undefined;
  return UTF8.encode(normalized).byteLength <= maxUtf8Bytes ? normalized : undefined;
}

export function admitGoalBrief(input: unknown): GoalBriefResult {
  if (!isPlainRecord(input) || !hasExactKeys(input, BRIEF_KEYS, [])) {
    return INPUT_REFUSED;
  }
  const title = normalizedText(input["title"], GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes);
  const instructions = normalizedText(
    input["instructions"], GOAL_BRIEF_LIMITS.maxInstructionsUtf8Bytes,
  );
  if (title === undefined || instructions === undefined) return INPUT_REFUSED;
  const brief: GoalBrief = Object.freeze({ instructions, title });
  return Object.freeze({ brief, ok: true });
}
