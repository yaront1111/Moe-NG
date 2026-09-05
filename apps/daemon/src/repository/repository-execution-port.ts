import { repositoryExecutionFailure } from "./repository-execution-contracts.js";
import type { RepositoryExecutionOwner, RepositoryExecutionPhase, RepositoryExecutionPort, RepositoryExecutionState } from "./repository-execution-contracts.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";
import { accessRepositoryExecution } from "./repository-execution-persistence.js";
import { executionHandle, sameExecutionOwner, validExecutionController, validExecutionOwner, validExecutionState } from "./repository-execution-record.js";
import type { RepositoryExecutionRecord } from "./repository-execution-record.js";

const NEXT: Readonly<Record<RepositoryExecutionPhase, readonly RepositoryExecutionPhase[]>> = {
  RESERVED: ["RESERVED", "EXECUTING", "BLOCKED"],
  EXECUTING: ["EXECUTING", "RESERVED", "VERIFYING", "BLOCKED"],
  VERIFYING: ["RESERVED", "AWAITING_LANDING", "BLOCKED"],
  AWAITING_LANDING: ["LANDING", "BLOCKED"], LANDING: ["AWAITING_LANDING", "BLOCKED"], BLOCKED: [],
};
function checkOwner(record: RepositoryExecutionRecord | null, owner: RepositoryExecutionOwner, revision: number) {
  if (record === null || !validExecutionOwner(owner) || !sameExecutionOwner(record.owner, owner)) {
    return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
  }
  if (!Number.isSafeInteger(revision) || record.revision !== revision) return repositoryExecutionFailure("REPOSITORY_EXECUTION_REVISION_CONFLICT");
  return { ok: true as const, record };
}
/** No clock or PID observation can transfer this durable logical reservation to a new owner. */
export function createRepositoryExecutionPort(): RepositoryExecutionPort {
  return Object.freeze<RepositoryExecutionPort>({
    acquire(workspace, owner, controller) {
      if (!validExecutionOwner(owner)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
      if (!validExecutionController(controller)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_CONTROLLER_MISMATCH");
      const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return resolved;
      const result = accessRepositoryExecution(resolved.identity, "CREATE", (record, nextRevision) => {
        if (record !== null) return repositoryExecutionFailure("REPOSITORY_EXECUTION_BUSY");
        const next: RepositoryExecutionRecord = { owner: { ...owner }, state: {
          phase: "RESERVED", baselineId: null, sessionId: null, pid: null,
          controllerId: controller.controllerId, controllerPid: controller.controllerPid,
        }, revision: nextRevision, everExecuted: false };
        return { ok: true, record: next, value: executionHandle(next, resolved.identity) };
      });
      return result.ok ? { ok: true, handle: result.value } : result;
    },
    inspect(workspace) {
      const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return resolved;
      const result = accessRepositoryExecution(resolved.identity, "READ", (record) => ({ ok: true, record,
        value: record === null ? null : executionHandle(record, resolved.identity).reservation }));
      return result.ok ? { ok: true, reservation: result.value } : result;
    },
    readOwned(workspace, storeId, projectId) {
      const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return resolved;
      const result = accessRepositoryExecution(resolved.identity, "READ", (record) => {
        if (record !== null && (record.owner.storeId !== storeId || record.owner.projectId !== projectId)) {
          return repositoryExecutionFailure("REPOSITORY_EXECUTION_OWNER_MISMATCH");
        }
        return { ok: true, record, value: record === null ? null : executionHandle(record, resolved.identity) };
      });
      return result.ok ? { ok: true, handle: result.value } : result;
    },
    claimController(workspace, owner, expectedRevision, controller) {
      if (!validExecutionController(controller)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_CONTROLLER_MISMATCH");
      const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return resolved;
      const result = accessRepositoryExecution(resolved.identity, "UPDATE", (record) => {
        const checked = checkOwner(record, owner, expectedRevision); if (!checked.ok) return checked;
        const prior = checked.record;
        const next = { ...prior, revision: prior.revision + 1, state: { ...prior.state,
          controllerId: controller.controllerId, controllerPid: controller.controllerPid } };
        return { ok: true, record: next, value: executionHandle(next, resolved.identity) };
      });
      return result.ok ? { ok: true, handle: result.value } : result;
    },
    transition(workspace, owner, expectedRevision, state) {
      const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return resolved;
      const result = accessRepositoryExecution(resolved.identity, "UPDATE", (record) => {
        const checked = checkOwner(record, owner, expectedRevision); if (!checked.ok) return checked;
        const prior = checked.record;
        if (!validExecutionController(state) || state.controllerId !== prior.state.controllerId || state.controllerPid !== prior.state.controllerPid) {
          return repositoryExecutionFailure("REPOSITORY_EXECUTION_CONTROLLER_MISMATCH");
        }
        if (prior.state.baselineId !== null && prior.state.baselineId !== state.baselineId) {
          return repositoryExecutionFailure("REPOSITORY_EXECUTION_BASELINE_MISMATCH");
        }
        if (!validExecutionState(state) || !NEXT[prior.state.phase].includes(state.phase)) return repositoryExecutionFailure("REPOSITORY_EXECUTION_TRANSITION_INVALID");
        // Session identity remains bound except when the caller explicitly returns to RESERVED.
        if (prior.state.phase !== "RESERVED" && state.phase !== "RESERVED"
          && (prior.state.sessionId !== state.sessionId || (prior.state.pid !== null && prior.state.pid !== state.pid))) {
          return repositoryExecutionFailure("REPOSITORY_EXECUTION_TRANSITION_INVALID");
        }
        const nextState: RepositoryExecutionState = { phase: state.phase, baselineId: state.baselineId, sessionId: state.sessionId, pid: state.pid,
          controllerId: state.controllerId, controllerPid: state.controllerPid };
        const next = { ...prior, state: nextState, revision: prior.revision + 1, everExecuted: prior.everExecuted || state.phase === "EXECUTING" };
        return { ok: true, record: next, value: executionHandle(next, resolved.identity) };
      });
      return result.ok ? { ok: true, handle: result.value } : result;
    },
    release(workspace, owner, expectedRevision, reason, controllerId) {
      const resolved = resolveRepositoryExecutionIdentity(workspace); if (!resolved.ok) return resolved;
      const result = accessRepositoryExecution(resolved.identity, "UPDATE", (record) => {
        const checked = checkOwner(record, owner, expectedRevision); if (!checked.ok) return checked;
        const prior = checked.record;
        if (controllerId !== prior.state.controllerId) return repositoryExecutionFailure("REPOSITORY_EXECUTION_CONTROLLER_MISMATCH");
        const allowed = reason === "LANDED" ? prior.state.phase === "LANDING"
          : reason === "ABORTED_BEFORE_EXECUTION" && prior.state.phase === "RESERVED" && !prior.everExecuted;
        if (!allowed) return repositoryExecutionFailure("REPOSITORY_EXECUTION_TRANSITION_INVALID");
        return { ok: true, record: null, value: true as const };
      });
      return result.ok ? { ok: true, released: result.value } : result;
    },
  });
}
