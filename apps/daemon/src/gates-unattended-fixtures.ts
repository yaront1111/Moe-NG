/**
 * THE UNATTENDED WORLD -- the journey of `gates-journey-fixtures.ts` with the operator's standing
 * auto-approval opt-ins INSTALLED, so Gate 2 and Gate 3 close on machine evidence. `journeyWorld`
 * is CALLED, never reimplemented, so an unattended arm and a human one differ only in what this
 * module installed.
 *
 * THE OPT-IN MUST BE THE ONLY DECLARATION SINCE THE LAST RESET OR IT IS NOT IN FORCE. Both gates
 * ask `selectEffectiveAutoApprovalPolicy` (bootstrap/effective-auto-policy.ts) which policy is
 * effective: an install declaring NO opt-ins RESETS automation and clears older declarations, and
 * two declarations standing after the most recent reset refuse fail-closed. The seeded world's
 * EVALUATION slices all carry `autoApprovalOptIns: []`, so they are resets — which is exactly why
 * `installGateOptIns` installs ONE slice carrying BOTH gate actions after them, and why installing
 * a SECOND declaring slice would make a world refuse rather than double-arm it. An opt-in buried
 * under a later install silently does nothing and every arm built on it is vacuous. The action
 * strings are read from the kind constants, never hand-typed.
 *
 * BOTH GATES NOW GROUND THEIR SUBJECT TIER THE SAME WAY, AND THIS MODULE NO LONGER SEEDS ONE.
 * It used to INSERT the preview gate's `readPolicyRisk` record by hand, joined on a graph
 * revision it also fabricated, because the ordinary journey leaves neither behind -- which meant
 * Gate 2 was proven against a world production never produces, and on every real project it
 * reached RISK_TIER_UNCLASSIFIABLE. Both gates now read the goal's replay-verified PLANNING-RUN
 * tier: Gate 3 through `release-auto-approval.ts`, Gate 2 through `preview/preview-risk-fact.ts`.
 * This journey's run evaluates to R1, so R1 is the tier both gates see with nothing installed.
 *
 * AN ELEVATED SUBJECT IS RAISED THROUGH THE SLICE'S OWN `riskClassifications`, which is the
 * operator-facing mechanism and the same fold `assessRisk` applies in production. It can only
 * RAISE (`maxTier`), so R0 is not reachable on this journey and `UnattendedOptions.subjectTier`
 * excludes it at the TYPE level rather than accepting it and silently doing nothing. Each gate
 * has its OWN fact id, so an elevated world installs BOTH -- `previewRunFactId` and
 * `releaseRunFactId`, each DERIVED through the reader production uses.
 *
 * NOTHING HERE DECIDES. No tier is derived, ranked or compared; no opt-in is matched. Every
 * judgement stays in `@moe/core` and in the two production gate modules.
 */
import { derivePolicySliceDigest } from "@moe/core";
import type { PolicyAutoApprovalTier, PolicyRiskTier } from "@moe/core";
import { expect } from "vitest";

import { readDurableLedger, versionOf } from "./bootstrap/bootstrap-ledger.js";
import { envelope, send } from "./bootstrap/bootstrap-test-fixtures.js";
import { readCriterionGoal } from "./criterion-evidence/criterion-goal.js";
import {
  BASE, DECIDED_AT, GOAL_ID, PROJECT_ID, dossierFacts, journeyWorld,
} from "./gates-journey-fixtures.js";
import type { DesignStep, JourneyWorld } from "./gates-journey-fixtures.js";
import type { CommandHandlerInput } from "./http/http-contract.js";
import { readRunGoalPublication } from "./http/run-goal-publication.js";
import { OPERATOR } from "./planning/plan-reject-test-fixtures.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview/preview-contracts.js";
import {
  previewAutoCommandId, resolvePreviewAutoDecision,
} from "./preview/preview-auto-composition.js";
import type { PreviewAutoDecision } from "./preview/preview-auto-decision.js";
import { previewRunRiskFactId, resolvePreviewRiskFact } from "./preview/preview-risk-fact.js";
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

/** This goal's planning run, read through the reader BOTH gates use. Shared by the two fact-id
 *  derivations below so neither can address a run the goal does not actually carry. */
function journeyRunId(world: JourneyWorld): string {
  const goal = readCriterionGoal(world.store, PROJECT_ID, GOAL_ID);
  if (!goal.ok) throw new Error(`the journey goal is unreadable: ${goal.code}`);
  const runId = goal.graph.planningRunRef;
  if (runId === undefined || runId === "") {
    throw new Error("the journey goal carries no planning run to classify");
  }
  return runId;
}

/** The fact id `evaluateReleaseAutoApproval` composes for this goal's planning run. DERIVED
 *  through the same reader production uses, so a classification addresses the real subject. */
export function releaseRunFactId(world: JourneyWorld): string {
  return `release.run_policy_tier:${journeyRunId(world)}`;
}

/** The fact id `resolvePreviewRiskFact` composes for the SAME run. Taken from the PRODUCTION
 *  `previewRunRiskFactId`, never spelled here, so a classification cannot address a name the
 *  gate stopped using -- which would leave an elevated-subject arm silently testing R1. */
export function previewRunFactId(world: JourneyWorld): string {
  return previewRunRiskFactId(journeyRunId(world));
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

/** The tier this journey's own planning run evaluates to, MEASURED at HEAD f6e97a6b: run-1's
 *  replay-verified `PolicyEvaluated` row is R1, produced by `plan.finalize`. It is the tier BOTH
 *  gates see with no classification installed, and it is ASSERTED below rather than assumed. */
export const JOURNEY_SUBJECT_TIER = "R1" as const;

export interface UnattendedOptions {
  /** Which design step the journey took. Defaults to an AUTHORED design. */
  readonly design?: DesignStep;
  /** The ceiling the operator's standing opt-in covers, for BOTH gate actions. Defaults to R1. */
  readonly optInTier?: PolicyAutoApprovalTier;
  /**
   * The tier the SUBJECT carries. R2 and R3 drive the human-only negatives; they are refused by
   * the engine, never by anything this module writes. Defaults to the journey's own R1.
   *
   * R0 IS EXCLUDED AT THE TYPE LEVEL, not omitted by oversight. A `riskClassifications` entry can
   * only RAISE a tier (`assessRisk` takes `maxTier(fact.tier, declared)`), so asking for R0 on a
   * journey whose run evaluates to R1 would silently hand back an R1 world and every arm built on
   * it would be testing something other than what it says. The COMPILER refuses it instead.
   */
  readonly subjectTier?: Exclude<PolicyRiskTier, "R0">;
}

/**
 * The journey world with the operator's opt-ins in force -- ONE helper for the R1, R2/R3 and gap
 * cases, because the only thing that varies between them is the tier each gate's subject carries
 * and whether the release evidence binds.
 *
 * ORDER MATTERS: the policy install is LAST, so it is the one declaration standing after the
 * seed's own opt-in-free installs, and therefore the policy `selectEffectiveAutoApprovalPolicy`
 * hands to BOTH gates.
 *
 * NOTHING IS SEEDED. The journey's own planning-run evaluation is the evidence both gates read,
 * so a world built here contains no record production would not have written. The R1 default is
 * ASSERTED through the production resolver before the elevated classifications are chosen: if the
 * journey's graph or its evaluator ever moved that tier, this throws here instead of leaving the
 * R2/R3 arms quietly classifying against an already-elevated subject.
 */
export function unattendedWorld(options: UnattendedOptions = {}): JourneyWorld {
  const subjectTier = options.subjectTier ?? JOURNEY_SUBJECT_TIER;
  const optInTier = options.optInTier ?? "R1";
  const world = journeyWorld(options.design ?? "SUBMITTED");
  const resolved = resolvePreviewRiskFact(world.store, PROJECT_ID, GOAL_ID);
  expect({ code: resolved.code, tier: resolved.fact.tier, truthClass: resolved.fact.truthClass })
    .toEqual({ code: null, tier: JOURNEY_SUBJECT_TIER, truthClass: "DAEMON_VERIFIED" });
  // Each gate reads its OWN fact id off the SAME durable row, so an elevated subject installs
  // BOTH. This is the operator-facing mechanism and the same fold `assessRisk` applies in
  // production; an R1 world installs nothing and leaves the run's own tier alone.
  const classifications: readonly GateClassification[] =
    subjectTier === "R2" || subjectTier === "R3"
      ? [
        { factId: previewRunFactId(world), tier: subjectTier },
        { factId: releaseRunFactId(world), tier: subjectTier },
      ]
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
