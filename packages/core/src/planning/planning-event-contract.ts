import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";
import type { PlanAuthorityIdentity } from "./planning-authority-submission.js";
import type {
  PlanRevisionHashes,
  PlanningAbsenceRecoveryWitness,
  PlanningActivationWitness,
  PlanningCancellationWitness,
  PlanningClaimWitness,
  PlanningExpansionHoldBinding,
  PlanningExpansionProposalIdentity,
  PlanningReadinessWitness,
  PlanningReleaseWitness,
  PlanningRunKind,
} from "./planning-command-contract.js";

export type PlanningRunLifecycle = typeof RUNTIME_LIFECYCLES.PLANNING_RUN[number];

/**
 * Ownership and planner-effect liveness are run facets, never lifecycle states: the
 * `PLANNING_RUN` vocabulary is closed and `SUSPECT` belongs to the lease aggregate.
 */
export interface PlanningRunFacets {
  readonly leaseSuspect: boolean;
  readonly livePlannerEffect: boolean;
  readonly owned: boolean;
  readonly resumable: boolean;
}

export interface PlanningRunState {
  readonly approvedHashes: PlanRevisionHashes | null;
  readonly attemptRef: string | null;
  readonly facets: PlanningRunFacets;
  readonly goalRef: string;
  readonly graphRevisionRef: string | null;
  readonly leaseRef: string | null;
  readonly lifecycle: PlanningRunLifecycle;
  readonly runId: string;
  readonly runKind: PlanningRunKind;
  readonly sealedHashes: PlanRevisionHashes | null;
  readonly submissionHash: string | null;
  readonly version: number;
}

export type PlanningRunSuccessorData =
  Omit<PlanningRunState, "version"> & { readonly version: 1 };

/**
 * The EXPANSION projection of a run's state. `PlanningRunState` itself is deliberately left
 * byte-identical: `clonedState` spreads `Partial<PlanningRunState>` over it, and a discriminated
 * union there produces a cross-product whose mixed members are unassignable, which breaks
 * `planning-results.ts` and `planning-run-test-fixtures.ts` — measured, not assumed. Every
 * `PlanningRunContractState` still widens to a `PlanningRunState`, so this narrows the contract
 * surface without forking the aggregate. `sealedProposal` is null until a submission is sealed
 * and carries the exact identity afterward; a stale or cross-kind shape is refused, never
 * normalized. Representability alone enables no transition: the reducer still answers
 * PLANNING_KIND_UNSUPPORTED for every non-INITIAL kind.
 */
export type PlanningRunContractState =
  | (PlanningRunState & { readonly runKind: "INITIAL" | "REVISION" })
  | (PlanningRunState & { readonly expansion: PlanningExpansionHoldBinding;
    readonly runKind: "EXPANSION";
    readonly sealedProposal: PlanningExpansionProposalIdentity | null });

interface PlanningRunEventBase {
  readonly commandId: string;
  readonly version: number;
}

interface PlanningRunCreatedBase extends PlanningRunEventBase {
  readonly goalRef: string; readonly kind: "PlanningRunCreated"; readonly runId: string;
}

/** INITIAL and REVISION serialize to exactly their committed keys and bytes. */
export type PlanningRunCreated =
  | (PlanningRunCreatedBase & { readonly runKind: "INITIAL" | "REVISION" })
  | (PlanningRunCreatedBase & { readonly expansion: PlanningExpansionHoldBinding;
    readonly runKind: "EXPANSION" });

export interface PlanningRunReady extends PlanningRunEventBase {
  readonly kind: "PlanningRunReady";
  readonly witness: PlanningReadinessWitness;
}

export interface PlanningClaimed extends PlanningRunEventBase {
  readonly kind: "PlanningClaimed";
  readonly resumed: boolean;
  readonly witness: PlanningClaimWitness;
}

export interface PlanningReleased extends PlanningRunEventBase {
  readonly kind: "PlanningReleased";
  readonly witness: PlanningReleaseWitness;
}

export interface PlanningRecoveredAbsent extends PlanningRunEventBase {
  readonly kind: "PlanningRecoveredAbsent";
  readonly witness: PlanningAbsenceRecoveryWitness;
}

interface PlanningSubmissionSealedBase extends PlanningRunEventBase {
  readonly draining: boolean; readonly kind: "PlanningSubmissionSealed";
  readonly submissionHash: string;
}

/**
 * The committed sealed event carries no run-kind discriminator, so the legacy branch stays
 * exactly its old shape and only the EXPANSION branch adds `proposalKind`. `authority` is
 * OPTIONAL and omitted entirely on an authority-less proposal, so those bytes are unchanged; the
 * EXPANSION branch never carries it, because its own exact key roster admits the sealed event.
 */
export type PlanningSubmissionSealed =
  | (PlanningSubmissionSealedBase & { readonly authority?: PlanAuthorityIdentity })
  | (PlanningSubmissionSealedBase & { readonly expansion: PlanningExpansionHoldBinding;
    readonly proposalKind: "EXPANSION";
    readonly sealedProposal: PlanningExpansionProposalIdentity });

export interface PlanRevisionCreated extends PlanningRunEventBase {
  readonly hashes: PlanRevisionHashes;
  readonly graphRevisionRef: string;
  readonly kind: "PlanRevisionCreated";
}

export interface PlanningRunRejected extends PlanningRunEventBase {
  readonly findingsRef: string;
  readonly kind: "PlanningRunRejected";
  readonly successorRunId: string;
}

export interface PlanApproved extends PlanningRunEventBase {
  readonly hashes: PlanRevisionHashes;
  readonly kind: "PlanApproved";
}

export interface PlanningRunActivated extends PlanningRunEventBase {
  readonly kind: "PlanningRunActivated";
  readonly witness: PlanningActivationWitness;
}

export interface PlanningRunCancelled extends PlanningRunEventBase {
  readonly kind: "PlanningRunCancelled";
  readonly witness: PlanningCancellationWitness;
}

export type PlanningRunEvent =
  | PlanningRunCreated
  | PlanningRunReady
  | PlanningClaimed
  | PlanningReleased
  | PlanningRecoveredAbsent
  | PlanningSubmissionSealed
  | PlanRevisionCreated
  | PlanningRunRejected
  | PlanApproved
  | PlanningRunActivated
  | PlanningRunCancelled;

export interface PlanningRunAcceptedResult {
  readonly events: readonly PlanningRunEvent[];
  readonly ok: true;
  readonly state: PlanningRunState;
  readonly successor?: PlanningRunSuccessorData;
}

export interface PlanningRunRejectedResult {
  readonly error: RuntimeError;
  readonly ok: false;
}

export type PlanningUnsupportedReason =
  | "MULTI_NODE_EXECUTION_UNSUPPORTED"
  | "PLANNING_KIND_UNSUPPORTED";

/**
 * Deliberate exception to registry-only rejections. `RUNTIME_ERROR_CODES` is closed and holds
 * no UNSUPPORTED family, and the `FANOUT_*` codes cannot carry the refused node identities
 * because `RUNTIME_SAFE_DETAIL_KEYS` has no count or key-list slot. Design lines 396 and 1322
 * require a *typed* `UNSUPPORTED`, so this third union member carries the structural facts and
 * never a `RuntimeError`. Domain-local typed refusals are precedented by
 * `SKILL_MANIFEST_VERSION_UNSUPPORTED` and `RUNNER_WORKSPACE_PATH_KIND_UNSUPPORTED`.
 *
 * It is raised on exactly two paths: multi-node admission at submission finalization, and
 * `REVISION`/`EXPANSION` planning kinds. State never changes when it is returned; the daemon's
 * required follow-up for a refused admission is a refusal finalization (design row 293), which
 * moves the run to `REJECTED` with successor data.
 */
export interface PlanningUnsupportedResult {
  readonly executionBearingNodeKeys: readonly string[];
  readonly ok: false;
  readonly reason: PlanningUnsupportedReason;
  readonly unsupported: true;
}

export type PlanningRunReducerResult =
  | PlanningRunAcceptedResult
  | PlanningRunRejectedResult
  | PlanningUnsupportedResult;
