import type { RepositoryExecutionCode, RepositoryExecutionController, RepositoryExecutionHandle, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";

export const REPOSITORY_DELIVERY_LAYER = "REPOSITORY_DELIVERY" as const;
export const REPOSITORY_DELIVERY_REFUSAL_CODES = Object.freeze([
  "REPOSITORY_IDENTITY_UNKNOWN", "REPOSITORY_EXECUTION_BUSY", "REPOSITORY_EXECUTION_UNKNOWN",
  "REPOSITORY_EXECUTION_OWNER_MISMATCH", "REPOSITORY_EXECUTION_REVISION_CONFLICT",
  "REPOSITORY_EXECUTION_TRANSITION_INVALID", "REPOSITORY_EXECUTION_BASELINE_MISMATCH",
  "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH", "REPOSITORY_DELIVERY_BASELINE_UNAVAILABLE",
  "REPOSITORY_DELIVERY_LANDING_REQUIRED", "REPOSITORY_DELIVERY_WORKSPACE_REQUIRED",
  "REPOSITORY_DELIVERY_CLOSED",
] as const);
export type RepositoryDeliveryRefusal = Readonly<{ ok: false; layer: typeof REPOSITORY_DELIVERY_LAYER;
  code: RepositoryExecutionCode | typeof REPOSITORY_DELIVERY_REFUSAL_CODES[number] }>;
export type RepositoryDeliveryFacts = "READY" | "SUBMITTED" | "ACCEPTED" | "LANDED" | "REFUSED" | "UNKNOWN";
export interface RepositoryDeliveryConfig {
  readonly baseline: (nodeRef: string, reservedRoot: string) => Promise<string | null>;
  readonly controller: RepositoryExecutionController;
  readonly facts: (nodeRef: string) => RepositoryDeliveryFacts;
  readonly isProcessAlive: (pid: number) => boolean;
  /** RETRY is permitted only for a known refusal before any commit/ref effect. */
  readonly land: (nodeRef: string, baselineId: string, reservedRoot: string, handle: RepositoryExecutionHandle) => Promise<"RETRY" | void>;
  readonly port: RepositoryExecutionPort;
  readonly projectId: string;
  /** Both durable claim and staffing evidence must permit retirement. */
  readonly retired: (nodeRef: string) => boolean;
  readonly storeId: string;
  readonly verify: (nodeRef: string, reservedRoot: string) => Promise<void>;
  readonly workspaces: () => readonly string[];
}
export function deliveryRefusal(code: RepositoryDeliveryRefusal["code"]): RepositoryDeliveryRefusal {
  return { ok: false, code, layer: REPOSITORY_DELIVERY_LAYER };
}
