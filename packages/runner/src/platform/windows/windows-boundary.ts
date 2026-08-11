import {
  type WindowsProcessBoundary,
} from "./windows-boundary-session.js";
import { driveBrokerBoundary } from "./windows-boundary-driver.js";
import { spawnBroker, type BrokerSpawn } from "./windows-broker-process.js";
import { resolveBrokerBinary } from "./windows-broker-path.js";
import { encodeFrame } from "./windows-frames.js";
import { encodeLaunchPayload } from "./windows-launch-request.js";
import {
  unknownOutcome,
  type WindowsProcessUnknown,
} from "./windows-process-contract.js";

export type { WindowsProcessBoundary } from "./windows-boundary-session.js";

/**
 * The Windows process boundary: spawn the broker, drive the frozen protocol,
 * and translate what comes back into PROVEN or UNKNOWN.
 *
 * IT COMPOSES THE BROKER; IT DOES NOT REIMPLEMENT IT. Every Job Object
 * operation — create suspended, configure kill-on-close without breakaway,
 * assign, prove membership, resume, terminate, close — happens in
 * native/broker and is proven there on a real kernel. Nothing in this file
 * touches Win32, and a `taskkill` or PID-enumeration fallback is deliberately
 * absent: neither can prove a descendant dead.
 *
 * THE GATE ORDER IS THE CONTRACT. Platform, then request, then framing, then
 * resolution, then spawn. Each gate's tests assert what the gates AFTER it did
 * not do, which is the only way to prove "no process was created".
 */

/** `Inbound::Launch` from native/broker/src/control.rs. */
const LAUNCH_OPCODE = 1;

/** How long a launch may run before the boundary cancels it. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

/** How long a cancelled broker gets to exit before it is killed outright. */
// Native settlement itself contains a 5-second retained-handle wait. Killing
// the broker at the same deadline races the proof it is in the middle of
// producing, so the outer crash-safety backstop must leave that bound room.
export const CANCEL_GRACE_MS = 15_000;

export interface WindowsBoundaryDeps {
  readonly platform: string;
  readonly resolveBroker: () => string | WindowsProcessUnknown;
  readonly spawn: BrokerSpawn;
}

export interface WindowsBoundaryOptions {
  readonly timeoutMs?: number;
  readonly deps?: WindowsBoundaryDeps;
}

const defaults: WindowsBoundaryDeps = {
  platform: process.platform,
  resolveBroker: () => resolveBrokerBinary(),
  spawn: spawnBroker,
};

/**
 * Opens a boundary, or refuses.
 *
 * SYNCHRONOUS ON THE REFUSAL PATH ON PURPOSE. Returning the union rather than a
 * promise makes "nothing was created" structurally visible: there is no
 * boundary object to close because no process was ever spawned.
 */
export function openWindowsProcessBoundary(
  request: unknown,
  options: WindowsBoundaryOptions = {},
): WindowsProcessBoundary | WindowsProcessUnknown {
  const deps = options.deps ?? defaults;
  // FIRST, AND BEFORE ANY IMPORT-TIME COST IS INCURRED. A non-Windows caller
  // reaches neither resolution nor the process seam.
  if (deps.platform !== "win32") {
    return unknownOutcome(
      "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED",
      "WINDOWS_PROCESS_REQUEST",
      "the Windows process boundary is only supported on win32",
    );
  }
  const payload = encodeLaunchPayload(request);
  if (!(payload instanceof Uint8Array)) {
    return payload;
  }
  const launch = encodeFrame("CONTROL", LAUNCH_OPCODE, payload);
  if (!(launch instanceof Uint8Array)) {
    return launch;
  }
  const binary = deps.resolveBroker();
  if (typeof binary !== "string") {
    return binary;
  }
  return driveBrokerBoundary(
    binary,
    launch,
    deps.spawn,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    CANCEL_GRACE_MS,
  );
}
