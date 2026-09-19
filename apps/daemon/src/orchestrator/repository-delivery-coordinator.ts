import { randomBytes } from "node:crypto";
import { isRepositoryWorkflowRef } from "../repository/repository-workflow-ref.js";
import type { RepositoryExecutionHandle, RepositoryExecutionState } from "../repository/repository-execution-contracts.js";
import { AgentProcessFailureError } from "./agent-spawn-contract.js";
import type { AgentSpawnStart, AgentSpawnStartResult } from "./agent-spawn-contract.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { VerifierProcessCancelledError } from "./process-runner-lifecycle.js";
import type { RepositoryContainmentWitness } from "./repository-containment-witness.js";
import { deliveryRefusal } from "./repository-delivery-contracts.js";
import type { RepositoryDeliveryConfig, RepositoryDeliveryFacts, RepositoryDeliveryRefusal } from "./repository-delivery-contracts.js";

const PREFIX = "node.deliver@";
/** A contained holder under these facts keeps nothing live: it is between review attempts, or replanned for good. */
const idleFacts = (facts: RepositoryDeliveryFacts): boolean => facts === "READY" || facts === "REPLANNED";

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
  const release = (handle: RepositoryExecutionHandle, reason: "LANDED" | "LANDED_NOTHING" | "ABORTED_BEFORE_EXECUTION" | "YIELDED") =>
    config.port.release(handle.reservation.identity.root, handle.owner, handle.reservation.revision,
      reason, config.controller.controllerId);
  // A waiter is told WHO holds the repository and why (addendum 2026-09-15), never just BUSY.
  const busyBy = (handle: RepositoryExecutionHandle): RepositoryDeliveryRefusal => deliveryRefusal(
    "REPOSITORY_EXECUTION_BUSY", config.describeHolder?.(handle.owner.nodeRef, handle.reservation.phase));
  // A FREE repository is left free for an approved publish that has not held it yet; see
  // `RepositoryDeliveryConfig.publishWaiting`. Read only when nothing holds the repository.
  const yieldToPublish = (): RepositoryDeliveryRefusal | null => {
    const goalId = config.publishWaiting?.() ?? null;
    return goalId === null ? null
      : deliveryRefusal("REPOSITORY_EXECUTION_BUSY", `an approved publish of ${goalId} is waiting for the repository`);
  };
  /**
   * Keeps what this controller just proved closed, for exactly the state it proved it in
   * (addendum 2026-09-15). A restarted controller relies on it only while that state is untouched.
   */
  const recordProof = (witness: RepositoryContainmentWitness, proved: RepositoryExecutionHandle): void => {
    if (config.containment === undefined) return;
    try {
      const current = config.port.readOwned(proved.reservation.identity.root, config.storeId, config.projectId);
      if (!current.ok || current.handle === null) return;
      const { owner, reservation } = current.handle;
      if (owner.ownershipToken !== proved.owner.ownershipToken || reservation.controllerId !== config.controller.controllerId
        || reservation.phase !== (witness === "SEAT" ? "EXECUTING" : "VERIFYING")
        || reservation.sessionId !== proved.reservation.sessionId || reservation.pid !== proved.reservation.pid) return;
      config.containment.record(witness, current.handle);
    } catch { /* an unkept proof only costs a restart its shortcut */ }
  };

  const owned = (workspace: string) => {
    const read = config.port.readOwned(workspace, config.storeId, config.projectId);
    if (!read.ok || read.handle === null) return read;
    const handle = read.handle;
    // Each effect family reconciles its own durable process and result evidence.
    // A node controller cannot adopt a stopped publisher or criterion runner.
    if (isRepositoryWorkflowRef(handle.owner.nodeRef)) {
      return deliveryRefusal("REPOSITORY_EXECUTION_BUSY");
    }
    if (handle.reservation.controllerId === config.controller.controllerId) return read;
    try {
      if (config.isProcessAlive(handle.reservation.controllerPid)) return deliveryRefusal("REPOSITORY_EXECUTION_BUSY");
    } catch { return deliveryRefusal("REPOSITORY_EXECUTION_UNKNOWN"); }
    // The dead controller's kept proof stands in for the memory it lost, but only for the exact
    // state it proved; read before the claim, because the claim moves the revision.
    // With no kept proof, every runtime that ran a process for it being gone proves it too
    // (owner decision 2026-09-16): a gone broker closed its Job, which killed every process in it.
    const gone = (): boolean => config.containment?.runtimesGone(handle, config.isProcessAlive) === true;
    const provedSeat = handle.reservation.phase === "EXECUTING"
      && (config.containment?.proved("SEAT", handle) === true || gone());
    const provedVerification = handle.reservation.phase === "VERIFYING"
      && (config.containment?.proved("VERIFICATION", handle) === true || gone());
    const claimed = config.port.claimController(workspace, handle.owner, handle.reservation.revision, config.controller);
    if (!claimed.ok) return claimed;
    if (provedSeat) exits.set(handle.owner.ownershipToken, "CONTAINED");
    // An orphan verifier or interrupted Git effect has no proved close witness. Only a durable
    // landing outcome reconciles a crash in that phase: a recorded committed landing, or a refusal
    // that journaled no intent and therefore wrote nothing at all.
    const landing = claimed.handle.reservation.phase === "LANDING"
      ? config.facts(handle.owner.nodeRef, claimed.handle) : null;
    if (landing === "LANDED" || landing === "REFUSED_NO_EFFECT") {
      const done = release(claimed.handle, landing === "LANDED" ? "LANDED" : "LANDED_NOTHING");
      return done.ok ? { ok: true as const, handle: null } : done;
    }
    // A verification its own controller proved cancelled is simply run again.
    if (claimed.handle.reservation.phase === "LANDING"
      || (claimed.handle.reservation.phase === "VERIFYING" && !provedVerification)) {
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
    if (!read.ok) return "layer" in read ? read : deliveryRefusal(read.code);
    let handle = read.handle;
    if (handle === null) {
      const yielded = yieldToPublish();
      if (yielded !== null) return yielded;
      const acquired = config.port.acquire(workspace, { projectId: config.projectId, nodeRef,
        ownershipToken: randomBytes(32).toString("hex"), storeId: config.storeId }, config.controller);
      if (!acquired.ok) return deliveryRefusal(acquired.code);
      handle = acquired.handle;
    }
    const root = handle.reservation.identity.root;
    if (handle.owner.nodeRef !== nodeRef) return busyBy(handle);
    if (handle.reservation.phase !== "RESERVED" || busy.has(root)) {
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
      // The runtime's own closed guard was read before the awaited baseline; a stop that landed
      // inside it must not move the row to EXECUTING against a spawner that will refuse.
      if (config.closed?.() === true) return deliveryRefusal("REPOSITORY_DELIVERY_CLOSED");
      const executing = change(handle, { phase: "EXECUTING", sessionId: request.sessionId, pid: null });
      if (!executing.ok) return deliveryRefusal(executing.code);
      handle = executing.handle;
      // Which runtime runs this seat, kept before it can start (owner decision 2026-09-16). A seat
      // with no record only means no later controller may infer its closure from its runtime.
      config.containment?.recordRuntime("SEAT", handle);
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
        recordProof("SEAT", lifetimeHandle);
        return report;
      }, (error: unknown) => {
        const containment = bindingError === null && error instanceof AgentProcessFailureError ? "CONTAINED" : "UNKNOWN";
        exits.set(token, containment);
        if (containment === "UNKNOWN") blockCurrent(lifetimeHandle);
        else recordProof("SEAT", lifetimeHandle);
        throw bindingError ?? error;
      });
      return { ...started, exit };
    } catch (error) { blockCurrent(handle); throw error; }
    finally { busy.delete(root); }
  };

  /**
   * An idle holder gives the repository back (addendum 2026-09-15): its claim and staffing are
   * retired, so no seat is live; its review is between attempts; and the tree holds nothing
   * uncommitted, so no work can be lost. On UnAI an escalated node held the only checkout with a
   * clean tree while the one sibling that could clear its finding waited 283 times. The node
   * re-acquires with a fresh baseline when it is staffed again.
   *
   * A replanned holder gives it back on the same proof. On UnAI a human REPLAN left the node
   * RESERVED with no seat and a clean tree; the replan recovery accepts only BLOCKED and this
   * yield accepted only READY, so nothing could ever release the only checkout.
   */
  const yieldIdle = async (handle: RepositoryExecutionHandle): Promise<void> => {
    const nodeRef = handle.owner.nodeRef;
    if (config.clean === undefined || !config.retired(nodeRef) || !idleFacts(config.facts(nodeRef, handle))) return;
    if (!(await config.clean(handle.reservation.identity.root))) return;
    release(handle, "YIELDED");
  };

  /**
   * A BLOCKED hold resumes on its own once every runtime that ran a process for it is gone
   * (owner decision 2026-09-16): a gone broker closed its Job, which killed every process in it.
   * Only review states come back; a landing whose Git effect is unknown stays for a human.
   * Returns the hold when it came back RESERVED, so the same pass can give an idle one back.
   */
  const resumeGone = (handle: RepositoryExecutionHandle): RepositoryExecutionHandle | null => {
    if (config.containment?.runtimesGone(handle, config.isProcessAlive) !== true) return null;
    const facts = config.facts(handle.owner.nodeRef, handle);
    if (idleFacts(facts)) {
      const next = change(handle, { phase: "RESERVED", sessionId: null, pid: null });
      return next.ok ? next.handle : null;
    }
    if (facts === "SUBMITTED") change(handle, { phase: "VERIFYING" });
    return null;
  };

  const advanceOne = async (initial: RepositoryExecutionHandle): Promise<void> => {
    let handle = initial;
    const nodeRef = handle.owner.nodeRef;
    if (handle.reservation.phase === "BLOCKED") {
      // In the SAME pass, not the next one. UnAI 2026-09-19: a restart brought a dead seat's hold
      // back RESERVED over a clean checkout; staffing ran before the next pass could yield it, so
      // the holder was staffed right there, on a project branch that lacked its dependencies, and
      // the integrator (which needs that checkout) could merge none of three landed branches.
      const resumed = resumeGone(handle);
      if (resumed !== null) await yieldIdle(resumed);
      return;
    }
    if (handle.reservation.phase === "RESERVED") { await yieldIdle(handle); return; }
    if (handle.reservation.phase === "EXECUTING") {
      const closed = exits.get(handle.owner.ownershipToken);
      if (closed === "RUNNING") return;
      if (closed === "UNKNOWN") { block(handle); return; }
      if (closed !== "CONTAINED") {
        if (handle.reservation.pid !== null) {
          try { if (config.isProcessAlive(handle.reservation.pid)) return; } catch { return; }
        }
        // A dead direct PID or retired credential does not prove descendants closed, and a
        // restarted controller has no local witness; a gone runtime does (owner decision 2026-09-16).
        if (config.containment?.runtimesGone(handle, config.isProcessAlive) !== true) { block(handle); return; }
        exits.set(handle.owner.ownershipToken, "CONTAINED");
      }
      if (!config.retired(nodeRef)) return;
      const facts = config.facts(nodeRef, handle);
      // A landing outcome cannot be reached from EXECUTING; every one of them still contains here.
      if (facts === "UNKNOWN" || facts === "REFUSED" || facts === "REFUSED_NO_EFFECT" || facts === "LANDED") { block(handle); return; }
      // A replanned node's contained seat is done for good: back to RESERVED, where it may yield.
      const next = change(handle, idleFacts(facts)
        ? { phase: "RESERVED", sessionId: null, pid: null } : { phase: "VERIFYING" });
      if (!next.ok) return;
      // The SAME pass gives an idle, clean checkout back (UnAI 2026-09-19, twice): staffing runs
      // right after this advance, and a RESERVED holder is staffed where it holds, so the next
      // pass's yield came too late every time and the integrator never got the checkout.
      if (idleFacts(facts)) { await yieldIdle(next.handle); return; }
      handle = next.handle;
    }
    if (handle.reservation.phase === "VERIFYING") {
      if (config.facts(nodeRef, handle) === "SUBMITTED") {
        // A verifier from an unrecorded runtime would let a later controller infer too much.
        if (config.containment !== undefined && !config.containment.recordRuntime("VERIFICATION", handle)) return;
        try { await config.verify(nodeRef, handle.reservation.identity.root); }
        catch (error) {
          // A cancelled verifier settled only after its tree kill was confirmed: keep the proof, stay VERIFYING.
          if (error instanceof VerifierProcessCancelledError) recordProof("VERIFICATION", handle);
          throw error;
        }
      }
      const facts = config.facts(nodeRef, handle);
      if (facts === "SUBMITTED") return; // missing standing authority can be installed later
      if (facts !== "ACCEPTED" && !idleFacts(facts)) { block(handle); return; }
      const next = change(handle, idleFacts(facts)
        ? { phase: "RESERVED", sessionId: null, pid: null } : { phase: "AWAITING_LANDING" });
      if (!next.ok) return;
      if (idleFacts(facts)) { await yieldIdle(next.handle); return; }
      handle = next.handle;
    }
    if (handle.reservation.phase === "AWAITING_LANDING") {
      if (handle.reservation.baselineId === null || config.facts(nodeRef, handle) !== "ACCEPTED") { block(handle); return; }
      const next = change(handle, { phase: "LANDING" });
      if (!next.ok) return;
      handle = next.handle;
      const result = await config.land(nodeRef, handle.reservation.baselineId!, handle.reservation.identity.root, handle);
      const facts = config.facts(nodeRef, handle);
      if (facts === "LANDED") { release(handle, "LANDED"); return; }
      // Refused before any intent: HEAD was never touched, so the checkout is owed nothing and
      // goes back. Every other refusal still blocks — a post-intent one may have left an effect.
      else if (facts === "REFUSED_NO_EFFECT") { release(handle, "LANDED_NOTHING"); return; }
      else if (result === "RETRY" && facts === "ACCEPTED") change(handle, { phase: "AWAITING_LANDING" });
      else block(handle);
      return;
    }
    if (handle.reservation.phase === "LANDING") {
      // Reached when the controller died between the landing outcome and its release. Retry only
      // reservation cleanup after a durable receipt proves what Git did — either that it completed,
      // or that the refusal journaled no intent and so began nothing. An unknown effect is never repeated.
      const facts = config.facts(nodeRef, handle);
      if (facts === "LANDED") release(handle, "LANDED");
      else if (facts === "REFUSED_NO_EFFECT") release(handle, "LANDED_NOTHING");
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
          // A cancelled verification is contained and proved; any other throw leaves containment unknown.
          if (!(error instanceof VerifierProcessCancelledError)) blockCurrent(handle);
          throw error;
        } finally { busy.delete(root); }
      }
    } finally { advancing = false; }
  };
  /**
   * Read-only admission, asked before the wrapper opens a session or claims a node: a busy
   * repository used to cost a session, a claim and a staffing record per retry.
   */
  const admission = (workspace: string, nodeRef: string): RepositoryDeliveryRefusal | null => {
    const read = config.port.readOwned(workspace, config.storeId, config.projectId);
    if (!read.ok) return deliveryRefusal(read.code);
    if (read.handle === null) return yieldToPublish();
    return read.handle.owner.nodeRef === nodeRef ? null : busyBy(read.handle);
  };
  return Object.freeze({ start, advance, admission });
}
