import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeError, RuntimeTruthClass } from "@moe/contracts";

export type ProjectLifecycle = typeof RUNTIME_LIFECYCLES.PROJECT[number];
// DEGRADED is representable but has no design-authorized reducer edge pending a design sync.

export type ProjectCommandKind =
  | "project.register"
  | "project.bind_repository"
  | "project.activate"
  | "recovery.restore_quiesce"
  | "recovery.complete";

interface ProjectCommandBase {
  readonly commandId: string;
  readonly expectedVersion: number;
}

export interface RepositoryObservation {
  readonly baseRevisionHash: string;
  readonly repositoryRef: string;
  readonly scopeRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface ProjectActivationWitness {
  readonly artifactPathRef: string;
  readonly backupPathRef: string;
  readonly credentialRef: string;
  readonly distributionManifestHash: string;
  readonly policyRevisionHash: string;
  readonly providerMinimumProfileRef: string;
  readonly signingKeyRef: string;
  readonly storeDriverRef: string;
  readonly truthClass: RuntimeTruthClass;
}

/** Internal restore-controller proof; this is not a public protocol command. */
export interface RestoreQuiesceWitness {
  readonly backupGenerationHash: string;
  readonly recoveryIncarnationRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface RecoveryCompletionWitness {
  readonly coverageProofHash: string;
  readonly inventoryReconciliationHash: string;
  readonly recoveryDecisionRef: string;
  readonly recoveryIncarnationRef: string;
  readonly truthClass: RuntimeTruthClass;
}

export interface ProjectRegisterCommand extends ProjectCommandBase {
  readonly kind: "project.register";
  readonly owner: string;
  readonly projectId: string;
}

export interface ProjectBindRepositoryCommand extends ProjectCommandBase {
  readonly kind: "project.bind_repository";
  readonly observation: RepositoryObservation;
}

export interface ProjectActivateCommand extends ProjectCommandBase {
  readonly kind: "project.activate";
  readonly witness: ProjectActivationWitness;
}

export interface RestoreQuiesceCommand extends ProjectCommandBase {
  readonly kind: "recovery.restore_quiesce";
  readonly witness: RestoreQuiesceWitness;
}

export interface RecoveryCompleteCommand extends ProjectCommandBase {
  readonly kind: "recovery.complete";
  readonly witness: RecoveryCompletionWitness;
}

export type ProjectCommand =
  | ProjectRegisterCommand
  | ProjectBindRepositoryCommand
  | ProjectActivateCommand
  | RestoreQuiesceCommand
  | RecoveryCompleteCommand;

export interface ProjectState {
  readonly lifecycle: ProjectLifecycle;
  readonly owner: string;
  readonly projectId: string;
  readonly recoveryRequired: boolean;
  readonly repositoryObservations: readonly RepositoryObservation[];
  readonly version: number;
}

interface ProjectEventBase {
  readonly commandId: string;
  readonly version: number;
}

export interface ProjectRegistered extends ProjectEventBase {
  readonly kind: "ProjectRegistered";
  readonly owner: string;
  readonly projectId: string;
}

export interface RepositoryBound extends ProjectEventBase {
  readonly kind: "RepositoryBound";
  readonly observation: RepositoryObservation;
}

export interface ProjectActivated extends ProjectEventBase {
  readonly kind: "ProjectActivated";
  readonly witness: ProjectActivationWitness;
}

export interface ProjectQuiesced extends ProjectEventBase {
  readonly kind: "ProjectQuiesced";
  readonly witness: RestoreQuiesceWitness;
}

export interface ProjectRecovered extends ProjectEventBase {
  readonly kind: "ProjectRecovered";
  readonly witness: RecoveryCompletionWitness;
}

export type ProjectEvent =
  | ProjectRegistered
  | RepositoryBound
  | ProjectActivated
  | ProjectQuiesced
  | ProjectRecovered;

export interface ProjectAcceptedResult {
  readonly events: readonly ProjectEvent[];
  readonly ok: true;
  readonly state: ProjectState;
}

export interface ProjectRejectedResult {
  readonly error: RuntimeError;
  readonly ok: false;
}

export type ProjectReducerResult = ProjectAcceptedResult | ProjectRejectedResult;
