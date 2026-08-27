import { admitGoalBrief } from "@moe/contracts";
import type { GoalBriefRefused, JsonObject } from "@moe/contracts";

import { GENERATED_COMMAND_BUILDERS } from "./generated/generated-client.js";
import type {
  CommandAffordance,
  CommandBuildResult,
} from "./generated/generated-client.js";

export interface GoalBriefCommandInput {
  readonly affordance: CommandAffordance<"goal.create">;
  readonly correlationId: string;
  readonly instructions: string;
  readonly requestDigest: string;
  readonly sessionCredential: string;
  readonly title: string;
}

export type GoalBriefCommandResult = CommandBuildResult | GoalBriefRefused;

type SafeCommandInput = GoalBriefCommandInput & Readonly<Record<string, unknown>>;

function copyOwnDataInput(input: unknown): SafeCommandInput | null {
  if (typeof input !== "object" || input === null) return null;
  try {
    if (Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input) as object | null;
    if (prototype !== null && prototype !== Object.prototype) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string")) return null;
    const copied = Object.create(null) as Record<string, unknown>;
    for (const key of keys as readonly string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      copied[key] = descriptor.value;
    }
    return Object.freeze(copied) as SafeCommandInput;
  } catch {
    return null;
  }
}

function sharedInputRefusal(input: unknown): GoalBriefRefused {
  const result = admitGoalBrief(input);
  if (!result.ok) return result;
  const fallback = admitGoalBrief(null);
  if (!fallback.ok) return fallback;
  throw new Error("goal brief contract accepted its null refusal control");
}

/**
 * Build only from a daemon-issued affordance and the shared normalized brief.
 * Callers compute requestDigest over JSON.stringify(admitGoalBrief({ title,
 * instructions }).brief) before calling this helper.
 */
export function buildGoalBriefCommand(
  input: GoalBriefCommandInput,
): GoalBriefCommandResult {
  const safe = copyOwnDataInput(input);
  if (safe === null) return sharedInputRefusal(input);
  const {
    affordance, correlationId, requestDigest, sessionCredential, ...brief
  } = safe;
  const admitted = admitGoalBrief(brief);
  if (!admitted.ok) return admitted;
  const payload = Object.freeze({ ...admitted.brief }) satisfies JsonObject;
  return GENERATED_COMMAND_BUILDERS["goal.create"](affordance, {
    correlationId,
    payload,
    requestDigest,
    sessionCredential,
  });
}
