/**
 * The DURABLE approved-plan and criteria readers.
 *
 * CONSUMER: task-c320c34a's Foundation context matrix rows "approved plan" and "criteria".
 * `readApprovedPlan` cashes the first, `readApprovedCriteria` the second.
 *
 * Both answer from COMMITTED EVENTS ONLY. No spec file, no `nodeSpecsDir` mission, no request
 * field: a validator over caller input is not a reader, and a shared-tree-writable file is not
 * authority. The walk from an approved goal to the sealed bodies lives in
 * `planning-authority-reader-seal.ts`; both readers go through that ONE locator so neither can
 * drift into a second opinion about what "approved" means.
 *
 * A LEGACY witness — one written before task-2cc6c59d, whose four binding keys are ABSENT — is
 * served UNKNOWN. It is never handed an empty plan or an empty contract: a caller must not be
 * able to read "no steps" as an answer about the plan. Every refusal below carries only a code, a
 * layer, a short closed `detail` and, where a lower authority decided, that authority's own code
 * and layer under `source`.
 *
 * WHAT THE DECODED BODIES EXPOSE, for task-fc9660b0's re-planner: `PlanRevision.steps` is
 * `{description, kind, stepId}` and `AcceptanceContract.obligations` is
 * `{criterionId, evidenceRequirements, statement, verificationRecipeRefs}`. Whether the producer's
 * mission quad {instructions, test, title, workspace} derives from these or needs its own producer
 * is that row's first measurement, not a claim made here.
 */
import type { AcceptanceContract, PlanRevision } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { locateSealedAuthority } from "./planning-authority-reader-seal.js";
import type { PlanningAuthorityReaderRefusal } from "./planning-authority-reader-contract.js";

export { PLANNING_AUTHORITY_READER_CODES } from "./planning-authority-reader-contract.js";
export type {
  PlanningAuthorityReaderCode,
  PlanningAuthorityReaderLayer,
  PlanningAuthorityReaderRefusal,
  PlanningAuthorityReaderSource,
} from "./planning-authority-reader-contract.js";

export interface ApprovedPlanRead {
  readonly authorityRef: string;
  readonly graphRevisionRef: string;
  readonly ok: true;
  readonly planHash: string;
  readonly revision: PlanRevision;
  readonly revisionId: string;
  readonly runId: string;
}

export interface ApprovedCriteriaRead {
  readonly contract: AcceptanceContract;
  readonly criteriaDigest: string;
  readonly criteriaRef: string;
  readonly ok: true;
  readonly runId: string;
}

export type ApprovedPlanResult = ApprovedPlanRead | PlanningAuthorityReaderRefusal;
export type ApprovedCriteriaResult = ApprovedCriteriaRead | PlanningAuthorityReaderRefusal;

/**
 * The approved plan of `goalId`, or the refusal naming which check answered.
 *
 * Every scalar is taken off the DECODED revision rather than off the sealed payload's convenience
 * copies of the same fields: the decoded record is digest-bound, so a payload scalar edited alone
 * cannot move the answer.
 */
export function readApprovedPlan(
  store: SqliteEventStore, projectId: string, goalId: string,
): ApprovedPlanResult {
  const located = locateSealedAuthority(store, projectId, goalId);
  if ("ok" in located) return located;
  return Object.freeze({
    authorityRef: located.authorityRef,
    graphRevisionRef: located.revision.graphBinding.graphRevisionRef,
    ok: true as const,
    planHash: located.revision.planHash,
    revision: located.revision,
    revisionId: located.revision.revisionId,
    runId: located.runId,
  });
}

/** The approved acceptance criteria of `goalId`, or the refusal naming which check answered. */
export function readApprovedCriteria(
  store: SqliteEventStore, projectId: string, goalId: string,
): ApprovedCriteriaResult {
  const located = locateSealedAuthority(store, projectId, goalId);
  if ("ok" in located) return located;
  return Object.freeze({
    contract: located.contract,
    criteriaDigest: located.contract.criteriaDigest,
    criteriaRef: located.contract.contractId,
    ok: true as const,
    runId: located.runId,
  });
}
