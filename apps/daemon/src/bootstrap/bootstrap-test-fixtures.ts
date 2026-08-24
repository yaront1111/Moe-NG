import { SqliteEventStore } from "@moe/store";

import { GOAL_HANDLERS } from "../goals/goal-services.js";
import {
  APPROVAL_MODE_ENV_KEY,
  SPEED_APPROVAL_MODE,
  SPEED_MODE_DELAY_ENV_KEY,
} from "../planning/approval-policy-settings.js";
import { journeyAuthority } from "../planning/journey-authority-bodies.js";
import { PLANNING_HANDLERS } from "../planning/planning-services.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap-contracts.js";
import { readDurableLedger } from "./bootstrap-ledger.js";
import type { HandlerTable, ServiceOutcome } from "./bootstrap-ledger.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap-services.js";

/**
 * Shared request fixtures for the bootstrap, goal and planning service suites.
 *
 * This module builds inputs and drives the PRODUCTION pipeline; it deliberately reimplements
 * no rule. `send` calls `runBootstrapCommand` and `decisionCount` reads through
 * `readDurableLedger`, so an assertion here is an assertion about production code — a helper
 * that restated the ingress or sequence rules would let a suite stay green while the shipped
 * rule drifted away from it.
 */

/**
 * The fixture daemon runs under approval settings it STATES: SPEED at a delay of zero. The
 * approval step of `bootstrapSequence` needs gate-free approval to proceed, and the handler
 * now sources its policy from these settings rather than from a module-level default — which
 * is the whole point, so the fixture has to say what it wants instead of inheriting it.
 * `??=` leaves a test that stated its own settings alone.
 */
process.env[APPROVAL_MODE_ENV_KEY] ??= SPEED_APPROVAL_MODE;
process.env[SPEED_MODE_DELAY_ENV_KEY] ??= "0";

export const PROJECT_ID = "project-1";
export const GOAL_ID = "goal-1";
export const RUN_ID = "run-1";

const encoder = new TextEncoder();
const openStores: SqliteEventStore[] = [];

export function hex64(seed: string): string {
  const base = seed.replace(/[^0-9a-f]/gu, "0");
  return (base + "0".repeat(64)).slice(0, 64);
}

export const POLICY_REF = hex64("a1b2c3");
export const GRAPH_REVISION_REF = "graph-revision-1";

/**
 * The LEGACY submission hash: a spelled constant carried by the authority-LESS `planningChain()`.
 *
 * It stays spelled, and `planningChain()` stays authority-less, because that pair IS the durable
 * home of the ABSENT arm (`planning-authority-persistence.ts:189`) and of task-2cc6c59d's
 * inconsistency refusal. `planning-authority-persistence.test.ts:257-274` pins it byte-identical.
 */
export const SUBMISSION_HASH = hex64("dec0de");

/**
 * The planning-authority the SHIPPED journey seals (task-074e6d2e), minted through the same
 * production producer the demo seed uses (`journey-authority-bodies.ts`) so the harness and the
 * product cannot drift into sealing differently-shaped authority while both stay green.
 *
 * `SEALED_SUBMISSION_HASH` is DERIVED from the minted plan rather than spelled: the leg refuses
 * `PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH` unless the folded state's submission hash IS the
 * plan's own hash, and a spelled constant cannot be kept in agreement with a minted body by hand.
 */
const JOURNEY_AUTHORITY = journeyAuthority({
  authorRef: "architect-1",
  criterionIds: ["criterion-a", "criterion-b"],
  graphRevisionRef: GRAPH_REVISION_REF,
  idPrefix: RUN_ID,
  nodeIds: ["node-a"],
  stepDescription: "Land the journey plan.",
});

export const AUTHORITY_MEMBER = JOURNEY_AUTHORITY.authority;
export const SEALED_SUBMISSION_HASH = JOURNEY_AUTHORITY.submissionHash;
/**
 * The graph the shipped journey seals, RECOMPUTED by the producer (task-c96ef2d1). Both were
 * a fixed placeholder until this row: a hash naming a graph nothing could produce, which is why
 * the propose seam's accepted-body path had no production producer. The daemon recomputes the
 * hash from the bytes and refuses PLANNING_GRAPH_CONTENT_HASH_MISMATCH on disagreement, so
 * neither of these gains authority by being exported.
 */
export const SEALED_GRAPH_CONTENT_HASH = JOURNEY_AUTHORITY.graphContentHash;
export const SEALED_GRAPH_CONTENT_BYTES = JOURNEY_AUTHORITY.graphContentBytesBase64;

export function openStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  openStores.push(store);
  return store;
}

export function closeStores(): void {
  while (openStores.length > 0) openStores.pop()?.close();
}

export interface Envelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly principalId: string;
  readonly projectId: string;
  readonly schemaVersion: string;
}

export function envelope(
  kind: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId = `cmd-${kind}`,
): Envelope {
  return {
    commandId,
    correlationId: "corr-1",
    decidedAt: "2026-08-08T00:00:00.000Z",
    expectedVersion,
    kind,
    payload,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  };
}

export const ALL_HANDLERS: HandlerTable = Object.freeze({
  ...BOOTSTRAP_HANDLERS,
  ...GOAL_HANDLERS,
  ...PLANNING_HANDLERS,
});

export function send(store: SqliteEventStore, request: Envelope): ServiceOutcome {
  return runBootstrapCommand(store, encoder.encode(JSON.stringify(request)), ALL_HANDLERS);
}

/**
 * `send`, carrying the composition root's server-assembled human-review witness —
 * the shape the registry supplies for an OPERATOR-authenticated dispatch. Kept
 * separate from `send` so every existing arm keeps modeling the witness-less
 * path, where the old refusals must hold byte-for-byte.
 */
export function sendReviewed(
  store: SqliteEventStore,
  request: Envelope,
  principalId: string = request.principalId,
): ServiceOutcome {
  return runBootstrapCommand(
    store,
    encoder.encode(JSON.stringify(request)),
    ALL_HANDLERS,
    Object.freeze({ principalId }),
  );
}

export function decisionCount(store: SqliteEventStore): number {
  return readDurableLedger(store, PROJECT_ID).decisionCount;
}

export const OBSERVATION = Object.freeze({
  baseRevisionHash: hex64("beef"),
  repositoryRef: "repo-1",
  scopeRef: "scope-1",
  truthClass: "DAEMON_VERIFIED",
});

/**
 * The operator-configured Claude profile every fixture probe carries.
 *
 * `providerMinimumProfileRef` MUST stay `"provider-profile-1"`: it is the same ref
 * `ACTIVATION_WITNESS` names, and `provider.probe` refuses when the envelope's ref and the
 * body's disagree. The limit values are arbitrary shape-valid numbers — no runner ceiling is
 * copied here, because a copied ceiling drifts silently away from the one that governs.
 */
export const CLAUDE_PROFILE = Object.freeze({
  capabilitySchemaDigest: hex64("ca9ab111"),
  concurrencyCeiling: 4,
  limits: Object.freeze({
    stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096, timeoutMs: 900_000,
  }),
  modelSnapshotEvidence: "claude --version reported a dated snapshot",
  modelSnapshotKind: "DATED_SNAPSHOT",
  profileRevisionId: "profile-revision-1",
  provider: "claude",
  providerMinimumProfileRef: "provider-profile-1",
  reasoningEffort: "high",
  selectedModelId: "claude-opus-5",
  selection: Object.freeze({
    modelRef: "model-ref-1", profileRef: "profile-ref-1", providerRef: "provider-ref-1",
    reasoningEffortRef: "reasoning-effort-ref-1", runtimeRef: "runtime-ref-1",
    snapshotRef: "snapshot-ref-1", structuredOutputSchemaRef: "structured-output-schema-ref-1",
  }),
});

export const PROVIDER_OBSERVATION = Object.freeze({
  profile: CLAUDE_PROFILE,
  providerMinimumProfileRef: "provider-profile-1",
  truthClass: "DAEMON_VERIFIED",
});

export const ACTIVATION_WITNESS = Object.freeze({
  artifactPathRef: "artifact-1",
  backupPathRef: "backup-1",
  credentialRef: "credential-1",
  distributionManifestHash: hex64("cafe"),
  policyRevisionHash: hex64("face"),
  providerMinimumProfileRef: "provider-profile-1",
  signingKeyRef: "signing-1",
  storeDriverRef: "store-driver-1",
  truthClass: "DAEMON_VERIFIED",
});

/**
 * `sliceRef` is a 64-hex string on purpose: `validateEvaluationInput` requires
 * `policyRevisionRef` to be hex64 while `validSlice` accepts any non-empty ref, so a slice
 * installed under a human-readable ref could never be named by a valid evaluation input.
 */
export const POLICY_SLICE = Object.freeze({
  autoApprovalOptIns: [],
  rules: [],
  sliceRef: POLICY_REF,
});

export function evaluationInput(policyRevisionRef: string): Record<string, unknown> {
  return {
    action: "plan.approve",
    actor: "principal-1",
    callerRiskHint: null,
    decisionDigest: hex64("d1"),
    evaluatedAtEpochMs: 1_760_000_000_000,
    evaluatorVersion: "evaluator-1",
    graphNodeRevisionRefs: [],
    policyRevisionRef,
    requiredFactIds: [],
    scope: [],
  };
}

export function goalPayload(): Record<string, unknown> {
  return {
    budgetAccountRef: "budget-account-1",
    goalId: GOAL_ID,
    planningRunRef: RUN_ID,
    witness: { projectReadyRef: "ready-1", truthClass: "DAEMON_VERIFIED" },
  };
}

/** The core planning-run commands that carry a fresh run to PLANNING and then propose. */
export function planningChain(): readonly Record<string, unknown>[] {
  return [
    {
      commandId: "chain-create",
      expectedVersion: 0,
      goalRef: GOAL_ID,
      kind: "planning.create_draft",
      runId: RUN_ID,
      runKind: "INITIAL",
    },
    {
      commandId: "chain-ready",
      expectedVersion: 1,
      kind: "planning.ready",
      witness: {
        acceptanceCriteriaRef: "criteria-1",
        intentBaseRef: "intent-1",
        planningBudgetRef: "budget-1",
        truthClass: "DAEMON_VERIFIED",
      },
    },
    {
      commandId: "chain-claim",
      expectedVersion: 2,
      kind: "planning.claim",
      witness: {
        attemptRef: "attempt-1",
        contextRef: "context-1",
        leaseRef: "lease-1",
        providerSlotRef: "slot-1",
        truthClass: "DAEMON_VERIFIED",
      },
    },
    {
      commandId: "chain-propose",
      effectTerminalProof: {
        effectTerminalRef: "effect-terminal-1",
        resourcesTerminalRef: "resources-terminal-1",
        truthClass: "DAEMON_VERIFIED",
      },
      expectedVersion: 3,
      kind: "plan.propose",
      proposalKind: "INITIAL",
      submissionHash: SUBMISSION_HASH,
      witness: {
        attemptRef: "attempt-1",
        submissionRef: "submission-1",
        truthClass: "DAEMON_VERIFIED",
      },
    },
  ];
}

/**
 * The SHIPPED propose request: `planningChain()` with the authority member and its paired
 * submission hash overlaid on the propose terminal (task-074e6d2e).
 *
 * The overlay lives HERE rather than inside `planningChain()` on purpose, and it is the row's
 * load-bearing shape decision. `planningChain()` is imported by suites whose subject is the
 * authority-LESS world — the legacy pin at `planning-authority-persistence.test.ts:257-274`
 * above all — so sealing the shared builder would not have reddened them honestly; it would
 * have left the pin GREEN while silently exercising a sealed chain. Sealing at the call site
 * keeps the builder byte-identical and gives the shipped journey the sealed one.
 *
 * The member rides the PROPOSE terminal and only the propose terminal: `planning-services.ts`
 * returns `commitFinalizedSubmission` at :132 BEFORE `buildPlanningAuthorityLeg` at :136, so a
 * finalize request never reads it — and `callerSuppliedAuthorityBodies` lists `"authority"`
 * among its forbidden keys, so a finalize carrying it is refused outright
 * (`PLANNING_FINALIZE_BODIES_SUPPLIED`, `DAEMON_INGRESS`, :120-122) rather than merely ignored.
 */
export function sealedPlanningChain(): readonly Record<string, unknown>[] {
  const chain = [...planningChain()];
  const propose = chain[chain.length - 1];
  if (propose === undefined) throw new Error("planningChain() is empty");
  chain[chain.length - 1] = {
    ...propose,
    authority: AUTHORITY_MEMBER,
    // A SIBLING of `authority`, never inside it: `authorityOf` is exact-keyed to two names and
    // refuses a third (PLANNING_AUTHORITY_MALFORMED). Mandatory since task-c96ef2d1, so a
    // journey that stopped carrying it would be refused rather than silently body-less.
    graphContentBytesBase64: SEALED_GRAPH_CONTENT_BYTES,
    submissionHash: SEALED_SUBMISSION_HASH,
  };
  return chain;
}

/**
 * The finalize terminal, in a request of its OWN. `classifyPlanningChain` refuses a chain that
 * holds both terminals with PLANNING_FINALIZE_CHAIN_MIXED — they are mutually exclusive by
 * design, because each business effect owes its own durable decision — so the shipped journey
 * finalizes by issuing a SECOND `plan.propose` whose chain is exactly this one command, never by
 * growing `planningChain()` a fifth element.
 */
export function finalizeChain(): readonly Record<string, unknown>[] {
  return [
    {
      commandId: "chain-finalize",
      expectedVersion: 4,
      kind: "planning.finalize_submission",
      revision: {
        dependencyHash: hex64("d1"),
        // The producer's RECOMPUTED hash. `planning-authority-envelope.ts:104` cross-checks this
        // against the sealed plan revision's own `graphBinding.graphContentHash`, so a stale
        // literal here refuses the whole finalize with PLANNING_AUTHORITY_GRAPH_CONTENT_MISMATCH.
        graphContentHash: SEALED_GRAPH_CONTENT_HASH,
        graphRevisionRef: GRAPH_REVISION_REF,
        // The run's SEALED plan hash: the propose terminal sealed the plan body whose own
        // `planHash` this is, and the finalize is judged against that folded state.
        planHash: SEALED_SUBMISSION_HASH,
        qualityHash: hex64("dd"),
      },
      witness: {
        attemptTerminalRef: "attempt-terminal-1",
        effectTerminalRef: "effect-terminal-1",
        nodeSummaries: [{ executionBearing: true, nodeKey: "node-a" }],
        providerSlotTerminalRef: "slot-terminal-1",
        resourcesTerminalRef: "resources-terminal-1",
        truthClass: "DAEMON_VERIFIED",
      },
    },
  ];
}

export function approvalCommand(): Record<string, unknown> {
  return {
    decision: "APPROVE",
    decisionReason: "reason-1",
    kind: "approval.decide",
    stepUpAuthRef: "stepup-1",
  };
}

/**
 * The core's `PlanningActivationWitness` (planning-command-contract.ts:117). The daemon consumes
 * `expectedGoalVersion` and hands it to `reduceGoal`; every other field is the caller's evidence.
 * `expectedGoalVersion` is 1 because the approval follows `goal.create`, which leaves the goal at
 * domain version 1.
 */
export function planningActivation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    activationRef: "activation-1",
    // NO `budgetHash` (task-1de7b81a). It used to be the placeholder hex64("b0"), and the
    // approve path now derives the real one from the genesis budget root it builds and commits.
    // A caller may still state an expectation — one that disagrees is refused
    // BOOTSTRAP_BUDGET_HASH_MISMATCH — but it cannot supply the durable value, so a fixture that
    // kept a placeholder here would only be asserting that the server refuses it.
    expectedGoalVersion: 1,
    goalDraftNoActiveRevision: true,
    graphHash: hex64("6a"),
    policyHash: hex64("b1"),
    qualityHash: hex64("dd"),
    truthClass: "HUMAN_APPROVED",
    ...overrides,
  };
}

/** J1's second human action: one approval that also activates the initial graph (design 299). */
export function approvalPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    activation: planningActivation(),
    command: approvalCommand(),
    graphRevisionRef: GRAPH_REVISION_REF,
    record: approvalRecord(SEALED_SUBMISSION_HASH),
    runId: RUN_ID,
    ...overrides,
  };
}

/** The core's `AcceptanceClosureWitness`: the verified result and the obligations that hold. */
export function closureWitness(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    acceptanceClosureRef: "acceptance-1",
    completionNodeAcceptedRef: "completion-node-1",
    noCurrentPreparationGeneration: true,
    noPendingDraftOrSupersession: true,
    obligationsHoldRef: "obligations-1",
    truthClass: "HUMAN_APPROVED",
    ...overrides,
  };
}

/** The core's `ZeroAuthorityWitness`: no authority outlives the accepted goal. */
export function zeroAuthorityWitness(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    truthClass: "DAEMON_VERIFIED",
    zeroAuthorityProofRef: "zero-authority-1",
    ...overrides,
  };
}

/** J1's third human action: final acceptance of the verified, reviewed result. */
export function acceptancePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    closureWitness: closureWitness(),
    goalId: GOAL_ID,
    zeroAuthorityWitness: zeroAuthorityWitness(),
    ...overrides,
  };
}

export function approvalRecord(exactRevisionHash: string): Record<string, unknown> {
  return {
    actor: "human-1",
    actorKind: "HUMAN",
    applicablePolicyRef: hex64("aa"),
    approvalRef: "approval-1",
    approvedNodeScope: ["node-1"],
    budgetRef: hex64("bb"),
    criteriaRef: hex64("cc"),
    decision: null,
    decisionReason: null,
    dependencyChanges: { additions: [], challenges: [], removals: [] },
    exactRevisionHash,
    lifecycle: "PENDING",
    planQualityAssessmentRef: hex64("dd"),
    policyDecisionRef: null,
    riskTier: "R2",
    stepUpAuthRef: "stepup-1",
    truthClass: "HUMAN_APPROVED",
    validity: "CURRENT",
  };
}

/** The eleven owned commands in durable order; every other fixture is derived from this list. */
export function bootstrapSequence(): readonly Envelope[] {
  return [
    envelope("project.register", 0, { owner: "owner-1" }),
    envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    envelope("provider.probe", 0, { observation: PROVIDER_OBSERVATION }),
    envelope("policy.install", 0, { slice: POLICY_SLICE }),
    envelope("policy.validate", 1, { input: evaluationInput(POLICY_REF) }),
    envelope("project.activate", 2, { witness: ACTIVATION_WITNESS }),
    envelope("goal.create", 0, goalPayload()),
    envelope("plan.propose", 0, { commands: sealedPlanningChain(), runId: RUN_ID }),
    // The shipped journey FINALIZES before it approves: this request carries the finalize
    // terminal alone, so the run reaches `approval.decide` at lifecycle PLAN_REVIEW with a
    // durable graphRevisionRef instead of the PLANNING state a propose-only chain leaves.
    envelope("plan.propose", 0, { commands: finalizeChain(), runId: RUN_ID }, "cmd-finalize"),
    envelope("approval.decide", 0, approvalPayload()),
    // The goal is at domain version 2 here: `goal.create` left it at 1 and the approval's
    // activation half advanced it to 2 in the same decision.
    envelope("goal.close", 2, acceptancePayload()),
  ];
}

/**
 * Drives the durable sequence up to but NOT including `upToKind`, through the production
 * pipeline. It throws rather than swallowing a setup refusal, so a fixture that silently stops
 * short cannot leave a later assertion testing an empty store.
 */
export function driveThrough(store: SqliteEventStore, upToKind: string): void {
  for (const request of bootstrapSequence()) {
    if (request.kind === upToKind) return;
    const outcome = send(store, request);
    if (!outcome.ok) {
      throw new Error(`fixture setup failed at ${request.kind}: ${outcome.code}`);
    }
  }
}
