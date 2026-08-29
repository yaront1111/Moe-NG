import { admitGoalBrief } from "@moe/contracts";
import type { GoalBriefRefused, JsonObject } from "@moe/contracts";

import { GENERATED_COMMAND_BUILDERS } from "./generated/generated-client.js";
import type {
  CommandAffordance,
  CommandBuildResult,
} from "./generated/generated-client.js";
import { copyOwnDataInput, sharedInputRefusal } from "./safe-command-input.js";

export interface GoalBriefCommandInput {
  readonly affordance: CommandAffordance<"goal.create">;
  readonly correlationId: string;
  readonly instructions: string;
  readonly requestDigest: string;
  readonly sessionCredential: string;
  readonly title: string;
}

export type GoalBriefCommandResult = CommandBuildResult | GoalBriefRefused;

/**
 * Build only from a daemon-issued affordance and the shared normalized brief.
 * Callers compute requestDigest over JSON.stringify(admitGoalBrief({ title,
 * instructions }).brief) before calling this helper.
 */
export function buildGoalBriefCommand(
  input: GoalBriefCommandInput,
): GoalBriefCommandResult {
  const safe = copyOwnDataInput<GoalBriefCommandInput>(input);
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
