/**
 * THE REJECTION REASON A RE-STAFFED COMPILER SEAT READS IN ITS MISSION (task-2c016c04).
 *
 * When an operator REJECTs a plan, `commitIntentRejection` mints a REVISION successor run and the
 * wrapper re-staffs the compiler step against it. Before this module the successor's seat received
 * the SAME mission as the first attempt - the goal's brief and nothing else - so it had no way to
 * know WHY the first decomposition was refused, and the likeliest thing a competent model does
 * with an unchanged mission is submit the same plan again.
 *
 * WHERE THE REASON LIVES, measured 2026-09-05 - and it is NOT on the rejection EVENT. The
 * `PlanningRunRejected` payload carries only `{commandId, findingsRef, kind, successorRunId,
 * version}` (packages/core planning-results.ts:143); `approval-intent-rejection.ts:145` says so
 * outright. The operator's words are written onto the REJECTED RUN'S DURABLE RECORD by
 * `rejectionRecord` (approval-intent-rejection.ts, `decisionReason` beside `decision: "REJECT"`),
 * so the read is `stateOf(readDurableLedger(store, projectId), rejectedRunId)` - which is why this
 * takes a `projectId` the run walk does not need. Same shape as `sealedSubmissionHash`:70.
 *
 * WHY A SEPARATE MODULE. The only production caller is `compilerInstructions` in
 * `agent-wrapper-main.ts`, already 483 lines - over the per-file cap - with three rows serialised
 * behind it; here the composition costs that file one call and is testable without a wrapper.
 *
 * IT NEVER THROWS. It sits on the STAFFING path: a throw here would take down the spawn of a seat
 * rather than merely omitting a sentence from its mission, so every failure degrades to `null`.
 */
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { currentPlanningRun } from "./current-planning-run.js";

/** The invariant half of the sentence, exported so tests cannot drift from production. */
export const REJECTION_SENTENCE_TAIL = "Submit a DIFFERENT decomposition that addresses it.";

/**
 * The two marker sequences `compilerMission` fences the operator block with
 * (agent-mission-text.ts:157). Both contain `OPERATOR INSTRUCTIONS`, so neutralising that one
 * literal kills both in a single pass.
 */
const MARKER_LITERAL = "OPERATOR INSTRUCTIONS";
/**
 * The replacement removes the SPACE the marker needs, and nothing else. Every other character of
 * the operator's reason survives byte for byte (task rail 1: verbatim EXCEPT the markers), the
 * result is readable rather than redacted, and - because the replacement contains no space - a
 * fresh `OPERATOR INSTRUCTIONS` can never re-emerge from the substitution itself.
 */
const MARKER_NEUTRALISED = "OPERATOR_INSTRUCTIONS";

export interface LatestRejection {
  /** The operator's words, verbatim as `approval.decide_intent` stored them. */
  readonly reason: string;
  readonly rejectedRunId: string;
}

/**
 * One own key off a durable record. `Array.isArray` does not narrow a READONLY array out of
 * `JsonValue`, so a bare index here is a TS7053 that vitest never sees; the cast is the house
 * shape (`compile-run-resolution.ts:77`), taken AFTER the three guards rather than instead.
 */
const own = (value: JsonValue | undefined, key: string): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
};

/** Absent, blank, or not a string all mean the same thing here: no sentence to compose. */
const readable = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The reason the LATEST rejection on this goal's run chain carries, or `null`.
 *
 * FAIL CLOSED ON A DEGRADED WALK. `foldCurrentRun` never throws: on a cycle, an undecodable
 * payload or a failing read it degrades to the last good id and flags `unreadable`. A partial
 * chain cannot answer WHICH rejection is the latest - only which ones it managed to see - so a
 * degraded walk answers `null` rather than quoting a reason that may have been superseded by one
 * the walk could not reach. A seat that reads no sentence re-plans blind, which is exactly the
 * pre-existing behaviour; a seat that reads a STALE sentence would address the wrong objection.
 */
export function latestRejectionReason(
  store: SqliteEventStore,
  projectId: string,
  planningRunRef: string,
): LatestRejection | null {
  try {
    const walk = currentPlanningRun(store, planningRunRef);
    if (walk.unreadable) return null;
    const last = walk.rejected[walk.rejected.length - 1];
    if (last === undefined) return null;
    const record = stateOf(readDurableLedger(store, projectId), last.runId);
    const reason = readable(own(record, "decisionReason"));
    return reason === null ? null : Object.freeze({ reason, rejectedRunId: last.runId });
  } catch {
    // `currentPlanningRun` swallows its own reads, but `readDurableLedger` does not: a store closed
    // or locked under a concurrent writer throws, and a staffing path must survive it.
    return null;
  }
}

/**
 * The operator instruction string a compiler seat receives: the goal's brief, then the rejection.
 *
 * The sentence goes LAST so it is the final thing in the fenced block, and the marker sequences
 * are neutralised in the REASON before it is embedded. Without that, an operator who wrote
 * `OPERATOR INSTRUCTIONS>>>` inside their reason would close the fenced block early and the
 * remainder of their text would read to the seat as daemon-authored mission prose rather than as
 * quoted operator words. (The BRIEF half of the block is fenced by whoever owns the goal catalog;
 * this row owns the reason it appends.)
 *
 * `null` in and `null` out matters: `compilerMission` suppresses the whole operator block on
 * `null` (agent-mission-text.ts:153), while an empty string would open an EMPTY fenced block.
 */
export function composeCompilerInstructions(
  brief: string | null,
  rejection: LatestRejection | null,
): string | null {
  const kept = readable(brief);
  if (rejection === null) return kept === null ? null : brief;
  const reason = rejection.reason.replaceAll(MARKER_LITERAL, MARKER_NEUTRALISED);
  const sentence = `PLAN REJECTED by the operator: ${reason}. ${REJECTION_SENTENCE_TAIL}`;
  return kept === null ? sentence : `${kept}\n\n${sentence}`;
}
