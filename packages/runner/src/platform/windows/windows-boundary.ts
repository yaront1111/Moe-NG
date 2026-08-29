import {
  type WindowsProcessBoundary,
} from "./windows-boundary-session.js";
import { driveBrokerBoundary } from "./windows-boundary-driver.js";
import { spawnBroker, type BrokerSpawn } from "./windows-broker-process.js";
import { resolveBrokerBinary } from "./windows-broker-path.js";
import { encodeFrame } from "./windows-frames.js";
import {
  ALLOWED_ENVIRONMENT_KEYS,
  encodeLaunchPayload,
  encodeLaunchPayloadWithAllowedEnvironment,
} from "./windows-launch-request.js";
import { isLocalAbsolutePath } from "./windows-path-guard.js";
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
  /**
   * The HOST's own environment, from which exactly one fact — `SystemRoot` — is
   * taken and injected beside the caller's entries.
   *
   * INTERNAL, AND OPT-IN BY PRESENCE. The broker replaces the child's
   * environment with the encoded pairs alone, so a provider launched from a
   * template that carries only its own selection variables starts with no
   * `SystemRoot` at all. Measured on task-d8650fec: the installed Claude
   * runtime's Bun host then refuses to start — `Bun requires the SystemRoot
   * environment variable to be set` — and the process exits 1 while every gate
   * above it reported success. Nothing in the request was wrong: `--model` and
   * `--effort` were accepted.
   *
   * It is an OPTION rather than an ambient read because a host fact read inside
   * this function would reach `claude-host-runtime` and the direct callers too,
   * and because a fact that travels as data can be judged. Omitting the key
   * leaves the raw behaviour exactly as it was.
   */
  readonly hostEnvironment?: unknown;
}

const defaults: WindowsBoundaryDeps = {
  platform: process.platform,
  resolveBroker: () => resolveBrokerBinary(),
  spawn: spawnBroker,
};

/** The canonical Windows spelling. Matching stays case-insensitive. */
const SYSTEM_ROOT = "SystemRoot";

type EnvironmentEntries = readonly (readonly [string, string])[];

const NO_INJECTION: EnvironmentEntries = Object.freeze([]);

/** `Array.isArray` alone does not narrow a READONLY tuple array out of a union. */
function isEntries(value: EnvironmentEntries | WindowsProcessUnknown): value is EnvironmentEntries {
  return Array.isArray(value);
}

function refuseHost(message: string): WindowsProcessUnknown {
  return unknownOutcome(
    "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
    "WINDOWS_PROCESS_REQUEST",
    message,
  );
}

/**
 * Reads the one host fact, or refuses.
 *
 * EXACTLY ONE, AND AS DATA. Windows collapses `SystemRoot` and `SYSTEMROOT`
 * into one variable, so a host record carrying two spellings is ambiguous about
 * which value wins and is refused rather than silently resolved by first match.
 * The value is read from an OWN DATA descriptor — an accessor or a reflection
 * trap is a refusal, never a call — and must satisfy the same local
 * drive-absolute guard the executable and working directory satisfy: a relative
 * or traversing root would be a directory this process never named.
 */
function hostSystemRoot(hostEnvironment: unknown): EnvironmentEntries | WindowsProcessUnknown {
  let names: readonly string[];
  try {
    if (typeof hostEnvironment !== "object" || hostEnvironment === null
      || Array.isArray(hostEnvironment)) {
      return refuseHost("the host environment is not a record");
    }
    names = Object.keys(hostEnvironment).filter((name) => name.toUpperCase() === "SYSTEMROOT");
  } catch {
    return refuseHost("the host environment could not be read as bounded plain data");
  }
  const name = names[0];
  if (names.length !== 1 || name === undefined) {
    return refuseHost(
      names.length === 0
        ? "the host environment declares no SystemRoot"
        : "the host environment declares SystemRoot under more than one spelling",
    );
  }
  let value: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(hostEnvironment, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      return refuseHost("the host SystemRoot is not an own data property");
    }
    value = descriptor.value;
  } catch {
    return refuseHost("the host SystemRoot could not be read as bounded plain data");
  }
  if (!isLocalAbsolutePath(value)) {
    return refuseHost("the host SystemRoot is not a bounded local drive-absolute path");
  }
  return Object.freeze([Object.freeze([SYSTEM_ROOT, value] as const)]);
}

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
  // THE HOST FACT IS JUDGED BEFORE THE REQUEST, because it is not the caller's
  // to supply: it decides which encoder policy the request is then judged under.
  // Presence of the OWN option is what opts in; every other caller keeps the
  // original single-argument encode, unchanged.
  const supplied = Object.getOwnPropertyDescriptor(options, "hostEnvironment");
  const injected = supplied === undefined || !("value" in supplied)
    ? NO_INJECTION
    : hostSystemRoot(supplied.value);
  if (!isEntries(injected)) {
    return injected;
  }
  const payload = injected === NO_INJECTION
    ? encodeLaunchPayload(request)
    : encodeLaunchPayloadWithAllowedEnvironment(request, ALLOWED_ENVIRONMENT_KEYS, injected);
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
