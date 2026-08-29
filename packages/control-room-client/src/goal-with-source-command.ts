import { admitGoalBrief, admitGoalSource } from "@moe/contracts";
import type {
  GoalBriefRefused,
  GoalSource,
  GoalSourceRefused,
  JsonObject,
} from "@moe/contracts";

import { GENERATED_COMMAND_BUILDERS } from "./generated/generated-client.js";
import type {
  CommandAffordance,
  CommandBuildResult,
} from "./generated/generated-client.js";
import { copyOwnDataInput, sharedInputRefusal } from "./safe-command-input.js";

/**
 * The typed edge for `goal.create_with_source`: a goal and the source document
 * that motivates it, written by ONE command.
 *
 * The atomicity is the point. Ingesting the document separately would make the
 * operator's single click two writes, and a half-applied pair - a source with no
 * goal, or a goal citing a source that was never recorded - is a state no
 * compensating delete can honestly undo. So the bytes travel INSIDE the command
 * and the daemon commits both or neither.
 *
 * Two admissions, two layers, kept apart:
 *  - the BRIEF through `admitGoalBrief`;
 *  - the SOURCE through `admitGoalSource`, which owns the byte bound and the
 *    media roster.
 * Each refusal is returned exactly as its contract issued it - same code, same
 * layer - because an operator who is told a create was refused deserves to know
 * WHICH gate declined. Collapsing both into one house code would erase that.
 *
 * The identity of the command is never authored here: commandId, target and
 * expected version come from the daemon's own affordance, and the envelope is
 * shaped by the generated builder so it cannot drift from the vocabulary.
 */

export interface GoalWithSourceCommandInput {
  readonly affordance: CommandAffordance<"goal.create_with_source">;
  readonly correlationId: string;
  readonly instructions: string;
  readonly requestDigest: string;
  readonly sessionCredential: string;
  readonly source: GoalSource;
  readonly title: string;
}

export type GoalWithSourceCommandResult =
  | CommandBuildResult
  | GoalBriefRefused
  | GoalSourceRefused;

/**
 * Build only from a daemon-issued affordance, the shared normalized brief, and
 * the shared bounded source. Callers compute `requestDigest` over the payload
 * this helper is about to produce; nothing about the command's authority is a
 * caller's to choose.
 */
export function buildGoalWithSourceCommand(
  input: GoalWithSourceCommandInput,
): GoalWithSourceCommandResult {
  const safe = copyOwnDataInput<GoalWithSourceCommandInput>(input);
  if (safe === null) return sharedInputRefusal(input);
  const {
    affordance, correlationId, requestDigest, sessionCredential, source, ...brief
  } = safe;
  // The brief is admitted from the REST of the record, so any key the caller
  // added - a goalId, a targetAggregateId, an actor - is an exact-keys failure
  // rather than a field that rides along unexamined.
  const admittedBrief = admitGoalBrief(brief);
  if (!admittedBrief.ok) return admittedBrief;
  const admittedSource = admitGoalSource(source);
  if (!admittedSource.ok) return admittedSource;
  // Exactly the members the daemon's vocabulary declares for this kind, in the
  // order it declares them, and nothing else.
  const payload = Object.freeze({
    instructions: admittedBrief.brief.instructions,
    source: Object.freeze({ ...admittedSource.source }),
    title: admittedBrief.brief.title,
  }) satisfies JsonObject;
  return GENERATED_COMMAND_BUILDERS["goal.create_with_source"](affordance, {
    correlationId,
    payload,
    requestDigest,
    sessionCredential,
  });
}
