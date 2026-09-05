import type { NextAllowedCommand } from "@moe/contracts";
import type { RepositoryExecutionPhase } from "./repository-execution-contracts.js";

export const REPOSITORY_RECOVERY_COMMAND_KIND = "repository.recover" as const;
export const REPOSITORY_RECOVERY_VERSION = "moe-repository-recovery/1" as const;
export const REPOSITORY_RECOVERY_LAYER = "REPOSITORY_RECOVERY" as const;
export const REPOSITORY_RECOVERY_ACTIONS = ["ABORT_UNEXECUTED", "RECONCILE_LANDED"] as const;
export type RepositoryRecoveryAction = typeof REPOSITORY_RECOVERY_ACTIONS[number];
export interface RepositoryRecoveryPayload {
  readonly action: RepositoryRecoveryAction;
  readonly decision: "APPROVE";
  readonly expectedReservationRevision: number;
  readonly nodeRef: string;
  readonly reason: string;
}
export interface RepositoryRecoveryRefusal {
  readonly ok: false;
  readonly code: string;
  readonly layer: typeof REPOSITORY_RECOVERY_LAYER;
  readonly detail: string;
}
export type RepositoryRecoveryResult<T> = ({ readonly ok: true } & T) | RepositoryRecoveryRefusal;
export interface RepositoryRecoveryActionView {
  readonly action: RepositoryRecoveryAction;
  readonly available: boolean;
  readonly code: string | null;
  readonly offer: NextAllowedCommand | null;
}
export interface RepositoryRecoveryView {
  readonly version: typeof REPOSITORY_RECOVERY_VERSION;
  readonly projectId: string;
  readonly reservations: readonly {
    readonly nodeRef: string;
    readonly phase: RepositoryExecutionPhase;
    readonly expectedReservationRevision: number;
    readonly actions: readonly RepositoryRecoveryActionView[];
  }[];
  readonly code: string | null;
}
export const recoveryRefusal = (code: string): RepositoryRecoveryRefusal =>
  Object.freeze({ ok: false, code, layer: REPOSITORY_RECOVERY_LAYER, detail: code });
