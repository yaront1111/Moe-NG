import { BrokerSession, type WindowsProcessBoundary } from "./windows-boundary-session.js";
import { type BrokerSpawn } from "./windows-broker-process.js";
import { unknownOutcome, type WindowsProcessUnknown } from "./windows-process-contract.js";

/** Spawns synchronously so a create failure is returned before a session exists. */
export function driveBrokerBoundary(
  binary: string,
  launch: Uint8Array,
  spawn: BrokerSpawn,
  timeoutMs: number,
  cancelGraceMs: number,
): WindowsProcessBoundary | WindowsProcessUnknown {
  try {
    return new BrokerSession(spawn(binary), launch, timeoutMs, cancelGraceMs);
  } catch (error) {
    return unknownOutcome(
      "PROCESS_BOUNDARY_BROKER_SPAWN_FAILED",
      "WINDOWS_PROCESS_RESOLUTION",
      `the broker could not be spawned: ${String(error)}`,
    );
  }
}
