import { createHash } from "node:crypto";

import { createAcceptanceContract } from "./acceptance-contract-codec.js";
import type { AcceptanceContract } from "./acceptance-contract.js";
import { createPlanRevision } from "./plan-revision-codec.js";
import type { PlanRevision } from "./plan-revision-contract.js";
import { reducePlanningRun } from "./planning-run-reducer.js";
import type { PlanningRunCommand, PlanningRunState } from "./planning-contract.js";

/**
 * Fixtures for the plan.propose authority carrier. Every record is minted through the PRODUCTION
 * codecs (`createPlanRevision` / `createAcceptanceContract`) so its carried digest is real, and
 * every run state is produced by the CORE reducer's own transitions rather than hand-shaped: an
 * arm that refuses has to refuse against a body the production surface itself would accept.
 *
 * Deviations are expressed as DRAFT patches, not as edits to an admitted record, so the digest
 * recomputes for the deviated body. That isolation matters: a patched admitted record would be
 * refused for a stale digest by an EARLIER layer and the arm under test would never be reached.
 */
export const TRUTH = "DAEMON_VERIFIED" as const;
export const GOAL_REF = "goal-plan-authority";
export const RUN_ID = "run-plan-authority";
export const GRAPH_REVISION_REF = "graph-revision-plan-authority";
export const CONTRACT_ID = "contract-plan-authority";
export const REVISION_ID = "revision-plan-authority";
export const CRITERION_IDS = Object.freeze(["criterion-a", "criterion-b"]);
export const AUTHOR_REF = "architect-plan-authority";

export const hex = (seed: string): string =>
  createHash("sha256").update(seed, "utf8").digest("hex");

export const GRAPH_CONTENT_HASH = hex("graph-content-plan-authority");
/** Never a real body digest, so a mismatch arm cannot accidentally agree with one. */
export const FOREIGN_HEX = hex("foreign-plan-authority");

type Draft = Readonly<Record<string, unknown>>;

export function revisionDraft(): Draft {
  return {
    affectedCriterionIds: [...CRITERION_IDS],
    affectedNodeIds: ["node-a"],
    approvalState: "PENDING_APPROVAL",
    authorRef: AUTHOR_REF,
    graphBinding: { graphContentHash: GRAPH_CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: REVISION_ID,
    steps: [{ description: "seal the planning authority", kind: "ANALYSIS", stepId: "step-00001" }],
    verificationRecipeRefs: ["recipe-gate"],
  };
}

export function contractDraft(): Draft {
  return {
    applicability: {
      graphContentHash: GRAPH_CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF,
      nodeIds: ["node-a"], nodeKind: "LEAF",
    },
    authorRef: AUTHOR_REF,
    contractId: CONTRACT_ID,
    obligations: CRITERION_IDS.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [{
        evidenceRef: `evidence-${criterionId}`, kind: "VERIFICATION_RECEIPT",
        requirementId: `requirement-${criterionId}`,
      }],
      statement: `the run satisfies ${criterionId}`,
      verificationRecipeRefs: [`recipe-${criterionId}`],
    })),
  };
}

export function buildRevision(patch: Draft = {}): PlanRevision {
  const result = createPlanRevision({ ...revisionDraft(), ...patch });
  if (!result.ok) {
    throw new Error(`plan revision fixture refused: ${result.code}@${result.layer}`);
  }
  return result.revision;
}

export function buildContract(patch: Draft = {}): AcceptanceContract {
  const result = createAcceptanceContract({ ...contractDraft(), ...patch });
  if (!result.ok) {
    throw new Error(`acceptance contract fixture refused: ${result.code}@${result.layer}`);
  }
  return result.contract;
}

export interface AuthorityFixture {
  readonly acceptanceContract: AcceptanceContract;
  readonly planRevision: PlanRevision;
}

/** The one shape the command carries: exactly two canonical bodies, nothing else. */
export function buildAuthority(
  revisionPatch: Draft = {}, contractPatch: Draft = {},
): AuthorityFixture {
  return {
    acceptanceContract: buildContract(contractPatch),
    planRevision: buildRevision(revisionPatch),
  };
}

function reduceOrThrow(state: PlanningRunState | undefined, command: unknown): PlanningRunState {
  const result = reducePlanningRun(state, command as PlanningRunCommand);
  if (!result.ok) {
    throw new Error(`planning reducer refused the fixture chain: ${JSON.stringify(result)}`);
  }
  return result.state;
}

/** create_draft -> ready -> claim: the exact lifecycle a real plan.propose arrives into. */
export function claimedState(): PlanningRunState {
  const draft = reduceOrThrow(undefined, {
    commandId: "cmd-create", expectedVersion: 0, goalRef: GOAL_REF,
    kind: "planning.create_draft", runId: RUN_ID, runKind: "INITIAL",
  });
  const ready = reduceOrThrow(draft, {
    commandId: "cmd-ready", expectedVersion: 1, kind: "planning.ready",
    witness: {
      acceptanceCriteriaRef: "criteria-ref", intentBaseRef: "intent-ref",
      planningBudgetRef: "budget-ref", truthClass: TRUTH,
    },
  });
  return reduceOrThrow(ready, {
    commandId: "cmd-claim", expectedVersion: 2, kind: "planning.claim",
    witness: {
      attemptRef: "attempt-ref", contextRef: "context-ref", leaseRef: "lease-ref",
      providerSlotRef: "slot-ref", truthClass: TRUTH,
    },
  });
}

export const PROPOSE_WITNESS = Object.freeze({
  attemptRef: "attempt-ref", submissionRef: "submission-ref", truthClass: TRUTH,
});

/**
 * A nonempty, fully valid INITIAL proposal. `submissionHash` defaults to the revision's own
 * recomputed digest, which is the agreement DoD 1 requires of the legacy field.
 */
export function proposeCommand(patch: Readonly<Record<string, unknown>> = {}): unknown {
  const authority = buildAuthority();
  return {
    authority, commandId: "cmd-propose", expectedVersion: 3, kind: "plan.propose",
    proposalKind: "INITIAL", submissionHash: authority.planRevision.planHash,
    witness: { ...PROPOSE_WITNESS }, ...patch,
  };
}
