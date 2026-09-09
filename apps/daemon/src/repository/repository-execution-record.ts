import { REPOSITORY_EXECUTION_PHASES } from "./repository-execution-contracts.js";
import type { RepositoryExecutionController, RepositoryExecutionHandle, RepositoryExecutionIdentity, RepositoryExecutionOwner, RepositoryExecutionState } from "./repository-execution-contracts.js";

export interface RepositoryExecutionRecord {
  readonly owner: RepositoryExecutionOwner;
  readonly state: RepositoryExecutionState;
  readonly revision: number;
  readonly everExecuted: boolean;
}
const ref = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function validExecutionOwner(value: unknown): value is RepositoryExecutionOwner {
  return object(value) && exact(value, ["projectId", "nodeRef", "ownershipToken", "storeId"])
    && ref(value["projectId"]) && ref(value["nodeRef"]) && ref(value["storeId"])
    && typeof value["ownershipToken"] === "string" && /^[a-f0-9]{64}$/u.test(value["ownershipToken"]);
}
export function validExecutionController(value: unknown): value is RepositoryExecutionController {
  return object(value) && ref(value["controllerId"]) && typeof value["controllerPid"] === "number"
    && Number.isSafeInteger(value["controllerPid"]) && value["controllerPid"] > 0;
}
export function validExecutionState(value: unknown): value is RepositoryExecutionState {
  if (!object(value) || !validExecutionController(value) || !REPOSITORY_EXECUTION_PHASES.some((phase) => phase === value["phase"])) return false;
  const baseline = value["baselineId"]; const session = value["sessionId"]; const pid = value["pid"];
  if ((baseline !== null && !ref(baseline)) || (session !== null && !ref(session))
    || (pid !== null && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0))) return false;
  if (value["phase"] === "RESERVED") return session === null && pid === null;
  if (value["phase"] === "PUBLISHING") return baseline === null && session === null && pid === null;
  if (value["phase"] === "BLOCKED") return true;
  return baseline !== null && session !== null;
}
export function decodeExecutionRecord(row: Record<string, unknown>): RepositoryExecutionRecord | null {
  try {
    if (typeof row["owner_json"] !== "string" || typeof row["state_json"] !== "string") return null;
    const owner: unknown = JSON.parse(row["owner_json"]); const state: unknown = JSON.parse(row["state_json"]);
    const revision = row["revision"]; const ran = row["ever_executed"];
    if (!validExecutionOwner(owner) || !validExecutionState(state) || !object(state)
      || !exact(state, ["phase", "baselineId", "sessionId", "pid", "controllerId", "controllerPid"])
      || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1
      || (ran !== 0 && ran !== 1) || (state.phase !== "RESERVED" && state.phase !== "BLOCKED" && ran !== 1)) return null;
    return { owner, state, revision, everExecuted: ran === 1 };
  } catch { return null; }
}
export function executionHandle(record: RepositoryExecutionRecord, identity: RepositoryExecutionIdentity): RepositoryExecutionHandle {
  return Object.freeze({
    owner: Object.freeze({ ...record.owner }),
    reservation: Object.freeze({ ...record.state, revision: record.revision, projectId: record.owner.projectId,
      nodeRef: record.owner.nodeRef, storeId: record.owner.storeId, identity }),
  });
}
export function sameExecutionOwner(left: RepositoryExecutionOwner, right: RepositoryExecutionOwner): boolean {
  return left.projectId === right.projectId && left.nodeRef === right.nodeRef
    && left.ownershipToken === right.ownershipToken && left.storeId === right.storeId;
}
