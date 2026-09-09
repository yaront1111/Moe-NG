/**
 * WHICH RUN A `planning.submit_decomposition` COMPILES ONTO, and what its aggregate head already
 * is when the compile starts (task-4595697e).
 *
 * The goal's durable record carries ONE immutable `planningRunRef`, so `validateRevisionProvenance`
 * always answers the run the goal was CREATED with. Once that run is REJECTED the run that matters
 * is its SUCCESSOR, and resolving it is what lets a REVISION plan be submitted at all.
 *
 * This lives beside the dispatcher rather than inside it so the dispatcher stays under the
 * per-file cap: it takes a store and a ref and answers a target, and knows nothing about
 * submission payloads, gates or compiled authority.
 */
import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { planningStateFromDurableRecord } from "./approval-gate.js";
import { currentPlanningRun } from "./current-planning-run.js";

export interface CompileRunTarget {
  /** The aggregate head this run ALREADY has before the compile writes anything. */
  readonly baseVersion: number;
  readonly runId: string;
  readonly runKind: "INITIAL" | "REVISION";
}

/**
 * The goal's current planning run and its compile arithmetic, or `null` when the walk was stale.
 *
 * FAIL CLOSED ON `unreadable`. `foldCurrentRun` never throws and never loops: on a cycle, an
 * undecodable payload or a failing read it degrades to the LAST GOOD id and flags `unreadable`.
 * That is the right answer for a READ path — a stale run id beats taking a screen down — but it is
 * the wrong answer for a WRITE: compiling onto a last-good id would seal a plan onto a run this
 * walk could not actually resolve, and the resulting authority would look exactly like a plan the
 * operator asked for. So a stale walk refuses here instead of guessing.
 *
 * `baseVersion` is 1 for a REVISION because `commitIntentRejection` (approval-intent-rejection.ts,
 * the `successorLeg`) commits the successor as an `extraLegs` leg of the REJECTION's decision
 * carrying EXACTLY ONE `PlanningRunCreated` draft at `expectedVersion: 0`. A REVISION run's head
 * is therefore already 1 before this compile starts, while an INITIAL run's is 0. That coupling is
 * pinned by `compile-dispatcher-revision.test.ts`, which asserts the successor's event stream is
 * exactly ["PlanningRunCreated"] before submitting — so a producer that changed the successor's
 * mint reds a test rather than silently shifting this arithmetic.
 */
export function resolveCompileRun(
  store: SqliteEventStore,
  planningRunRef: string,
): CompileRunTarget | null {
  const current = currentPlanningRun(store, planningRunRef);
  if (current.unreadable) return null;
  const initial = current.hops === 0;
  return Object.freeze({
    baseVersion: initial ? 0 : 1,
    runId: current.runId,
    runKind: initial ? ("INITIAL" as const) : ("REVISION" as const),
  });
}

/**
 * The submission hash this run has ALREADY sealed, or `null` when no durable record answers.
 *
 * Read so the dispatcher's replay branch can tell a genuine crash-restart re-dispatch from a
 * DIFFERENT plan arriving under the same derived command ids. Without it the replay branch
 * short-circuits before any leg is dispatched and answers `ok` carrying the hashes of the
 * structure just submitted — a plan that was never sealed on the run — so the store's own
 * command-bytes conflict never gets to see it. Measured 2026-09-05: a resubmission whose node
 * roster differed came back REPLAYED with a submissionHash the run had never held.
 */
export function sealedSubmissionHash(
  store: SqliteEventStore,
  projectId: string,
  runId: string,
): string | null {
  const state = planningStateFromDurableRecord(stateOf(readDurableLedger(store, projectId), runId));
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const hash = (state as Record<string, unknown>)["submissionHash"];
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/** One derived identity family per approved revision: restartable by construction. */
// Keyed on the revision AND the run: an approved revision is keyed by the PRD's content sha,
// so two goals over the same PRD compile the same revision, and event ids keyed on the digest
// alone collided (DURABLE_ID_CONFLICT on the second goal's first submit, measured 2026-09-03
// on UnAI with a real planning seat). The run is the goal's own — which is why resolving the
// successor here is all it takes for a REVISION compile's ids to differ from the original's.
export function idsOf(revisionDigest: string, runId: string): Record<string, string> {
  const stem = `compile-${revisionDigest.slice(0, 12)}-${createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 8)}`;
  return {
    claim: `${stem}-claim`, create: `${stem}-create`, finalize: `${stem}-finalize`,
    propose: `${stem}-propose`, ready: `${stem}-ready`, stem,
  };
}
