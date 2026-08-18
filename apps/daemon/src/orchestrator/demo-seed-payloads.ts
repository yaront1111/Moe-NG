import type { DemoSeedInput } from "./demo-seed-plan.js";

/**
 * The demo payloads: the exact shapes the durable pipeline admits for each J1 kind,
 * one function per command. Split out of `demo-seed-plan.ts` to keep both files under
 * the per-file target; the sequence and the envelope live there, the bodies here.
 *
 * Every ref is derived from the caller's ids, so nothing here is random and nothing is
 * a shared global that two demo projects would collide on.
 */

export const DEMO_VERIFIED = "DAEMON_VERIFIED" as const;
const DEMO_APPROVED = "HUMAN_APPROVED" as const;

/** A stable 64-hex ref derived from a label: demo evidence, deterministic by construction. */
function hex64(label: string): string {
  const base = label.replace(/[^0-9a-f]/gu, "0");
  return (base + "0".repeat(64)).slice(0, 64);
}


export function repositoryObservation(input: DemoSeedInput): Record<string, unknown> {
  return {
    baseRevisionHash: hex64("beef"),
    repositoryRef: `${input.projectId}-repo`,
    scopeRef: `${input.projectId}-scope`,
    truthClass: DEMO_VERIFIED,
  };
}

export function providerProfileRef(input: DemoSeedInput): string {
  return `${input.projectId}-provider-profile`;
}

/** The activation witness names the SAME minimum profile ref the probe committed. */
export function activationWitness(input: DemoSeedInput): Record<string, unknown> {
  return {
    artifactPathRef: `${input.projectId}-artifact`,
    backupPathRef: `${input.projectId}-backup`,
    credentialRef: `${input.projectId}-credential`,
    distributionManifestHash: hex64("cafe"),
    policyRevisionHash: hex64("face"),
    providerMinimumProfileRef: providerProfileRef(input),
    signingKeyRef: `${input.projectId}-signing`,
    storeDriverRef: `${input.projectId}-store-driver`,
    truthClass: DEMO_VERIFIED,
  };
}

/** The core planning-run commands that carry a fresh run to PLANNING and then propose. */
export function planningChain(input: DemoSeedInput): readonly Record<string, unknown>[] {
  return [
    {
      commandId: `${input.runId}-create`,
      expectedVersion: 0,
      goalRef: input.goalId,
      kind: "planning.create_draft",
      runId: input.runId,
      runKind: "INITIAL",
    },
    {
      commandId: `${input.runId}-ready`,
      expectedVersion: 1,
      kind: "planning.ready",
      witness: {
        acceptanceCriteriaRef: `${input.goalId}-criteria`,
        intentBaseRef: `${input.goalId}-intent`,
        planningBudgetRef: `${input.goalId}-budget`,
        truthClass: DEMO_VERIFIED,
      },
    },
    {
      commandId: `${input.runId}-claim`,
      expectedVersion: 2,
      kind: "planning.claim",
      witness: {
        attemptRef: `${input.runId}-attempt`,
        contextRef: `${input.runId}-context`,
        leaseRef: `${input.runId}-lease`,
        providerSlotRef: `${input.runId}-slot`,
        truthClass: DEMO_VERIFIED,
      },
    },
    {
      commandId: `${input.runId}-propose`,
      effectTerminalProof: {
        effectTerminalRef: `${input.runId}-effect-terminal`,
        resourcesTerminalRef: `${input.runId}-resources-terminal`,
        truthClass: DEMO_VERIFIED,
      },
      expectedVersion: 3,
      kind: "plan.propose",
      proposalKind: "INITIAL",
      submissionHash: hex64("dec0de"),
      witness: {
        attemptRef: `${input.runId}-attempt`,
        submissionRef: `${input.runId}-submission`,
        truthClass: DEMO_VERIFIED,
      },
    },
  ];
}

/** `expectedGoalVersion` is 1: `goal.create` leaves the goal at domain version 1. */
export function planningActivation(input: DemoSeedInput): Record<string, unknown> {
  return {
    activationRef: `${input.runId}-activation`,
    budgetHash: hex64("b0"),
    expectedGoalVersion: 1,
    goalDraftNoActiveRevision: true,
    graphHash: hex64("6a"),
    policyHash: hex64("b1"),
    qualityHash: hex64("dd"),
    truthClass: DEMO_APPROVED,
  };
}

export function approvalRecord(input: DemoSeedInput): Record<string, unknown> {
  return {
    actor: input.principalId,
    actorKind: "HUMAN",
    applicablePolicyRef: hex64("aa"),
    approvalRef: `${input.runId}-approval`,
    // The approved scope IS the demo node, so the node the operator wrote the
    // spec for is the node the approval covers.
    approvedNodeScope: [input.node.nodeRef],
    budgetRef: hex64("bb"),
    criteriaRef: hex64("cc"),
    decision: null,
    decisionReason: null,
    dependencyChanges: { additions: [], challenges: [], removals: [] },
    exactRevisionHash: hex64("dec0de"),
    lifecycle: "PENDING",
    planQualityAssessmentRef: hex64("dd"),
    policyDecisionRef: null,
    riskTier: "R2",
    stepUpAuthRef: `${input.runId}-stepup`,
    truthClass: DEMO_APPROVED,
    validity: "CURRENT",
  };
}
