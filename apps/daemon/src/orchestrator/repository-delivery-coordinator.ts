import { randomBytes } from "node:crypto";
import type { RepositoryExecutionHandle, RepositoryExecutionState } from "../repository/repository-execution-contracts.js";
import { AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { AgentSpawnStart, AgentSpawnStartResult } from "./agent-spawn-contract.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { deliveryRefusal } from "./repository-delivery-contracts.js";
import type { RepositoryDeliveryConfig } from "./repository-delivery-contracts.js";

const PREFIX = "node.deliver@";

/** A checkout owner survives child exit, retries, verification, and wrapper death. */
export function createRepositoryDeliveryCoordinator(config: RepositoryDeliveryConfig) {
  const knownWorkspaces = new Set<string>();
  const busy = new Set<string>();
  const exits = new Map<string, "RUNNING" | "CONTAINED" | "UNKNOWN">();
  let advancing = false;

  const change = (handle: RepositoryExecutionHandle, patch: Partial<RepositoryExecutionState>) =>
    config.port.transition(handle.reservation.identity.root, handle.owner, handle.reservation.revision,
      { ...handle.reservation, ...config.controller, ...patch });

  const block = (handle: RepositoryExecutionHandle): void => { change(handle, { phase: "BLOCKED" }); };
  const blockCurrent = (handle: RepositoryExecutionHandle): void => {
    const current = config.port.readOwned(handle.reservation.identity.root, config.storeId, config.projectId);
    if (current.ok && current.handle?.reservation.controllerId === config.controller.controllerId
      && current.handle.owner.ownershipToken === handle.owner.ownershipToken) block(current.handle);
  };
  const release = (handle: RepositoryExecutionHandle, reason: "LANDED" | "ABORTED_BEFORE_EXECUTION") =>
    config.port.release(handle.reservation.identity.root, handle.owner, handle.reservation.revision,
      reason, config.controller.controllerId);

  const owned = (workspace: string) => {
    const read = config.port.readOwned(workspace, config.storeId, config.projectId);
    if (!read.ok || read.handle === null) return read;
    const handle = read.handle;
    if (handle.reservation.controllerId === config.controller.controllerId) return read;
    try {
      if (config.isProcessAlive(handle.reservation.controllerPid)) return deliveryRefusal("REPOSITORY_EXECUTION_BUSY");
    } catch { return deliveryRefusal("REPOSITORY_EXECUTION_UNKNOWN"); }
    const claimed = config.port.claimController(workspace, handle.owner, handle.reservation.revision, config.controller);
    if (!claimed.ok) return claimed;
    // An orphan verifier or interrupted Git effect has no proved close witness.
    // Only a recorded committed landing can reconcile a crash in that phase.
    if (claimed.handle.reservation.phase === "LANDING" && config.facts(handle.owner.nodeRef) === "LANDED") {
      const done = release(claimed.handle, "LANDED");
      return done.ok ? { ok: true as const, handle: null } : done;
    }
    if (["VERIFYING", "LANDING"].includes(claimed.handle.reservation.phase)) {
      const blocked = change(claimed.handle, { phase: "BLOCKED" });
      return blocked;
    }
    return claimed;
  };

  const start = async (request: SpawnRequest, spawn: AgentSpawnStart): Promise<AgentSpawnStartResult> => {
    if (request.kind !== "node.deliver") return spawn(request);
    if (request.workspace === null || !request.workItemId.startsWith(PREFIX)) return deliveryRefusal("REPOSITORY_DELIVERY_WORKSPACE_REQUIRED");
    const workspace = request.workspace;
    const nodeRef = request.workItemId.slice(PREFIX.length);
    knownWorkspaces.add(workspace);
    const read = owned(workspace);
    if (!read.ok) return deliveryRefusal(read.code);
    let handle = read.handle;
    if (handle === null) {
      const acquired = config.port.acquire(workspace, { projectId: config.projectId, nodeRef,
        ownershipToken: randomBytes(32).toString("hex"), storeId: config.storeId }, config.controller);
      if (!acquired.ok) return deliveryRefusal(acquired.code);
      handle = acquired.handle;
    }
    const root = handle.reservation.identity.root;
    if (handle.owner.nodeRef !== nodeRef || handle.reservation.phase !== "RESERVED" || busy.has(root)) {
      return deliveryRefusal("REPOSITORY_EXECUTION_BUSY");
    }
    busy.add(root);
    try {
      if (handle.reservation.baselineId === null) {
        const baselineId = await config.baseline(nodeRef, root);
        if (baselineId === null) {
          release(handle, "ABORTED_BEFORE_EXECUTION");
          return deliveryRefusal("REPOSITORY_DELIVERY_BASELINE_UNAVAILABLE");
        }
        const bound = change(handle, { baselineId });
        if (!bound.ok) return deliveryRefusal(bound.code);
        handle = bound.handle;
      }
      const executing = change(handle, { phase: "EXECUTING", sessionId: request.sessionId, pid: null });
      if (!executing.ok) return deliveryRefusal(executing.code);
      handle = executing.handle;
      exits.delete(handle.owner.ownershipToken);
      const started = await spawn(request);
      if (!started.ok) {
        change(handle, { phase: "RESERVED", sessionId: null, pid: null });
        return started;
      }
      const bound = change(handle, { pid: started.pid ?? null });
      const bindingError = bound.ok ? null : new Error(bound.code);
      if (bound.ok) handle = bound.handle;
      else blockCurrent(handle);
      const lifetimeHandle = handle;
      const token = lifetimeHandle.owner.ownershipToken;
      exits.set(token, "RUNNING");
      // A persistence failure must not retire staffing while its child is live.
      const exit = started.exit.then((report) => {
        exits.set(token, bindingError === null ? "CONTAINED" : "UNKNOWN");
        if (bindingError !== null) { blockCurrent(lifetimeHandle); throw bindingError; }
        return report;
      }, (error: unknown) => {
        const containment = bindingError === null && error instanceof AgentProcessFailureError ? "CONTAINED" : "UNKNOWN";
        exits.set(token, containment);
        if (containment === "UNKNOWN") blockCurrent(lifetimeHandle);
        throw bindingError ?? error;
      });
      return { ...started, exit };
    } catch (error) { blockCurrent(handle); throw error; }
    finally { busy.delete(root); }
  };

  const advanceOne = async (initial: RepositoryExecutionHandle): Promise<void> => {
    let handle = initial;
    const nodeRef = handle.owner.nodeRef;
    if (["BLOCKED", "RESERVED"].includes(handle.reservation.phase)) return;
    if (handle.reservation.phase === "EXECUTING") {
      const closed = exits.get(handle.owner.ownershipToken);
      if (closed === "RUNNING") return;
      if (closed === "UNKNOWN") { block(handle); return; }
      if (closed !== "CONTAINED") {
        if (handle.reservation.pid !== null) {
          try { if (config.isProcessAlive(handle.reservation.pid)) return; } catch { return; }
        }
        // A dead direct PID or retired credential does not prove descendants
        // closed. A restarted controller has no local containment witness.
        block(handle); return;
      }
      if (!config.retired(nodeRef)) return;
      const facts = config.facts(nodeRef);
      if (facts === "UNKNOWN" || facts === "REFUSED" || facts === "LANDED") { block(handle); return; }
      const next = change(handle, facts === "READY"
        ? { phase: "RESERVED", sessionId: null, pid: null } : { phase: "VERIFYING" });
      if (!next.ok || facts === "READY") return;
      handle = next.handle;
    }
    if (handle.reservation.phase === "VERIFYING") {
      if (config.facts(nodeRef) === "SUBMITTED") await config.verify(nodeRef, handle.reservation.identity.root);
      const facts = config.facts(nodeRef);
      if (facts === "SUBMITTED") return; // missing standing authority can be installed later
      if (facts !== "ACCEPTED" && facts !== "READY") { block(handle); return; }
      const next = change(handle, facts === "READY"
        ? { phase: "RESERVED", sessionId: null, pid: null } : { phase: "AWAITING_LANDING" });
      if (!next.ok || facts === "READY") return;
      handle = next.handle;
    }
    if (handle.reservation.phase === "AWAITING_LANDING") {
      if (handle.reservation.baselineId === null || config.facts(nodeRef) !== "ACCEPTED") { block(handle); return; }
      const next = change(handle, { phase: "LANDING" });
      if (!next.ok) return;
      handle = next.handle;
      const result = await config.land(nodeRef, handle.reservation.baselineId!, handle.reservation.identity.root);
      const facts = config.facts(nodeRef);
      if (facts === "LANDED") { release(handle, "LANDED"); return; }
      else if (result === "RETRY" && facts === "ACCEPTED") change(handle, { phase: "AWAITING_LANDING" });
      else block(handle);
      return;
    }
    if (handle.reservation.phase === "LANDING") {
      // Retry only reservation cleanup after the durable receipt proves Git
      // completed. An unknown effect must never be repeated.
      if (config.facts(nodeRef) === "LANDED") release(handle, "LANDED");
      else block(handle);
    }
  };

  const advance = async (): Promise<void> => {
    if (advancing) return;
    advancing = true;
    try {
      const visited = new Set<string>();
      for (const workspace of [...knownWorkspaces, ...config.workspaces()]) {
        const read = owned(workspace);
        if (!read.ok || read.handle === null) continue;
        const handle = read.handle;
        const root = handle.reservation.identity.root;
        if (visited.has(root) || busy.has(root)) continue;
        visited.add(root); busy.add(root);
        try { await advanceOne(handle); }
        catch (error) {
          blockCurrent(handle);
          throw error;
        } finally { busy.delete(root); }
      }
    } finally { advancing = false; }
  };
  return Object.freeze({ start, advance });
}
