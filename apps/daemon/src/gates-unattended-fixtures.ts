/**
 * THE UNATTENDED WORLD -- the journey of `gates-journey-fixtures.ts` with the operator's standing
 * auto-approval opt-ins INSTALLED, so Gate 2 and Gate 3 close on machine evidence. `journeyWorld`
 * is CALLED, never reimplemented, so an unattended arm and a human one differ only in what this
 * module installed.
 *
 * THE OPT-IN MUST BE ON THE LAST INSTALLED SLICE OR IT IS NOT IN FORCE. `foldSlices`
 * (policy-composition.ts:132-170) returns the LAST slice's `autoApprovalOptIns` and both gate
 * modules select the newest installed EVALUATION slice, so an opt-in on an earlier slice silently
 * does nothing and every arm built on it is vacuous. `installGateOptIns` therefore installs ONE
 * slice carrying BOTH gate actions, and it is the last install a world performs. The action
 * strings are read from the kind constants, never hand-typed.
 *
 * THE TWO GATES GROUND THEIR SUBJECT TIER DIFFERENTLY, and a fixture that pretended otherwise
 * would test one of them twice. Gate 2's tier is the operator's durable `readPolicyRisk`
 * classification for `preview.decide`, joined on the current ACTIVE GRAPH. Gate 3's is the goal's
 * replay-verified PLANNING-RUN tier through `readRunPolicyEvaluation` (this journey's run
 * evaluates to R1), which an operator RAISES through the slice's own `riskClassifications`.
 *
 * NOTHING HERE DECIDES. No tier is derived, ranked or compared; no opt-in is matched. Every
 * judgement stays in `@moe/core` and in the two production gate modules.
 */
import { derivePolicySliceDigest } from "@moe/core";
import type { PolicyAutoApprovalTier, PolicyRiskTier } from "@moe/core";
import { expect } from "vitest";

import { readDurableLedger, versionOf } from "./bootstrap/bootstrap-ledger.js";
import { envelope, send } from "./bootstrap/bootstrap-test-fixtures.js";
import {
  POLICY_RISK_EVENT_TYPE, buildPolicyRiskRecord, policyRiskAggregateIdFor,
} from "./bootstrap/policy-risk-record.js";
import { readCriterionGoal } from "./criterion-evidence/criterion-goal.js";
import {
  BASE, DECIDED_AT, GOAL_ID, PROJECT_ID, dossierFacts, journeyWorld,
} from "./gates-journey-fixtures.js";
import type { DesignStep, JourneyWorld } from "./gates-journey-fixtures.js";
import type { CommandHandlerInput } from "./http/http-contract.js";
import { readRunGoalPublication } from "./http/run-goal-publication.js";
import {
  graphRevisionAggregateId, readCurrentActiveGraph,
} from "./planning/active-graph-projection.js";
import { putGraphBody } from "./planning/graph-body-record.js";
import { PRIMARY, activePathFor } from "./planning/graph-query-test-fixtures.js";
import { OPERATOR } from "./planning/plan-reject-test-fixtures.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview/preview-contracts.js";
import {
  previewAutoCommandId, resolvePreviewAutoDecision,
} from "./preview/preview-auto-composition.js";
import type { PreviewAutoDecision } from "./preview/preview-auto-decision.js";
import { readPreviewDecision } from "./preview/preview-decision-record.js";
import { previewReceiptId } from "./preview/preview-receipt-contracts.js";
import type { PreviewReceiptV1 } from "./preview/preview-receipt-contracts.js";
import { readGoalLandingStatus } from "./preview/preview-goal-landing.js";
import { readPreviewReceipt } from "./preview/preview-ledger.js";
import { createPreviewStartHandler } from "./preview/preview-start-command.js";
import type { PreviewSupervisor } from "./preview/preview-supervisor.js";
import type { ReleaseAutoDecideDeps, ReleaseAutoOutcome } from "./release/release-auto-decide.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release/release-decide-contracts.js";
import { releaseDossierAggregateId } from "./release/release-dossier-contracts.js";
import { readPublishLedger, recordPublishReceipt } from "./repository/publish-ledger.js";

const ENCODER = new TextEncoder();
let installs = 0;

/** One standing declaration. `tier` is `PolicyAutoApprovalTier`, so the COMPILER refuses an R2 or
 *  R3 opt-in here -- the fence is type-level, not a runtime check this module writes. */
export interface GateOptIn {
  readonly action: string;
  readonly tier: PolicyAutoApprovalTier;
}

export interface GateClassification {
  readonly factId: string;
  readonly tier: PolicyRiskTier;
}

/** The fact id `evaluateReleaseAutoApproval` composes for this goal's planning run. DERIVED
 *  through the same reader production uses, so a classification addresses the real subject. */
export function releaseRunFactId(world: JourneyWorld): string {
  const goal = readCriterionGoal(world.store, PROJECT_ID, GOAL_ID);
  if (!goal.ok) throw new Error(`the journey goal is unreadable: ${goal.code}`);
  const runId = goal.graph.planningRunRef;
  if (runId === undefined || runId === "") {
    throw new Error("the journey goal carries no planning run to classify");
  }
  return `release.run_policy_tier:${runId}`;
}

/**
 * Installs ONE EVALUATION slice through the PRODUCTION `policy.install` command. The digest is
 * DERIVED, never spelled, so the ref genuinely addresses the bytes. Returns the slice ref, which
 * is what an approval NAMES as the authority it acted under.
 */
export function installGateOptIns(
  world: JourneyWorld,
  optIns: readonly GateOptIn[],
  riskClassifications: readonly GateClassification[] = [],
): string {
  const body = {
    autoApprovalOptIns: optIns, riskClassifications, rules: [],
    sliceRef: `pending-gates-unattended-${String(installs += 1)}`,
  };
  const digest = derivePolicySliceDigest(body);
  if (!digest.ok) throw new Error(`opt-in slice fixture is invalid: ${digest.code}`);
  const slice = { ...body, sliceRef: digest.digest };
  const version = versionOf(readDurableLedger(world.store, PROJECT_ID), `${PROJECT_ID}-policy`);
  const outcome = send(world.store, envelope(
    "policy.install", version, { slice }, `cmd-install-gates-unattended-${String(installs)}`,
  ));
  if (!outcome.ok) throw new Error(`opt-in policy install refused: ${outcome.code}`);
  return digest.digest;
}

/**
 * AN ACTIVE GRAPH REVISION, which the journey's plan approval does not leave behind: it compiles
 * a graph (`activeCompiledGraphs` finds it) but writes no GRAPH REVISION, and those are different
 * projections. MEASURED, not assumed -- without this `readCurrentActiveGraph` answers
 * ACTIVE_GRAPH_ABSENT, `readPolicyRisk`'s fifth gate has nothing to join on, every risk record
 * answers POLICY_RISK_SUBJECT_STALE and Gate 2's fact stays null-tier UNKNOWN.
 */
function seedActiveGraph(world: JourneyWorld): void {
  const revisionId = "graph-revision-gates-unattended";
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  const commandId = `seed-${revisionId}`;
  world.store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(commandId),
    commandId,
    committedAt: DECIDED_AT,
    events: activePathFor(revisionId, PRIMARY).map((event, index) => ({
      eventId: `${commandId}-${String(index)}`,
      eventType: event.kind,
      payload: ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: world.store.getAggregateVersion(aggregateId),
  });
  const body = putGraphBody(world.store, PROJECT_ID, PRIMARY);
  if (!body.ok) throw new Error(`graph body fixture refused: ${body.code}`);
}

/**
 * The operator's durable risk classification for a gate action: the only thing that can ground
 * Gate 2's tier, and HUMAN_APPROVED by `readPolicyRisk`'s own contract. Joined on the CURRENT
 * ACTIVE GRAPH -- without that join every record answers POLICY_RISK_SUBJECT_STALE, the fact stays
 * null-tier UNKNOWN, and the evaluation folds to HOLD_UNKNOWN.
 */
export function seedGatePolicyRisk(
  world: JourneyWorld, tier: PolicyRiskTier, action: string = PREVIEW_DECIDE_COMMAND_KIND,
): void {
  const active = readCurrentActiveGraph(world.store, PROJECT_ID);
  if (!active.ok) throw new Error(`the journey world has no active graph: ${active.code}`);
  const record = {
    actionKind: action, approvedBy: OPERATOR, assessedAt: DECIDED_AT,
    decisionRef: `decision-unattended-${action}-${tier}`, projectId: PROJECT_ID,
    subjectRef: active.graphContentHash, subjectRevision: active.graphEpoch, tier,
  };
  const built = buildPolicyRiskRecord(record);
  if (!built.ok) throw new Error(`policy risk fixture refused: ${built.code}`);
  const aggregateId = policyRiskAggregateIdFor(record);
  world.store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`seed-${record.decisionRef}`),
    commandId: `seed-${record.decisionRef}`,
    committedAt: DECIDED_AT,
    events: [{
      eventId: `event-${record.decisionRef}`, eventType: POLICY_RISK_EVENT_TYPE,
      payload: built.bytes,
    }],
    expectedVersion: world.store.getAggregateVersion(aggregateId),
  });
}

export interface UnattendedOptions {
  /** Which design step the journey took. Defaults to an AUTHORED design. */
  readonly design?: DesignStep;
  /** The ceiling the operator's standing opt-in covers, for BOTH gate actions. Defaults to R1. */
  readonly optInTier?: PolicyAutoApprovalTier;
  /** The tier the SUBJECT carries. R2 and R3 drive the human-only negatives; they are refused by
   *  the engine, never by anything this module writes. Defaults to R0. */
  readonly subjectTier?: PolicyRiskTier;
}

/**
 * The journey world with the operator's opt-ins in force -- ONE helper for the R0/R1, R2/R3 and
 * gap cases, because the only thing that varies between them is the tier each gate's subject
 * carries and whether the release evidence binds.
 *
 * ORDER MATTERS: the policy install is LAST, so it is the slice `foldSlices` folds to and the
 * newest EVALUATION slice both gate modules select.
 */
export function unattendedWorld(options: UnattendedOptions = {}): JourneyWorld {
  const subjectTier = options.subjectTier ?? "R0";
  const optInTier = options.optInTier ?? "R1";
  const world = journeyWorld(options.design ?? "SUBMITTED");
  seedActiveGraph(world);
  seedGatePolicyRisk(world, subjectTier);
  // Gate 3's subject is the planning run's own tier (R1 in this journey). It is RAISED to R2/R3
  // through the slice's classifications, which is the operator-facing mechanism and the same fold
  // `assessRisk` applies in production; an R0/R1 world leaves the run's own tier alone.
  const classifications = subjectTier === "R2" || subjectTier === "R3"
    ? [{ factId: releaseRunFactId(world), tier: subjectTier }]
    : [];
  installGateOptIns(world, [
    { action: PREVIEW_DECIDE_COMMAND_KIND, tier: optInTier },
    { action: RELEASE_DECIDE_COMMAND_KIND, tier: optInTier },
  ], classifications);
  return world;
}

/** A supervisor that writes no process. `start` answers the receipt the journey already recorded,
 *  so `preview.start` reaches its REPLAY branch -- the branch child B fixed so the gate is still
 *  offered to the automatic path on a retry. */
function stubSupervisor(receipt: PreviewReceiptV1): PreviewSupervisor {
  return Object.freeze({
    active: () => [],
    close: async (): Promise<void> => undefined,
    decide: async (): Promise<boolean> => true,
    start: async (): Promise<{ readonly ok: true; readonly receipt: PreviewReceiptV1 }> =>
      ({ ok: true as const, receipt }),
  }) as unknown as PreviewSupervisor;
}

/**
 * Drives the PRODUCTION `preview.start` handler -- the seam Gate 2's automatic decision hangs off.
 * Returns the receipt id the automatic decision, if any, was taken against.
 */
export async function startPreviewUnattended(world: JourneyWorld): Promise<string> {
  const receiptId = previewReceiptId(PROJECT_ID, GOAL_ID, world.sha);
  const read = readPreviewReceipt(world.store, PROJECT_ID, receiptId);
  if (!read.ok) throw new Error(`the journey recorded no preview receipt: ${read.code}`);
  const handler = createPreviewStartHandler({
    clock: () => DECIDED_AT, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID,
    store: world.store, supervisor: stubSupervisor(read.receipt),
    workspace: "D:/fixture-workspace",
  });
  await handler({
    envelope: { commandId: "cmd-unattended-preview-start", payload: {
      goalId: GOAL_ID, sha: world.sha,
    } },
    principal: { capabilities: ["review.write"], principalId: OPERATOR, projectId: PROJECT_ID },
  } as unknown as CommandHandlerInput);
  return receiptId;
}

/**
 * WHY the automatic path decided as it did, from the PRODUCTION composition over this world. The
 * journey seam is silent about a declination by design -- `autoDecide` returns and the gate stays
 * pending -- so an arm that only saw the absence could not say WHICH condition answered. This is
 * the same call `preview-start-command.ts` makes, on the same store.
 */
export function resolveUnattendedPreview(world: JourneyWorld): PreviewAutoDecision {
  const read = readPreviewReceipt(
    world.store, PROJECT_ID, previewReceiptId(PROJECT_ID, GOAL_ID, world.sha),
  );
  if (!read.ok) throw new Error(`the journey recorded no preview receipt: ${read.code}`);
  return resolvePreviewAutoDecision({
    decidedAt: DECIDED_AT, principalId: OPERATOR, projectId: PROJECT_ID, receipt: read.receipt,
    store: world.store,
  });
}

/** The decision the AUTOMATIC path committed, read through the production decision reader under
 *  the deterministic automatic command id. A human's decision carries a different id. */
export function autoPreviewDecision(
  world: JourneyWorld, receiptId: string,
): ReturnType<typeof readPreviewDecision> {
  return readPreviewDecision(
    world.store, PROJECT_ID, OPERATOR, previewAutoCommandId(PROJECT_ID, receiptId),
  );
}

/** A node ref the goal actually landed. `preview.decide` REJECT findings are validated against
 *  `readGoalLandingStatus().nodes`, so a hand-spelled ref refuses PREVIEW_DECISION_INVALID and an
 *  arm meaning to test precedence would instead be testing its own typo. */
export function landedNodeRef(world: JourneyWorld): string {
  const landing = readGoalLandingStatus(world.store, PROJECT_ID, GOAL_ID);
  const nodeRef = landing.nodes[0];
  if (nodeRef === undefined) throw new Error("the journey goal landed no node to cite");
  return nodeRef;
}

/** Records the PUSHED publish receipt the reconciler's candidate scan reads. Without it there is
 *  no candidate at all and every release arm would be vacuous, so the outcome is ASSERTED. */
export function markPushed(world: JourneyWorld, sha: string = world.sha): void {
  const request = readPublishLedger(world.store, PROJECT_ID).get(GOAL_ID)?.requests.at(-1);
  if (request === undefined) throw new Error("the journey recorded no publish request to push");
  const recorded = recordPublishReceipt(world.store, {
    branch: BASE, decidedAt: DECIDED_AT, decisionId: request.decisionId, goalId: GOAL_ID,
    projectId: PROJECT_ID, refusal: null, remoteUrl: request.remoteUrl, sha,
    url: `${request.remoteUrl}/tree/${BASE}`,
  });
  if (!recorded.ok) throw new Error(`publish receipt fixture refused: ${recorded.code}`);
  expect(readRunGoalPublication(
    world.store, PROJECT_ID, readPublishLedger(world.store, PROJECT_ID).get(GOAL_ID),
  )?.outcome).toBe("PUSHED");
}

/** Gate 3's reconciler dependencies over this world. The registry is the one the journey already
 *  composed: a second composition would mint a second pull-request port. */
export function releaseAutoDepsOver(
  world: JourneyWorld, over: Partial<ReleaseAutoDecideDeps> = {},
): ReleaseAutoDecideDeps {
  return {
    base: BASE, clock: () => DECIDED_AT, dossierFacts: dossierFacts(world.store),
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, registry: world.deps.registry,
    store: world.store, ...over,
  };
}

/** How many `release.decide` decisions this goal's release aggregate holds. ONE is what an
 *  unattended run must leave: a second would mean the reconciler dispatched twice, or that a human
 *  decision is hiding behind the automatic one. Read from the aggregate's own events, not from a
 *  count the test keeps. */
export function releaseDecidedCount(world: JourneyWorld): number {
  let decided = 0;
  for (const event of world.store.readEvents(releaseDossierAggregateId(GOAL_ID))) {
    if (event.eventType === "ReleaseCommandDecided") decided += 1;
  }
  return decided;
}

/** Exactly one candidate, or the arm is not testing what it says. */
export function onlyOutcome(answers: readonly ReleaseAutoOutcome[]): ReleaseAutoOutcome {
  if (answers.length !== 1) {
    throw new Error(`expected exactly one candidate, got ${String(answers.length)}`);
  }
  return answers[0] as ReleaseAutoOutcome;
}
