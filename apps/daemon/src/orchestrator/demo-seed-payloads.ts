import type { ClaudeModelEvidenceKind, ClaudeReasoningEffort } from "@moe/runner";

import { journeyAuthority } from "../planning/journey-authority-bodies.js";
import type { JourneyAuthority } from "../planning/journey-authority-bodies.js";
import type { DemoSeedInput } from "./demo-seed-plan.js";
// The three policy bodies moved to a sibling (task-a888038d) and are re-exported so no consumer's
// import moves; see `demo-seed-policy.ts` for why the split happened here.
export {
  DEMO_VALIDATABLE_POLICY_REF,
  reviewerCalibrationSlice,
  validatablePolicySlice,
  verifierPolicySlice,
} from "./demo-seed-policy.js";

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

/**
 * The seed's planning-authority bodies, minted through the shared journey producer so the demo
 * seals the SAME shape the bootstrap harness does. Every id is derived from the caller's, so
 * two builds over one input stay byte-identical.
 */
function sealedAuthority(input: DemoSeedInput): JourneyAuthority {
  return journeyAuthority({
    authorRef: input.principalId,
    criterionIds: [`${input.goalId}-criterion`],
    graphRevisionRef: `${input.runId}-graph-revision`,
    idPrefix: input.runId,
    nodeIds: [input.node.nodeRef],
    stepDescription: "Seed the demo plan.",
  });
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

/**
 * The seed measures no provider, so the snapshot evidence kind is UNKNOWN. Claiming
 * DATED_SNAPSHOT would vouch for a `claude --version` reading no demo ever took; the
 * effort is a CONFIGURED choice rather than evidence, so naming one is honest. Both are
 * typed against the runner's closed vocabularies, so a rename there is a compile error
 * here instead of a runtime refusal.
 */
const DEMO_SNAPSHOT_KIND: ClaudeModelEvidenceKind = "UNKNOWN";
const DEMO_REASONING_EFFORT: ClaudeReasoningEffort = "medium";

/**
 * The operator-configured Claude profile the demo probe registers, exactly the eleven
 * keys `admitProviderProfile` admits — an unknown key refuses rather than being dropped.
 *
 * Two refs are easy to confuse and each carries its own refusal. `providerMinimumProfileRef`
 * is the profile's IDENTITY and must equal the envelope's ref, or `recordProbe` refuses
 * PROVIDER_PROFILE_REF_MISMATCH at PROVIDER_PROFILE_REGISTRATION; it is the ref
 * `activationWitness` names too. `profileRevisionId` is the identity of this CONTENT and is
 * deliberately a DIFFERENT string, because the durable stream refuses
 * PROVIDER_PROFILE_IMMUTABILITY_CONFLICT when one revision id ever carries two bodies.
 * Every value below is therefore derived from the caller's ids or is a literal — no clock,
 * no randomness — so a second seed run over the same store re-sends byte-identical content
 * and is admitted as the idempotent re-probe it is.
 *
 * The limits are shape-valid numbers, not a copied runner ceiling: this layer bounds shape
 * only, and a ceiling copied here would drift silently from the one that governs.
 */
export function providerProfile(input: DemoSeedInput): Record<string, unknown> {
  return {
    capabilitySchemaDigest: hex64("ca9ab111"),
    concurrencyCeiling: 2,
    limits: { stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096, timeoutMs: 900_000 },
    modelSnapshotEvidence: "demo seed: no provider snapshot was measured",
    modelSnapshotKind: DEMO_SNAPSHOT_KIND,
    profileRevisionId: `${input.projectId}-provider-profile-revision-1`,
    provider: "claude",
    providerMinimumProfileRef: providerProfileRef(input),
    reasoningEffort: DEMO_REASONING_EFFORT,
    selectedModelId: "claude-opus-5",
    selection: {
      modelRef: `${input.projectId}-model`,
      profileRef: providerProfileRef(input),
      providerRef: `${input.projectId}-provider-ref`,
      reasoningEffortRef: `${input.projectId}-reasoning-effort`,
      runtimeRef: `${input.projectId}-runtime`,
      snapshotRef: `${input.projectId}-snapshot`,
      structuredOutputSchemaRef: `${input.projectId}-structured-output-schema`,
    },
  };
}

/**
 * The probe observation: the envelope's two strings PLUS the nested profile. The
 * two-string form this seed shipped first is refused PROVIDER_PROFILE_INPUT_INVALID at
 * PROVIDER_PROFILE_CODEC — `recordProbe` admits `observation.profile`, not the ref alone.
 */
export function probeObservation(input: DemoSeedInput): Record<string, unknown> {
  return {
    profile: providerProfile(input),
    providerMinimumProfileRef: providerProfileRef(input),
    truthClass: DEMO_VERIFIED,
  };
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

/**
 * The core planning-run commands that carry a fresh run to PLANNING and then propose.
 *
 * The propose terminal is the ONLY command the authority member may ride: `planning-services.ts`
 * returns `commitFinalizedSubmission` at :132 BEFORE `buildPlanningAuthorityLeg` at :136, so a
 * finalize request never reads the member — and `callerSuppliedAuthorityBodies` lists
 * `"authority"` among its forbidden keys, so putting it there is refused outright
 * (`PLANNING_FINALIZE_BODIES_SUPPLIED`, DAEMON_INGRESS, :120-122) rather than merely ignored.
 */
export function planningChain(input: DemoSeedInput): readonly Record<string, unknown>[] {
  const sealed = sealedAuthority(input);
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
      authority: sealed.authority,
      commandId: `${input.runId}-propose`,
      // A SIBLING of `authority`, never inside it (that member is exact-keyed to two names), and
      // never on the finalize terminal (FORBIDDEN_BODY_KEYS). Mandatory since task-c96ef2d1.
      graphContentBytesBase64: sealed.graphContentBytesBase64,
      effectTerminalProof: {
        effectTerminalRef: `${input.runId}-effect-terminal`,
        resourcesTerminalRef: `${input.runId}-resources-terminal`,
        truthClass: DEMO_VERIFIED,
      },
      expectedVersion: 3,
      kind: "plan.propose",
      proposalKind: "INITIAL",
      submissionHash: sealed.submissionHash,
      witness: {
        attemptRef: `${input.runId}-attempt`,
        submissionRef: `${input.runId}-submission`,
        truthClass: DEMO_VERIFIED,
      },
    },
  ];
}

/**
 * The finalize terminal, in a request of its OWN. `classifyPlanningChain` refuses a chain that
 * holds both terminals with PLANNING_FINALIZE_CHAIN_MIXED - they are mutually exclusive by
 * design, because each business effect owes its own durable decision - so the seed finalizes by
 * issuing a SECOND `plan.propose` whose chain is exactly this one command, never by growing
 * `planningChain()` a fifth element.
 */
export function finalizeChain(input: DemoSeedInput): readonly Record<string, unknown>[] {
  // ONE build, read twice. `sealedAuthority` now encodes a whole graph, so a call per field meant
  // two full builds here; it is deterministic, so this changes cost and not a single byte.
  const sealed = sealedAuthority(input);
  return [
    {
      commandId: `${input.runId}-finalize`,
      expectedVersion: 4,
      kind: "planning.finalize_submission",
      revision: {
        dependencyHash: hex64("d1"),
        // The producer's RECOMPUTED graph hash, not a placeholder: the envelope cross-checks it
        // against the sealed plan revision's own binding and refuses the finalize outright on
        // disagreement (PLANNING_AUTHORITY_GRAPH_CONTENT_MISMATCH).
        graphContentHash: sealed.graphContentHash,
        graphRevisionRef: `${input.runId}-graph-revision`,
        // The run's sealed plan hash, not a constant: the propose terminal sealed the plan body
        // whose own `planHash` this is, and the finalize is judged against that folded state.
        planHash: sealed.submissionHash,
        qualityHash: hex64("dd"),
      },
      witness: {
        attemptTerminalRef: `${input.runId}-attempt-terminal`,
        effectTerminalRef: `${input.runId}-effect-terminal`,
        nodeSummaries: [{ executionBearing: true, nodeKey: input.node.nodeRef }],
        providerSlotTerminalRef: `${input.runId}-slot-terminal`,
        resourcesTerminalRef: `${input.runId}-resources-terminal`,
        truthClass: DEMO_VERIFIED,
      },
    },
  ];
}

/**
 * `expectedGoalVersion` is 1: `goal.create` leaves the goal at domain version 1.
 *
 * NO `budgetHash` (task-1de7b81a). It was the placeholder hex64("b0"); the approve path now
 * establishes the project's budget root and records the digest it computes over that durable
 * record, so a seed cannot supply the value — and one that disagrees is refused
 * BOOTSTRAP_BUDGET_HASH_MISMATCH rather than silently overriding the server.
 *
 * `graphHash`, `policyHash` and `qualityHash` ARE STILL PLACEHOLDERS and deliberately survive.
 * task-eb6a1fa6 (the policy half) is now DONE and task-eacea969 has landed the service that
 * composes all three server-side — `activateApprovedGraph`, which RECOMPUTES the content hash
 * from the durably sealed body, reads the quality hash off the run's own seal, and digests the
 * approval policy decision it took. But `approval.decide` does not call that service yet: the
 * consumer edge is task-efc2ef63, which wires the `graph.approve` transport. Deleting these three
 * before that edge exists would strip fields with no server-side replacement on the live path, so
 * they stay, and this comment names the row accountable for retiring them.
 */
export function planningActivation(input: DemoSeedInput): Record<string, unknown> {
  return {
    activationRef: `${input.runId}-activation`,
    expectedGoalVersion: 1,
    goalDraftNoActiveRevision: true,
    graphHash: hex64("6a"),
    policyHash: hex64("b1"),
    qualityHash: hex64("dd"),
    truthClass: DEMO_APPROVED,
  };
}

/**
 * `budgetRef` IS A PARAMETER, and it is a parameter on purpose.
 *
 * Since task-61a2e8ad it is a decide-time COMMITMENT — `budgetCommitmentDigest` over
 * `budgetCommitmentMaterial` read from the seeded store — which `approval-activation.ts`
 * recomputes and binds back before it mints the budget root. It cannot be spelled here: this
 * module is a pure payload builder with no store, and the material the commitment covers is
 * not durable until the seed's finalize terminal has committed. It used to be `hex64("bb")`,
 * and once the bind-back landed that literal stopped being a placeholder and became a WRONG
 * ANSWER — the shipped demo lane refused its own last command with
 * BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH @ DAEMON_PREREQUISITE and never activated. Taking the
 * ref as a required argument says in the TYPE that only a caller holding durable state can
 * answer, so no future edit can re-introduce a spelled one without deleting the parameter.
 */
export function approvalRecord(
  input: DemoSeedInput, budgetRef: string,
): Record<string, unknown> {
  return {
    actor: input.principalId,
    actorKind: "HUMAN",
    applicablePolicyRef: hex64("aa"),
    approvalRef: `${input.runId}-approval`,
    // The approved scope IS the demo node, so the node the operator wrote the
    // spec for is the node the approval covers.
    approvedNodeScope: [input.node.nodeRef],
    budgetRef,
    criteriaRef: hex64("cc"),
    decision: null,
    decisionReason: null,
    dependencyChanges: { additions: [], challenges: [], removals: [] },
    // Joined to the run's submission hash, which task-2cc6c59d's inconsistency refusal compares
    // against the sealed plan body; a spelled constant here reads as an INCONSISTENT approval.
    exactRevisionHash: sealedAuthority(input).submissionHash,
    lifecycle: "PENDING",
    planQualityAssessmentRef: hex64("dd"),
    policyDecisionRef: null,
    riskTier: "R2",
    stepUpAuthRef: `${input.runId}-stepup`,
    truthClass: DEMO_APPROVED,
    validity: "CURRENT",
  };
}
