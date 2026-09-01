/**
 * Shared goal-source admission vocabulary. The daemon declarations at
 * apps/daemon/src/documents/document-source-contract.ts:31-42 are authoritative for the
 * media roster and byte bound; apps/control-room/src/v2/goals/use-goal-prd.ts:28 is the
 * existing browser peer. The focused parity test binds all three declarations, so this
 * module does not establish an independent third limit.
 */
import { hasExactKeys, isPlainRecord } from "../runtime/runtime-guards.js";

export const GOAL_SOURCE_INPUT_INVALID = "GOAL_SOURCE_INPUT_INVALID" as const;
export const GOAL_SOURCE_CONTRACT = "GOAL_SOURCE_CONTRACT" as const;
export const GOAL_SOURCE_LIMITS = Object.freeze({
  maxTextUtf8Bytes: 128 * 1024,
} as const);
export const GOAL_SOURCE_MEDIA_TYPES = Object.freeze([
  "text/markdown", "text/plain",
] as const);

export interface GoalSource {
  readonly displayPath: string;
  readonly mediaType: (typeof GOAL_SOURCE_MEDIA_TYPES)[number];
  readonly text: string;
}

export interface GoalSourceAccepted {
  readonly source: GoalSource;
  readonly ok: true;
}

export interface GoalSourceRefused {
  readonly code: typeof GOAL_SOURCE_INPUT_INVALID;
  readonly layer: typeof GOAL_SOURCE_CONTRACT;
  readonly ok: false;
}

export type GoalSourceResult = GoalSourceAccepted | GoalSourceRefused;

const SOURCE_KEYS = Object.freeze(["displayPath", "mediaType", "text"] as const);
const INPUT_REFUSED: GoalSourceRefused = Object.freeze({
  code: GOAL_SOURCE_INPUT_INVALID,
  layer: GOAL_SOURCE_CONTRACT,
  ok: false,
});
const UTF8 = new TextEncoder();

function isNonEmptyWellFormedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed();
}

function isGoalSourceMediaType(value: unknown): value is GoalSource["mediaType"] {
  return typeof value === "string"
    && GOAL_SOURCE_MEDIA_TYPES.some((mediaType) => mediaType === value);
}

export function admitGoalSource(input: unknown): GoalSourceResult {
  if (!isPlainRecord(input) || !hasExactKeys(input, SOURCE_KEYS, [])) return INPUT_REFUSED;
  const displayPath = input["displayPath"];
  const mediaType = input["mediaType"];
  const text = input["text"];
  if (
    !isNonEmptyWellFormedString(displayPath)
    || !isGoalSourceMediaType(mediaType)
    || !isNonEmptyWellFormedString(text)
    || UTF8.encode(text).byteLength > GOAL_SOURCE_LIMITS.maxTextUtf8Bytes
  ) return INPUT_REFUSED;
  const source: GoalSource = Object.freeze({ displayPath, mediaType, text });
  return Object.freeze({ source, ok: true });
}
