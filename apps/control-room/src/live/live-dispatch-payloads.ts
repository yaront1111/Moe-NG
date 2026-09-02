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

// THE IDENTITIES ARE THE DAEMON'S, NOT THIS MODULE'S. Neither a build-time subject nor a
// build-time GRAPH OR PLAN DIGEST survives here: the graph bytes, their hash, the submission
// hash and the sealed authority bodies are now carried per run on the affordance surface and
// bound to the offer that named them (live-planning-authorities.ts). What remains below is the
// caller half that names no run, no goal and no digest the daemon produces.
//
// POLICY_REF is a known-answer digest of the exact slice below under moe.policy.slice.content.v1,
// which the daemon independently recomputes at install; parity tests pin this browser constant to
// the core producer without pulling Node's crypto into the bundle. Rotated by task-a888038d along
// with the slice it names, because the finalize terminal now derives the sealed graph's
// node-property fact ids and refuses the seal when no installed policy classifies them.
// Pre-rotation: e7a5ee19…963a, over `{autoApprovalOptIns: [], rules: []}`.
const POLICY_REF = "fff1cc915b3ed86b2e992c8b896f1abcdc7b8d98ea1eb196ceebd45cadd0290e";
const RISK_CLASSIFICATIONS = [
  { factId: "node.capability:capability-implement", tier: "R1" },
  { factId: "node.read_scope:services/api/src", tier: "R0" },
  { factId: "node.resource:resource-a", tier: "R0" },
  { factId: "node.write_scope:services/api/src/node", tier: "R2" },
];
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
 * THE COMMAND-KIND ROSTER, and the caller half that carries no identity.
 *
 * Every value here is what the board would send REGARDLESS of which goal is on screen. The three
 * planning kinds carry no run and no goal at all: `payloadFor` binds those from the daemon's own
 * offer, so a base that spelled one would be a second, stale source of truth for the subject.
 */
export const DEV_PAYLOADS: Readonly<Record<string, JsonObject>> = Object.freeze({
  // INCOMPLETE ON ITS OWN, in two separate ways. `budgetRef` is a decide-time COMMITMENT the
  // daemon recomputes and binds back at activation (task-61a2e8ad), read by `dispatchAffordance`;
  // and `graphRevisionRef`, `activation.graphHash`, `record.actor`, `approvedNodeScope`,
  // `criteriaRef` and `exactRevisionHash` are the daemon's own sealed identity, overlaid by
  // `planningPayloadFor`. Neither may be spelled here: a literal would be a second, stale
  // source of truth the daemon refuses. `policyHash`, `qualityHash`, `applicablePolicyRef` and
  // `planQualityAssessmentRef` stay as they were — the producer carries no such digest.
  "approval.decide": {
    activation: {
      activationRef: "activation-1", expectedGoalVersion: 1,
      goalDraftNoActiveRevision: true, policyHash: hex64("b1"),
      qualityHash: hex64("dd"), truthClass: "HUMAN_APPROVED",
    },
    command: {
      decision: "APPROVE", decisionReason: "reason-1", kind: "approval.decide",
      stepUpAuthRef: "stepup-1",
    },
    record: {
      actorKind: "HUMAN", applicablePolicyRef: hex64("aa"),
      approvalRef: "approval-1", decision: null, decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      lifecycle: "PENDING",
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

/**
 * THE PLANNING CHAIN'S IDENTITY-FREE MEMBERS, and nothing else.
 *
 * Every witness below is the same for every run the board proposes on, so it belongs with the
 * rest of the caller half. What is DELIBERATELY ABSENT from each base is the daemon's: the
 * goal, the run, the sealed authority, the graph bytes, the submission hash and the finalize
 * revision. `planningPayloadFor` (live-planning-authorities.ts) overlays those from the
 * material the surface carried, so nothing here can become a stale second source of truth.
 */
export const PLANNING_CHAIN_STEPS: Readonly<Record<string, JsonObject>> = Object.freeze({
  claim: {
    commandId: "chain-claim", expectedVersion: 2, kind: "planning.claim",
    witness: {
      attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
      providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  finalize: {
    commandId: "chain-finalize", expectedVersion: 4, kind: "planning.finalize_submission",
    witness: {
      attemptTerminalRef: "attempt-terminal-1", effectTerminalRef: "effect-terminal-1",
      providerSlotTerminalRef: "slot-terminal-1", resourcesTerminalRef: "resources-terminal-1",
      truthClass: "DAEMON_VERIFIED",
    },
  },
  propose: {
    commandId: "chain-propose",
    effectTerminalProof: {
      effectTerminalRef: "effect-terminal-1", resourcesTerminalRef: "resources-terminal-1",
      truthClass: "DAEMON_VERIFIED",
    },
    expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
    witness: {
      attemptRef: "attempt-1", submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  ready: {
    commandId: "chain-ready", expectedVersion: 1, kind: "planning.ready",
    witness: {
      acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
      planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED",
    },
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
 * THE PAYLOAD FOR ONE OFFERED TARGET, for every kind that needs NO daemon authority.
 *
 * `aggregateId` is the aggregate the DAEMON offered this command for, and it is the only
 * identity that reaches a payload: the durable goal for goal.close, the session for
 * close/renew, the node for the review family.
 *
 * THE TWO AUTHORITY-BEARING KINDS ARE NOT AUTHORED HERE and answer null. `plan.propose` and
 * `approval.decide` need the daemon's per-run sealed material, which is bound to the OFFER
 * record rather than to any string this signature could carry, so authoring them from an
 * aggregate id alone would mean minting a graph or plan digest locally — the exact second
 * verifier task-c96ef2d1 and this row exist to prevent. `planningPayloadFor` authors them.
 * The signature and `planningGoalRef` are unchanged: every caller keeps its one call shape.
 */
export function payloadFor(
  kind: string, aggregateId: string | null, version: number | null = null,
  planningGoalRef: string | null = null,
): JsonObject | null {
  if (kind === "plan.propose" || kind === "approval.decide") {
    // Both operands are kept in the signature for the callers that already pass them, and
    // discarded here on purpose: neither can author an authority-bearing kind.
    void version; void planningGoalRef;
    return null;
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
