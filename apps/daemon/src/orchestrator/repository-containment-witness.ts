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
 * any later claim, transition or process start moves past it and the proof stops counting.
 *
 * With no proof, the hold's recorded runtimes decide (owner decision 2026-09-16): every seat and
 * verifier run is recorded with the Windows Job broker of the runtime that ran it, before it
 * starts. A broker that is gone closed its Job, and closing a KILL_ON_JOB_CLOSE Job kills every
 * process in it. So when every runtime that ran a process for a hold is gone, nothing of it can
 * still be running. An unnamed runtime, an unreadable record, or a live broker never infers.
 *
 * A LIVE PID IS NOT A LIVE BROKER. Windows hands a dead process's pid to the next one that asks.
 * Measured on UnAI 2026-09-19: the recorded broker was pid 42564; after the owner's restart that
 * pid belonged to the NEW runtime's launcher, so "is 42564 alive" stayed true for the whole run,
 * the hold stayed BLOCKED, the integrator could not take the checkout and nothing merged. So a
 * live pid counts as the broker only while the OS still names the broker image at it. When the
 * OS cannot say, the broker is taken to be alive: the wrong answer there costs a wait, never a
 * release over a running process.
 */
export type RepositoryContainmentWitness = "SEAT" | "VERIFICATION";

export interface RepositoryContainmentLedger {
  /** Keeps the proof; false when it could not be kept, which only costs a restart its shortcut. */
  readonly record: (witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle) => boolean;
  /** Whether this exact proof was kept for this exact reservation state. */
  readonly proved: (witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle) => boolean;
  /** Records which runtime is about to run a process for this hold; false when it could not be kept. */
  readonly recordRuntime: (kind: RepositoryContainmentWitness, handle: RepositoryExecutionHandle) => boolean;
  /** Whether every runtime that ran a process for this hold, the current seat's included, is gone. */
  readonly runtimesGone: (handle: RepositoryExecutionHandle, isAlive: (pid: number) => boolean) => boolean;
}

type ContainmentStore = Pick<SqliteEventStore, "commit" | "getAggregateVersion" | "readEvents">;
interface RuntimeRecord { readonly kind: RepositoryContainmentWitness; readonly brokerPid: number | null; readonly sessionId: string | null }

const VERSION = "moe-repository-containment/1";
const EVENTS: Readonly<Record<RepositoryContainmentWitness, string>> = Object.freeze({
  SEAT: "RepositorySeatContained",
  VERIFICATION: "RepositoryVerificationContained",
});
const RUNTIME_EVENT = "RepositoryRuntimeUsed";
const RUNTIME_KEYS = ["brokerPid", "controllerId", "kind", "ownershipToken", "sessionId", "version"];
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

function runtimeOf(payload: Uint8Array, ownershipToken: string): RuntimeRecord | null {
  const value: unknown = JSON.parse(decoder.decode(payload));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const broker = record["brokerPid"]; const session = record["sessionId"];
  if (Object.keys(record).sort().join(",") !== RUNTIME_KEYS.join(",") || record["version"] !== VERSION
    || record["ownershipToken"] !== ownershipToken || (record["kind"] !== "SEAT" && record["kind"] !== "VERIFICATION")
    || (broker !== null && (typeof broker !== "number" || !Number.isSafeInteger(broker) || broker <= 0))
    || (session !== null && typeof session !== "string")) return null;
  return { kind: record["kind"], brokerPid: broker, sessionId: session };
}

/** Whether the process at this pid still runs the broker image; null when the OS could not say. */
export type BrokerImageProbe = (pid: number) => boolean | null;

export function createRepositoryContainmentLedger(store: ContainmentStore, runtimeBrokerPid: number | null = null,
  brokerImageAt: BrokerImageProbe = () => null): RepositoryContainmentLedger {
  const latestOf = (handle: RepositoryExecutionHandle) => [...store.readEvents(aggregateOf(handle))]
    .sort((left, right) => left.aggregateSequence - right.aggregateSequence).at(-1);
  const append = (handle: RepositoryExecutionHandle, eventType: string, payload: string): void => {
    const aggregateId = aggregateOf(handle);
    const version = store.getAggregateVersion(aggregateId);
    const commandId = `rcw-${sha256(aggregateId).slice(0, 32)}-${String(version)}`;
    store.commit({
      aggregateId,
      commandBytes: encoder.encode(JSON.stringify({ eventType })),
      commandId,
      committedAt: new Date().toISOString(),
      events: [{ eventId: `${commandId}-e1`, eventType, payload: encoder.encode(payload) }],
      expectedVersion: version,
    });
  };
  return Object.freeze({
    record(witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle): boolean {
      try { append(handle, EVENTS[witness], stateOf(handle)); return true; } catch { return false; }
    },
    proved(witness: RepositoryContainmentWitness, handle: RepositoryExecutionHandle): boolean {
      try {
        // Only the latest event counts: a later run or proof describes processes the proof never saw.
        const latest = latestOf(handle);
        return latest !== undefined && latest.eventType === EVENTS[witness]
          && decoder.decode(latest.payload) === stateOf(handle);
      } catch { return false; }
    },
    recordRuntime(kind: RepositoryContainmentWitness, handle: RepositoryExecutionHandle): boolean {
      try {
        const payload = JSON.stringify({ brokerPid: runtimeBrokerPid, controllerId: handle.reservation.controllerId, kind,
          ownershipToken: handle.owner.ownershipToken, sessionId: handle.reservation.sessionId, version: VERSION });
        const latest = latestOf(handle);
        // A verification retried every pass is one run of one runtime, recorded once.
        if (latest?.eventType === RUNTIME_EVENT && decoder.decode(latest.payload) === payload) return true;
        append(handle, RUNTIME_EVENT, payload);
        return true;
      } catch { return false; }
    },
    runtimesGone(handle: RepositoryExecutionHandle, isAlive: (pid: number) => boolean): boolean {
      try {
        const runs: RuntimeRecord[] = [];
        for (const event of store.readEvents(aggregateOf(handle))) {
          if (event.eventType !== RUNTIME_EVENT) continue;
          const run = runtimeOf(event.payload, handle.owner.ownershipToken);
          if (run === null) return false;
          runs.push(run);
        }
        // The hold's current seat must be on record: an unrecorded run leaves nothing to infer from.
        if (!runs.some((run) => run.kind === "SEAT" && run.sessionId === handle.reservation.sessionId)) return false;
        return runs.every((run) => {
          if (run.brokerPid === null) return false;
          try { return !isAlive(run.brokerPid) || brokerImageAt(run.brokerPid) === false; } catch { return false; }
        });
      } catch { return false; }
    },
  });
}
