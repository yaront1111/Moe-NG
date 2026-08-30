import type { JsonObject } from "@moe/contracts";

/**
 * THE CALLER HALF OF EVERY COMMAND THIS BOARD MAY AUTHOR.
 *
 * Split out of live-dispatch.ts, which now holds only the dispatch seam: this module decides
 * WHAT is sent for one offered target, that one decides how it is built, credentialled and
 * answered. Nothing here reads a surface, a transport or a clock - `payloadFor` is a pure
 * function of the offer's own identity, the step's version and the daemon's run -> goal binding,
 * which is what lets both the render-time predicate and the click path ask it the same question.
 */

// Shapes mirror the daemon's committed J1 fixtures (bootstrap-test-fixtures.ts)
// on the live default subjects the affordance surface derives versions for.
const hex64 = (seed: string): string =>
  (seed.replace(/[^0-9a-f]/gu, "0") + "0".repeat(64)).slice(0, 64);

// THE IDENTITIES ARE THE DAEMON'S, NOT THIS MODULE'S. There is no build-time run or goal
// subject here any more: the daemon offers plan.propose / approval.decide / goal.close once per
// durable goal, and every payload below is authored against the identity its OFFER carries. The
// demo seed's subjects survive only as one goal among many, arriving through that same offer.
// Known-answer digest of the exact policy slice below under moe.policy.slice.content.v1. The
// daemon independently recomputes it at install; parity tests pin this browser constant to the
// core producer without pulling Node's synchronous crypto implementation into the bundle.
//
// ROTATED BY task-a888038d, along with the slice it names. The daemon's finalize terminal now
// derives the sealed graph's node-property fact ids and REFUSES the seal when no installed policy
// classifies them, so the empty slice this board used to install would have left every proposal
// stuck one command short of approval. The four ids below are the production derivation over the
// same journey graph `GRAPH_CONTENT_BYTES` carries, so this table and the daemon's demo seed
// install byte-identical slices at the same address.
// Pre-rotation: e7a5ee19…963a, over `{autoApprovalOptIns: [], rules: []}`.
const POLICY_REF = "fff1cc915b3ed86b2e992c8b896f1abcdc7b8d98ea1eb196ceebd45cadd0290e";
const RISK_CLASSIFICATIONS = [
  { factId: "node.capability:capability-implement", tier: "R1" },
  { factId: "node.read_scope:services/api/src", tier: "R0" },
  { factId: "node.resource:resource-a", tier: "R0" },
  { factId: "node.write_scope:services/api/src/node", tier: "R2" },
];
const GRAPH_REVISION_REF = "graph-revision-1";
/**
 * THE GRAPH THIS BOARD PROPOSES, and the canonical bytes behind it (task-c96ef2d1). The hash was
 * a fixed placeholder naming a graph nothing could produce; it is now `encodeGraphContent`'s own
 * verdict over the single-node graph the daemon's journey producer mints for these dev subjects.
 * The daemon RECOMPUTES it from the bytes and refuses PLANNING_GRAPH_CONTENT_HASH_MISMATCH on
 * disagreement, and re-encodes the spelling and compares, refusing
 * PLANNING_GRAPH_CONTENT_MALFORMED for whitespace, the url-safe alphabet or missing padding.
 * Nothing here is trusted; dev-payload-parity.test.ts pins every value below to the producer.
 */
const GRAPH_CONTENT_HASH = "cc872ea84ee157329bbe3b4590a474bc29d9d0b3c474ce5c809d2c80591c8052";
const GRAPH_CONTENT_BYTES = "eyJzY2hlbWEiOiJNT0UtR1JBUEgtQ09OVEVOVC8zIiwiaGFzaCI6ImNjODcyZWE4NGVlMTU3MzI5YmJlM2I0NTkwYTQ3NGJjMjlkOWQwYjNjNDc0Y2U1YzgwOWQyYzgwNTkxYzgwNTIiLCJjb250ZW50Ijp7ImF1dGhvciI6Im9wZXJhdG9yLWxvY2FsIiwiY29tcGxldGlvbk5vZGUiOiJub2RlLWNvZGUtMSIsImRlY29tcG9zaXRpb25CdWRnZXQiOjI0LCJub2RlQXV0aG9yaXR5Ijp7ImF1dGhvcml0aWVzIjpbeyJub2RlQXV0aG9yaXR5SGFzaCI6ImViNjI0ZThiYWZlNjk4ZGNlNzk0NWFjNjY2MmY0OWQxMGU2MWQ3MGRhOGZmMWM5MTdlNjU5OWNhZDEwN2M5NTQiLCJub2RlS2V5Ijoibm9kZS1jb2RlLTEifV0sImRlZmluaXRpb25zIjpbeyJhZG1pc3Npb25BbW91bnRzIjpbeyJtZXRlciI6InJ1bm5lci5hdXRob3JpemVkX21zIiwicHVycG9zZSI6IkNPTlRJTkdFTkNZIiwicXVhbnRpdHkiOjF9LHsibWV0ZXIiOiJydW5uZXIuYXV0aG9yaXplZF9tcyIsInB1cnBvc2UiOiJFWEVDVVRJT04iLCJxdWFudGl0eSI6Mn0seyJtZXRl"
  + "ciI6InJ1bm5lci5hdXRob3JpemVkX21zIiwicHVycG9zZSI6IkZJTkFMX0FDQ0VQVEFOQ0UiLCJxdWFudGl0eSI6M30seyJtZXRlciI6InJ1bm5lci5hdXRob3JpemVkX21zIiwicHVycG9zZSI6IklOREVQRU5ERU5UX1JFVklFVyIsInF1YW50aXR5Ijo0fSx7Im1ldGVyIjoicnVubmVyLmF1dGhvcml6ZWRfbXMiLCJwdXJwb3NlIjoiVkVSSUZJQ0FUSU9OIiwicXVhbnRpdHkiOjV9XSwiYWRtaXNzaW9uR2F0ZVBvbGljeSI6IkhVTUFOX0FQUFJPVkFMIiwiY2FwYWJpbGl0eSI6ImNhcGFiaWxpdHktaW1wbGVtZW50IiwiY29tcGxldGlvbkxpbmthZ2UiOiJub2RlLWNvZGUtMSIsImNvbnN0cmFpbnRzIjpbImNvbnN0cmFpbnQtYSJdLCJjcml0ZXJpb25CaW5kaW5ncyI6W3siY29udGVudERpZ2VzdCI6IjVhMzdkMzJlNzQ0NzUyM2FjOTQ4ZWViMzc4ODEwNWQ4YjVjODE5ZGRkMzkxNTkyZTIzOTRlNmJmYTY0ZjUxY2UiLCJjcml0ZXJpb25JZCI6ImNyaXRlcmlvbi1hIn1dLCJkaXJlY3RIYXJkRGVwZW5kZW5jaWVzIjpbXSwiam9p"
  + "blJvbGUiOiJDT01QTEVUSU9OIiwibW9ub3RvbmljUHJlZGljYXRlUHJvb2ZzIjpbXSwibm9kZUtleSI6Im5vZGUtY29kZS0xIiwib2JqZWN0aXZlIjoiTGFuZCBub2RlLWNvZGUtMS4iLCJwbGFuRXhlY3V0aW9uQ29udGVudERpZ2VzdCI6IjAzZGZmNjI1ZDgzZTdiYzNjZWFjZTg4NGQ3MTU1MzAzN2U2NWU3ODI1MzBmYmJiNGNkNTNhYjNiZGU0N2IwYzMiLCJwb2xpY3lTbGljZUhhc2giOiIzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIiwicmVhZFNjb3BlcyI6WyJzZXJ2aWNlcy9hcGkvc3JjIl0sInJlcG9zaXRvcnlCYXNlVHJlZSI6IjQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQiLCJyZXNvdXJjZXMiOlsicmVzb3VyY2UtYSJdLCJzY2hlbWFWZXJzaW9uIjoyLCJ2ZXJpZmljYXRpb25SZWNpcGVSZXZpc2lvbnMiOlsicmVjaXBlLWEiXSwid3JpdGVTY29wZXMiOlsic2VydmljZXMvYXBp"
  + "L3NyYy9ub2RlIl19XX0sInBhcmVudFJldmlzaW9uIjpudWxsLCJwb2xpY3lSZXZpc2lvbiI6InBvbC0wMDAwMDAwMDAwMDEiLCJyZXBvc2l0b3J5QmFzZVRyZWUiOiI0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0Iiwic25hcHNob3QiOnsibm9kZXMiOlt7Im5vZGVLZXkiOiJub2RlLWNvZGUtMSIsImV4ZWN1dGlvbkJlYXJpbmciOnRydWV9XSwiZWRnZXMiOltdLCJjb21wbGV0aW9uTm9kZUtleSI6Im5vZGUtY29kZS0xIn19fQ==";
/** The demo code node every shipped journey names; the finalize witness must name one. */
const DEMO_NODE_REF = "node-code-1";

/**
 * THE SEALED PLANNING AUTHORITY, spelled as the bytes the daemon's journey producer mints
 * (journey-authority-bodies.ts; inputs: authorRef operator-local, criterion `${goalRef}-criterion`,
 * graphRevisionRef graph-revision-1, idPrefix the run, node node-code-1 — the graph HASH is not
 * an input, it is that producer's output above). EVERY identity-bearing field below is bound to
 * the run and goal this proposal is FOR, so a second goal proposes its own contract, its own
 * criterion and its own revision rather than restating the first one's.
 *
 * THE DIGESTS ARE THE SEED JOURNEY'S. The daemon re-derives both from the bytes it receives, so
 * they agree for the seeded subjects dev-payload-parity.test.ts pins and the daemon answers any
 * other goal's proposal with the codec's own refusal, rendered verbatim. That is the honest
 * development behaviour: this browser module cannot recompute a producer's digest, and a value
 * invented here would be a claim the daemon never made.
 */
const SUBMISSION_HASH = "d0266cbd23766f40e216bb798940ddb8de47050b16313a736df718918fa71078";

function sealedAuthorityFor(runId: string, goalRef: string): JsonObject {
  return {
    acceptanceContract: {
      applicability: {
        graphContentHash: GRAPH_CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF,
        nodeIds: [DEMO_NODE_REF], nodeKind: "LEAF",
      },
      authorRef: "operator-local",
      contractId: `${runId}-contract`,
      obligations: [
        {
          criterionId: `${goalRef}-criterion`,
          evidenceRequirements: [
            {
              evidenceRef: `${goalRef}-criterion-evidence`, kind: "VERIFICATION_RECEIPT",
              requirementId: `${goalRef}-criterion-requirement`,
            },
          ],
          statement: `the run satisfies ${goalRef}-criterion`,
          verificationRecipeRefs: [`${goalRef}-criterion-recipe`],
        },
      ],
      criteriaDigest: "4aaf98a1abb16b90da918b10c5df095e3dd617b2da57e9277969883264549756",
      version: "moe-acceptance-contract/1",
    },
    planRevision: {
      affectedCriterionIds: [`${goalRef}-criterion`],
      affectedNodeIds: [DEMO_NODE_REF],
      approvalState: "PENDING_APPROVAL",
      authorRef: "operator-local",
      graphBinding: { graphContentHash: GRAPH_CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF },
      parentRevisionId: null,
      planHash: SUBMISSION_HASH,
      rejectionRef: null,
      revisionId: `${runId}-revision`,
      steps: [{ description: "Land the live board's demo node.", kind: "ANALYSIS", stepId: "step-00001" }],
      verificationRecipeRefs: [`${runId}-recipe`],
      version: "moe-plan-revision/1",
    },
  };
}

/**
 * The first commit's chain for ONE run, opened against the goal the daemon bound to it. Only
 * `planning.create_draft` names the goal and the run outright; the sealed authority the propose
 * terminal carries names both again, and the rest of the chain is identity-agnostic and carries
 * verbatim. The board invents no binding: the goal arrives from the daemon's own per-run map.
 */
function planningChainFor(runId: string, goalRef: string): readonly JsonObject[] {
  return [
    {
      commandId: "chain-create", expectedVersion: 0, goalRef,
      kind: "planning.create_draft", runId, runKind: "INITIAL",
    },
    {
      commandId: "chain-ready", expectedVersion: 1, kind: "planning.ready",
      witness: {
        acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
        planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED",
      },
    },
    {
      commandId: "chain-claim", expectedVersion: 2, kind: "planning.claim",
      witness: {
        attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
        providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED",
      },
    },
    {
      authority: sealedAuthorityFor(runId, goalRef),
      commandId: "chain-propose",
      // A SIBLING of `authority` (exact-keyed to two names, a third refused whole), and MANDATORY
      // since task-c96ef2d1: a propose without it is refused PLANNING_GRAPH_CONTENT_REQUIRED.
      graphContentBytesBase64: GRAPH_CONTENT_BYTES,
      effectTerminalProof: {
        effectTerminalRef: "effect-terminal-1", resourcesTerminalRef: "resources-terminal-1",
        truthClass: "DAEMON_VERIFIED",
      },
      expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
      submissionHash: SUBMISSION_HASH,
      witness: {
        attemptRef: "attempt-1", submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED",
      },
    },
  ];
}

/**
 * goal.create's entire caller half: a prose brief and nothing else. The daemon's
 * `admitGoalBrief` refuses any other key (GOAL_BRIEF_INPUT_INVALID), and it mints the
 * goal aggregate itself from the commandId (`goal-<commandId>`), so the payload names
 * no target. The offered aggregateId still gates WHETHER the board dispatches: no
 * offered goal, no create.
 */
const GOAL_CREATE_BASE: JsonObject = {
  instructions: "Land the live board's demo node.",
  title: "Live board goal",
};

/**
 * The finalize terminal rides a request of its OWN: the daemon refuses a chain holding both
 * terminals (PLANNING_FINALIZE_CHAIN_MIXED), so the board's plan.propose card dispatches TWICE -
 * the planning chain at version 0, this chain once the first commit advanced it. Only the
 * finalize moves the run to PLAN_REVIEW, which approval.decide demands. It carries the graph HASH
 * and never the bytes: that key is in the daemon's FORBIDDEN_BODY_KEYS, and a finalize holding it
 * is refused PLANNING_FINALIZE_BODIES_SUPPLIED at DAEMON_INGRESS.
 */
const FINALIZE_CHAIN: readonly JsonObject[] = [
  {
    commandId: "chain-finalize", expectedVersion: 4, kind: "planning.finalize_submission",
    revision: {
      dependencyHash: hex64("d1"), graphContentHash: GRAPH_CONTENT_HASH,
      graphRevisionRef: GRAPH_REVISION_REF, planHash: SUBMISSION_HASH, qualityHash: hex64("dd"),
    },
    witness: {
      attemptTerminalRef: "attempt-terminal-1", effectTerminalRef: "effect-terminal-1",
      nodeSummaries: [{ executionBearing: true, nodeKey: DEMO_NODE_REF }],
      providerSlotTerminalRef: "slot-terminal-1", resourcesTerminalRef: "resources-terminal-1",
      truthClass: "DAEMON_VERIFIED",
    },
  },
];

/**
 * THE COMMAND-KIND ROSTER, and the caller half that carries no identity.
 *
 * Every value here is what the board would send REGARDLESS of which goal is on screen. The three
 * planning kinds carry no run and no goal at all: `payloadFor` binds those from the daemon's own
 * offer, so a base that spelled one would be a second, stale source of truth for the subject.
 */
export const DEV_PAYLOADS: Readonly<Record<string, JsonObject>> = Object.freeze({
  "approval.decide": {
    activation: {
      activationRef: "activation-1", expectedGoalVersion: 1,
      goalDraftNoActiveRevision: true, graphHash: hex64("6a"), policyHash: hex64("b1"),
      qualityHash: hex64("dd"), truthClass: "HUMAN_APPROVED",
    },
    command: {
      decision: "APPROVE", decisionReason: "reason-1", kind: "approval.decide",
      stepUpAuthRef: "stepup-1",
    },
    graphRevisionRef: GRAPH_REVISION_REF,
    record: {
      actor: "operator-local", actorKind: "HUMAN", applicablePolicyRef: hex64("aa"),
      approvalRef: "approval-1", approvedNodeScope: [DEMO_NODE_REF], budgetRef: hex64("bb"),
      criteriaRef: hex64("cc"), decision: null, decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      exactRevisionHash: SUBMISSION_HASH, lifecycle: "PENDING",
      planQualityAssessmentRef: hex64("dd"), policyDecisionRef: null, riskTier: "R2",
      stepUpAuthRef: "stepup-1", truthClass: "HUMAN_APPROVED", validity: "CURRENT",
    },
  },
  "goal.close": {
    closureWitness: {
      acceptanceClosureRef: "acceptance-1", completionNodeAcceptedRef: "completion-node-1",
      noCurrentPreparationGeneration: true, noPendingDraftOrSupersession: true,
      obligationsHoldRef: "obligations-1", truthClass: "HUMAN_APPROVED",
    },
    zeroAuthorityWitness: {
      truthClass: "DAEMON_VERIFIED", zeroAuthorityProofRef: "zero-authority-1",
    },
  },
  "goal.create": { ...GOAL_CREATE_BASE },
  // Both members of a proposal - the chain and the run it names - are authored from the
  // offer, so this kind's base is empty by construction. `payloadFor` builds the whole
  // payload: the sealing chain while the surface reports version 0, the finalize after it.
  "plan.propose": {},
  "policy.install": {
    slice: {
      autoApprovalOptIns: [], riskClassifications: RISK_CLASSIFICATIONS, rules: [],
      sliceRef: POLICY_REF,
    },
  },
  "policy.validate": {
    input: {
      action: "plan.approve", callerRiskHint: null,
      decisionDigest: hex64("d1"), graphNodeRevisionRefs: [],
      policyRevisionRef: POLICY_REF, requiredFactIds: [], scope: [],
    },
  },
  "project.activate": {
    witness: {
      artifactPathRef: "artifact-1", backupPathRef: "backup-1", credentialRef: "credential-1",
      distributionManifestHash: hex64("cafe"), policyRevisionHash: hex64("face"),
      providerMinimumProfileRef: "provider-profile-1", signingKeyRef: "signing-1",
      storeDriverRef: "store-driver-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  "project.bind_repository": {
    observation: {
      baseRevisionHash: hex64("beef"), repositoryRef: "repo-1", scopeRef: "scope-1",
      truthClass: "DAEMON_VERIFIED",
    },
  },
  "project.register": { owner: "operator-local" },
  "provider.probe": {
    // The PROFILE is what the probe registers; an observation without one
    // refuses PROVIDER_PROFILE_INPUT_INVALID at the codec, which silently
    // bricked the whole board-driven chain (project.activate names the probe
    // as its prerequisite). Mirrors the daemon's CLAUDE_PROFILE fixture; the
    // ref MUST agree with project.activate's witness below.
    observation: {
      profile: {
        capabilitySchemaDigest: hex64("ca9ab111"),
        concurrencyCeiling: 4,
        limits: { stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096, timeoutMs: 900_000 },
        modelSnapshotEvidence: "claude --version reported a dated snapshot",
        modelSnapshotKind: "DATED_SNAPSHOT",
        profileRevisionId: "profile-revision-1",
        provider: "claude",
        providerMinimumProfileRef: "provider-profile-1",
        reasoningEffort: "high",
        selectedModelId: "claude-opus-5",
        selection: {
          modelRef: "model-ref-1", profileRef: "profile-ref-1", providerRef: "provider-ref-1",
          reasoningEffortRef: "reasoning-effort-ref-1", runtimeRef: "runtime-ref-1",
          snapshotRef: "snapshot-ref-1", structuredOutputSchemaRef: "structured-output-schema-ref-1",
        },
      },
      providerMinimumProfileRef: "provider-profile-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  "session.open": {
    capabilities: ["goal.write"], credentialSha256: "a".repeat(64),
    expiresAt: "2027-01-01T00:00:00.000Z", sessionId: "sess-ui-1",
  },
});

/** The seven evidence-bindable package items buildReviewPackage demands. */
const REVIEW_PACKAGE_ITEMS: readonly JsonObject[] = [
  { digest: hex64("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: hex64("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
  { digest: hex64("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: hex64("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
  { digest: hex64("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: hex64("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: hex64("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
];

/** Review-family payloads are per-subject: the target aggregate IS the node. */
function reviewPayloadFor(kind: string, subjectRef: string): JsonObject | null {
  if (kind === "review.submit") {
    return {
      findings: [], packageItems: REVIEW_PACKAGE_ITEMS, round: 1, subjectRef,
    };
  }
  if (kind === "integration.accept_output") {
    // Exactly the seam's allow-list — PAYLOAD_KEYS admits ["receiptId",
    // "subjectRef"] and nothing else; the previous richer shape was refused
    // whole at PAYLOAD_SHAPE before any gate could even read it.
    return { receiptId: `receipt-${subjectRef}`, subjectRef };
  }
  return null;
}

/** The one session the board may operate: its own dev subject, never an agent's. */
const DEV_SESSION_ID = "sess-ui-1";

/**
 * THE PAYLOAD FOR ONE OFFERED TARGET.
 *
 * `aggregateId` is the aggregate the DAEMON offered this command for, and it is the only
 * identity that reaches a payload: the planning run for plan.propose and approval.decide, the
 * durable goal for goal.close, the session for close/renew, the node for the review family.
 * plan.propose also reads the step's VERSION, because the same card is dispatched twice - the
 * sealing chain, then the finalize - and only the surface says which commit the daemon awaits.
 *
 * `planningGoalRef` is the goal the daemon bound to THAT run, never a surface-wide default and
 * never a formatted id. Without it there is no goal to seal a plan under, so this authors
 * nothing rather than proposing one goal's plan against another's run.
 */
export function payloadFor(
  kind: string, aggregateId: string | null, version: number | null = null,
  planningGoalRef: string | null = null,
): JsonObject | null {
  if (kind === "plan.propose") {
    if (aggregateId === null || aggregateId === "") return null;
    if (planningGoalRef === null || planningGoalRef === "") return null;
    return (version ?? 0) > 0
      ? { commands: FINALIZE_CHAIN, runId: aggregateId }
      : { commands: planningChainFor(aggregateId, planningGoalRef), runId: aggregateId };
  }
  if (kind === "approval.decide") {
    // The run whose sealed revision is being decided is the OFFER's target.
    if (aggregateId === null || aggregateId === "") return null;
    return { ...(DEV_PAYLOADS[kind] ?? {}), runId: aggregateId };
  }
  if (kind === "goal.close") {
    // The goal being closed is likewise the offer's own target, not a run it was reached by.
    if (aggregateId === null || aggregateId === "") return null;
    return { ...(DEV_PAYLOADS[kind] ?? {}), goalId: aggregateId };
  }
  if (kind === "goal.create") {
    // No offered target, no create. The target itself never rides the payload:
    // the daemon derives it from the commandId and refuses a caller-named goalId.
    if (aggregateId === null) return null;
    return { ...GOAL_CREATE_BASE };
  }
  if (kind === "session.close" || kind === "session.renew") {
    const sessionId = aggregateId?.startsWith("session/") === true
      ? aggregateId.slice("session/".length)
      : null;
    // ONLY the dev session. The surface offers close/renew for EVERY open
    // session, including the ones the wrapper minted for live agents — a
    // one-click close there kills an agent's session mid-work, and a renew
    // silently rewrites its expiry. The board authors neither.
    if (sessionId !== DEV_SESSION_ID) return null;
    return kind === "session.close"
      ? { sessionId }
      : { expiresAt: "2027-06-01T00:00:00.000Z", sessionId };
  }
  if ((kind === "review.submit" || kind === "integration.accept_output")
    && aggregateId !== null) {
    return reviewPayloadFor(kind, aggregateId);
  }
  return DEV_PAYLOADS[kind] ?? null;
}
