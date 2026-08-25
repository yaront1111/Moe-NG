/**
 * Inputs only, for the expansion-request suites (task-738a12a816e8421a96edd84648565a38).
 *
 * NOTHING HERE HAND-BUILDS A HOLD, A BINDING OR A RUN. Every state below is produced by the
 * production reducer that owns it — `reduceExpansionPlanningHold`, `bindCurrentExpansionHold`,
 * `reducePlanningRun` — and this module only supplies their INPUTS and throws when one of them
 * refuses. A hand-folded state would let the ledger suites go green against bytes production
 * never emits, which is the exact defect the epic's rail 6 names.
 *
 * THE ONE HONEST EXCEPTION, STATED LOUDLY. `safeReleaseEvidence` is a test-authored
 * `ExpansionReleaseEvidence`. It is authored here because task-e62e3828df234c66969a99b8223487f4 —
 * the durable safe-release reader — is NOT on disk: measured at HEAD
 * cdc82ce2d316ae01a2ff97fe9f362a3333154d15, `apps/daemon/src/work/expansion-release-authority.ts`
 * does not exist and no daemon module imports `ExpansionReleaseEvidence` outside JSDoc. It is a
 * REDUCER INPUT for the ledger and codec suites, never authority: the production service path
 * refuses `EXPANSION_REQUEST_RELEASE_AUTHORITY_UNAVAILABLE` and cannot reach this value. When
 * e62 lands, its reader replaces this fixture at the service seam and nothing else changes.
 *
 * No `expect` and no assertion lives here. A fixture that judged an outcome would be a second
 * authority beside the one under test.
 */

import { reduceExpansionPlanningHold, reducePlanningRun } from "@moe/core";
import type {
  CreateExpansionHoldCommand,
  ExpansionPlanningHoldState,
  ExpansionReleaseEvidence,
  PlanningCreateDraftCommand,
} from "@moe/core";
import { bindCurrentExpansionHold } from "@moe/scheduler";

import type { ExpansionRunRecord } from "./expansion-request-records.js";

export const FIXTURE_PROJECT_ID = "project-1";
export const FIXTURE_GOAL_REF = "goal-1";
export const FIXTURE_PARENT_RUN_REF = "run-1";
export const FIXTURE_PARENT_NODE_REF = "dev-solo";
export const FIXTURE_GOAL_VERSION = 4;

export function hex64(seed: string): string {
  const base = seed.replace(/[^0-9a-f]/gu, "0");
  return (base + "0".repeat(64)).slice(0, 64);
}

/** Exactly the shape core's own `safeRelease` predicate demands, and no looser. */
export function safeReleaseEvidence(handoffDigest: string, handoffRef: string):
ExpansionReleaseEvidence {
  return {
    attemptRef: "attempt-1",
    attemptState: "RELEASED",
    disposition: {
      resumable: true,
      strongestReason: "WORK_RELEASE_OR_PAUSE",
      terminalTarget: "RELEASED",
    },
    effectsTerminal: true,
    handoff: { digest: handoffDigest, ref: handoffRef },
    leaseRef: "lease-1",
    leaseState: "RELEASED",
    observationRef: "observation-1",
    providerSlotRef: "slot-1",
    providerSlotState: "RELEASED",
    reason: "WORK_RELEASE_OR_PAUSE",
    receiptRef: "receipt-1",
    resourcesTerminal: true,
    safeBoundaryObserved: true,
    terminalEffectRefs: ["effect-1"],
    terminalResourceRefs: ["resource-1"],
    truthClass: "DAEMON_VERIFIED",
  };
}

export function holdCommandOf(
  overrides: Partial<CreateExpansionHoldCommand> = {},
): CreateExpansionHoldCommand {
  const digest = hex64("dd");
  const ref = "handoff-1";
  return {
    commandId: "cmd-expansion-1",
    deadline: 1_800_000,
    expectedVersion: 0,
    generation: 1,
    graphEpoch: 0,
    holdId: "hold-1",
    kind: "graph.request_expansion",
    parentNodeRef: FIXTURE_PARENT_NODE_REF,
    parentRevisionRef: "graph-revision-1",
    parentRunRef: FIXTURE_PARENT_RUN_REF,
    planningRunRef: "run-expansion-1",
    proposalBaseHash: hex64("ab"),
    rationale: { text: "the parent node needs a decomposition", truthClass: "AGENT_REPORTED" },
    release: safeReleaseEvidence(digest, ref),
    sourceFingerprint: hex64("cd"),
    workerHandoff: { digest, ref },
    ...overrides,
  };
}

/** Drives the REAL hold reducer; a refusal throws rather than degrading into a fixture. */
export function holdStateOf(
  command: CreateExpansionHoldCommand = holdCommandOf(),
): ExpansionPlanningHoldState {
  const verdict = reduceExpansionPlanningHold(undefined, command);
  if (!verdict.ok) throw new Error(`fixture hold refused: ${verdict.code}/${verdict.layer}`);
  return verdict.state;
}

/**
 * Binds through the PRODUCTION scheduler surface and drives the REAL planning-run reducer.
 * `goalVersion` is the only member the hold cannot supply — the hold carries no goal version —
 * so it is passed in exactly as the daemon passes its durable one.
 */
export function runRecordOf(
  hold: ExpansionPlanningHoldState,
  goalRef: string = FIXTURE_GOAL_REF,
  goalVersion: number = FIXTURE_GOAL_VERSION,
): ExpansionRunRecord {
  const bound = bindCurrentExpansionHold({
    currentAuthority: {
      goalVersion,
      graphEpoch: hold.graphEpoch,
      holdId: hold.holdId,
      holdVersion: hold.version,
      planningRunRef: hold.planningRunRef,
    },
    hold,
  });
  if (!bound.ok) {
    throw new Error(`fixture binding refused: ${bound.issues[0]?.code ?? "UNKNOWN"}`);
  }
  const command: PlanningCreateDraftCommand = {
    commandId: hold.creationReceipt.command.commandId,
    expansion: bound.binding,
    expectedVersion: 0,
    goalRef,
    kind: "planning.create_draft",
    runId: hold.planningRunRef,
    runKind: "EXPANSION",
  };
  const verdict = reducePlanningRun(undefined, command);
  if (!verdict.ok) throw new Error("fixture planning run refused");
  const state = verdict.state;
  if (state.runKind !== "EXPANSION") throw new Error("fixture planning run is not EXPANSION");
  return { command, state: state as ExpansionRunRecord["state"] };
}

/**
 * A TEST-ONLY release reader. It exists because the production seam
 * (`unavailableExpansionReleaseAuthority`) refuses by design while
 * task-e62e3828df234c66969a99b8223487f4 is absent, so the accepted path would otherwise be
 * unreachable and its reducers, binding and atomic commit would go unexercised.
 *
 * It is NOT a stand-in for authority and no production module can reach it: production exports
 * exactly one reader and that reader refuses. Suites that use this one prove the COMPOSITION —
 * that the real reducers, the real binding and the real two-leg commit fit together — while the
 * production-default arm proves that composition is unreachable until e62 lands.
 */
export function testOnlyReleaseAuthorityReader(
  handoffDigest: string = hex64("dd"),
  handoffRef = "handoff-1",
): (request: unknown) => {
    readonly ok: true;
    readonly release: ExpansionReleaseEvidence;
    readonly workerHandoff: { readonly digest: string; readonly ref: string };
  } {
  return () => ({
    ok: true as const,
    release: safeReleaseEvidence(handoffDigest, handoffRef),
    workerHandoff: { digest: handoffDigest, ref: handoffRef },
  });
}
