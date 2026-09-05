export const REPOSITORY_EXECUTION_PHASES = Object.freeze([
  "RESERVED", "EXECUTING", "VERIFYING", "AWAITING_LANDING", "LANDING", "BLOCKED",
] as const);
export type RepositoryExecutionPhase = typeof REPOSITORY_EXECUTION_PHASES[number];

/** Daemon-only authority. Never serialize an owner or handle onto a public surface. */
export interface RepositoryExecutionOwner {
  readonly projectId: string;
  readonly nodeRef: string;
  readonly ownershipToken: string;
  readonly storeId: string;
}
export interface RepositoryExecutionIdentity {
  readonly root: string;
  readonly gitDirectory: string;
}
export interface RepositoryExecutionController {
  readonly controllerId: string;
  readonly controllerPid: number;
}
export interface RepositoryExecutionState extends RepositoryExecutionController {
  readonly phase: RepositoryExecutionPhase;
  readonly baselineId: string | null;
  readonly sessionId: string | null;
  readonly pid: number | null;
}
/** Daemon observation: public presentation must omit paths, controller tokens and process fields. */
export interface RepositoryExecutionSnapshot extends RepositoryExecutionState {
  readonly revision: number;
  readonly projectId: string;
  readonly nodeRef: string;
  readonly storeId: string;
  readonly identity: RepositoryExecutionIdentity;
}
export interface RepositoryExecutionHandle {
  readonly owner: RepositoryExecutionOwner;
  readonly reservation: RepositoryExecutionSnapshot;
}
export type RepositoryExecutionCode = "REPOSITORY_IDENTITY_UNKNOWN" | "REPOSITORY_EXECUTION_BUSY"
  | "REPOSITORY_EXECUTION_UNKNOWN" | "REPOSITORY_EXECUTION_OWNER_MISMATCH"
  | "REPOSITORY_EXECUTION_REVISION_CONFLICT" | "REPOSITORY_EXECUTION_TRANSITION_INVALID"
  | "REPOSITORY_EXECUTION_BASELINE_MISMATCH" | "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH";
export type RepositoryExecutionResult<T> = Readonly<{ ok: true } & T>
  | Readonly<{ ok: false; code: RepositoryExecutionCode; detail: string }>;
export interface RepositoryExecutionPort {
  acquire(workspace: string, owner: RepositoryExecutionOwner, controller: RepositoryExecutionController): RepositoryExecutionResult<{ handle: RepositoryExecutionHandle }>;
  inspect(workspace: string): RepositoryExecutionResult<{ reservation: RepositoryExecutionSnapshot | null }>;
  /** Internal recovery read. Possession never proves child death or permits automatic resumption. */
  readOwned(workspace: string, storeId: string, projectId: string): RepositoryExecutionResult<{ handle: RepositoryExecutionHandle | null }>;
  /** Caller must independently prove the old controller is dead. Never adopt its token. */
  claimController(workspace: string, owner: RepositoryExecutionOwner, expectedRevision: number,
    controller: RepositoryExecutionController): RepositoryExecutionResult<{ handle: RepositoryExecutionHandle }>;
  /** Caller must prove child death/claim retirement before returning to RESERVED. */
  transition(workspace: string, owner: RepositoryExecutionOwner, expectedRevision: number,
    state: RepositoryExecutionState): RepositoryExecutionResult<{ handle: RepositoryExecutionHandle }>;
  /** Caller supplies successful landing evidence; this primitive never infers a Git commit. */
  release(workspace: string, owner: RepositoryExecutionOwner, expectedRevision: number,
    reason: "ABORTED_BEFORE_EXECUTION" | "LANDED", controllerId: string): RepositoryExecutionResult<{ released: true }>;
}

export function repositoryExecutionFailure(code: RepositoryExecutionCode): RepositoryExecutionResult<never> {
  // No input, persisted token, database error, or machine path enters refusal details.
  return Object.freeze({ ok: false, code, detail: code });
}
