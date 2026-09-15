import { createHash } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionHandle } from "../repository/repository-execution-contracts.js";

/**
 * What the controller that owns a reservation positively proved about its processes, kept
 * durably (addendum 2026-09-15). The proofs themselves are unchanged: the spawner settles a seat
 * only after its process tree was confirmed closed, and a cancelled verifier settles only after
 * its tree kill was confirmed. Kept only in memory, each proof died with its controller: a stop
 * while a seat or a verifier ran left the reservation BLOCKED, and the recovery commands need
 * that same runtime alive to drain it, so an ordinary restart left a repository nothing could
 * release.
 *
 * A proof names the reservation's exact state, controller and revision included. A restarted
 * controller may rely on it only while the reservation is still exactly as the prover left it;
 * any later claim or transition moves the revision and the proof stops counting.
 */
export type RepositoryContainmentWitness = "SEAT" | "VERIFICATION";

export interface RepositoryContainmentLedger {
  /** Keeps the proof; false when it could not be kept, which only costs a restart its shortcut. */
  readonly record: (witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle) => boolean;
  /** Whether this exact proof was kept for this exact reservation state. */
  readonly proved: (witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle) => boolean;
}

type ContainmentStore = Pick<SqliteEventStore, "commit" | "getAggregateVersion" | "readEvents">;

const VERSION = "moe-repository-containment/1";
const EVENTS: Readonly<Record<RepositoryContainmentWitness, string>> = Object.freeze({
  SEAT: "RepositorySeatContained",
  VERIFICATION: "RepositoryVerificationContained",
});
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const aggregateOf = (handle: RepositoryExecutionHandle): string =>
  `repository-containment/${sha256(handle.owner.ownershipToken)}`;

/** Every field a claim or transition can move, so that a proof names one state only. */
function stateOf(handle: RepositoryExecutionHandle): string {
  const { owner, reservation } = handle;
  return JSON.stringify({
    version: VERSION, projectId: owner.projectId, nodeRef: owner.nodeRef, ownershipToken: owner.ownershipToken,
    storeId: owner.storeId, phase: reservation.phase, baselineId: reservation.baselineId,
    sessionId: reservation.sessionId, pid: reservation.pid, controllerId: reservation.controllerId,
    controllerPid: reservation.controllerPid, revision: reservation.revision,
  });
}

export function createRepositoryContainmentLedger(store: ContainmentStore): RepositoryContainmentLedger {
  return Object.freeze({
    record(witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle): boolean {
      try {
        const aggregateId = aggregateOf(handle);
        const version = store.getAggregateVersion(aggregateId);
        const commandId = `rcw-${sha256(aggregateId).slice(0, 32)}-${String(version)}`;
        store.commit({
          aggregateId,
          commandBytes: encoder.encode(JSON.stringify({ witness })),
          commandId,
          committedAt: new Date().toISOString(),
          events: [{ eventId: `${commandId}-e1`, eventType: EVENTS[witness], payload: encoder.encode(stateOf(handle)) }],
          expectedVersion: version,
        });
        return true;
      } catch { return false; }
    },
    proved(witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle): boolean {
      try {
        // Only the latest proof counts: an older one describes a state the reservation has left.
        const latest = [...store.readEvents(aggregateOf(handle))]
          .sort((left, right) => left.aggregateSequence - right.aggregateSequence).at(-1);
        return latest !== undefined && latest.eventType === EVENTS[witness]
          && decoder.decode(latest.payload) === stateOf(handle);
      } catch { return false; }
    },
  });
}
