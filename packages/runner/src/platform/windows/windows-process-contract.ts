/**
 * The Windows process-boundary vocabulary: closed code and layer sets, and the
 * immutable result every boundary call returns.
 *
 * DECLARES A SHAPE, DECIDES NOTHING. No path is validated here, no pipe is
 * read, no process is created. The boundary adapter owns every judgement, the
 * same split `platform-contract.ts` keeps between the OS-neutral contract and
 * its per-OS adapters.
 *
 * WHY THIS IS NOT A MEMBER OF `PLATFORM_ERROR_CODES`. That vocabulary answers
 * "can this host be trusted about a boundary". This one answers "did a specific
 * process get created, contained and observed". Merging them would make "which
 * vocabulary refused" unassertable, and would put a Windows-only code on a file
 * every other OS adapter imports. `platform-contract.ts` is also at its 250-line
 * cap and is not this task's to grow.
 */

import { type BrokerRefusal } from "./windows-process-broker-contract.js";

export const WINDOWS_PROCESS_BOUNDARY_VERSION = "moe-windows-process-boundary/1" as const;

/**
 * Which layer refused. The first three are THIS side of the pipe; the last
 * three mirror the broker's `RefusalLayer` (native/broker/src/refusal.rs:39) so
 * a refusal that crossed the wire keeps its identity instead of flattening into
 * "the boundary refused". Flattening is the defect this vocabulary exists to
 * prevent: a check migrating from TypeScript into the broker, or the reverse,
 * must move a test's expected layer rather than leave every assertion green.
 */
export const WINDOWS_PROCESS_LAYERS = Object.freeze([
  /** Caller input, judged before anything is resolved or spawned. */
  "WINDOWS_PROCESS_REQUEST",
  /** Locating and loading the broker binary. */
  "WINDOWS_PROCESS_RESOLUTION",
  /** Driving the broker's pipes: framing, ordering, and its exit. */
  "WINDOWS_PROCESS_TRANSPORT",
  /** Broker `RefusalLayer::Descriptor` — its inherited descriptor block. */
  "BROKER_DESCRIPTOR",
  /** Broker `RefusalLayer::Protocol` — its framing or control stage. */
  "BROKER_PROTOCOL",
  /** Broker `RefusalLayer::Native` — a Win32 call in the Job lifecycle core. */
  "BROKER_NATIVE",
] as const);
export type WindowsProcessLayer = (typeof WINDOWS_PROCESS_LAYERS)[number];

/** UNKNOWN is the default and the floor; nothing in this area may raise it. */
export const WINDOWS_PROCESS_TRUTH_CLASSES = Object.freeze(["PROVEN", "UNKNOWN"] as const);
export type WindowsProcessTruthClass = (typeof WINDOWS_PROCESS_TRUTH_CLASSES)[number];

/**
 * Closed, hand-written, no catch-all. A refusal names a category; it never
 * echoes the executable, argv, cwd or environment that caused it, which is the
 * same rail `ProtocolError` enforces on the Rust side.
 *
 * THERE IS ONE CODE FOR EVERY BROKER REFUSAL, deliberately. Re-spelling the
 * broker's three reason vocabularies here would duplicate authority that
 * already has a frozen definition and one owner; the exact reason travels as
 * `brokerReason`, whose ordinal is only meaningful paired with its layer.
 */
export const WINDOWS_PROCESS_CODES = Object.freeze([
  "PROCESS_BOUNDARY_REQUEST_MALFORMED",
  "PROCESS_BOUNDARY_EXECUTABLE_REJECTED",
  "PROCESS_BOUNDARY_ARGV_REJECTED",
  "PROCESS_BOUNDARY_CWD_REJECTED",
  "PROCESS_BOUNDARY_ENVIRONMENT_REJECTED",
  "PROCESS_BOUNDARY_REQUEST_OVERSIZED",
  "PROCESS_BOUNDARY_PLATFORM_UNSUPPORTED",
  "PROCESS_BOUNDARY_BROKER_UNRESOLVED",
  "PROCESS_BOUNDARY_BROKER_SPAWN_FAILED",
  "PROCESS_BOUNDARY_CHANNEL_FAILED",
  "PROCESS_BOUNDARY_FRAME_VERSION_MISMATCH",
  "PROCESS_BOUNDARY_FRAME_OVERSIZED",
  "PROCESS_BOUNDARY_FRAME_TRUNCATED",
  "PROCESS_BOUNDARY_FRAME_OPCODE_UNKNOWN",
  "PROCESS_BOUNDARY_FRAME_PAYLOAD_MALFORMED",
  "PROCESS_BOUNDARY_FRAME_TRAILING_BYTES",
  "PROCESS_BOUNDARY_STATUS_OUT_OF_ORDER",
  "PROCESS_BOUNDARY_BROKER_REFUSED",
  "PROCESS_BOUNDARY_BROKER_EXITED",
  "PROCESS_BOUNDARY_LAUNCH_TIMED_OUT",
  "PROCESS_BOUNDARY_EXIT_UNOBSERVED",
  "PROCESS_BOUNDARY_IDENTITY_UNPROVEN",
] as const);
export type WindowsProcessCode = (typeof WINDOWS_PROCESS_CODES)[number];

/**
 * PID PAIRED WITH CREATION TIME, never a PID alone. Windows reuses PIDs, so a
 * bare PID cannot identify one process across its own death, and every death
 * proof built on one can name an unrelated live process.
 *
 * `creationTime` is a Windows FILETIME — 100-nanosecond ticks since 1601 — and
 * is a `bigint` because that value is past `Number.MAX_SAFE_INTEGER` and would
 * silently lose its low digits as a double.
 */
export interface WindowsProcessIdentity {
  readonly pid: number;
  readonly creationTime: bigint;
}

/**
 * The run was created, contained and observed to its end.
 *
 * IT CANNOT BE CONSTRUCTED WITHOUT THE PROOF IT CLAIMS: `provenRun` is its only
 * constructor and it refuses an absent pid, an absent creation time or an exit
 * that is not an exact non-negative integer, returning an UNKNOWN instead. So
 * "a PROVEN result always carries a full identity" holds by construction rather
 * than by every call site remembering to check.
 */
export interface WindowsProcessProven {
  readonly truthClass: "PROVEN";
  readonly identity: WindowsProcessIdentity;
  readonly exitCode: number;
}

/**
 * Nothing was proven. Carries the exact code AND the refusing layer, because
 * "it failed" is not an answer a caller can act on or a test can pin.
 *
 * `identity` is non-null exactly when a process WAS created before the failure —
 * a run whose end could not be observed still has a name, and the caller needs
 * it to reap. `brokerReason` is non-null exactly when the refusal crossed the
 * wire.
 */
export interface WindowsProcessUnknown {
  readonly truthClass: "UNKNOWN";
  readonly code: WindowsProcessCode;
  readonly layer: WindowsProcessLayer;
  readonly message: string;
  readonly identity: WindowsProcessIdentity | null;
  readonly brokerReason: BrokerRefusal | null;
}

export type WindowsProcessOutcome = WindowsProcessProven | WindowsProcessUnknown;

/** Every identity is frozen at construction, so a caller cannot rewrite a proof. */
export function processIdentity(pid: number, creationTime: bigint): WindowsProcessIdentity {
  return Object.freeze({ pid, creationTime });
}

function isProvableIdentity(identity: WindowsProcessIdentity): boolean {
  return (
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    typeof identity.creationTime === "bigint" &&
    identity.creationTime > 0n
  );
}

export interface UnknownDetail {
  readonly identity?: WindowsProcessIdentity | null;
  readonly brokerReason?: BrokerRefusal | null;
}

/**
 * Copies rather than freezes in place. Freezing the caller's own object would
 * reach out of this function and change something it does not own; copying is
 * what makes the result immutable without the caller's retained reference
 * staying a back door into it.
 */
function sealedRefusal(refusal: BrokerRefusal | null | undefined): BrokerRefusal | null {
  if (refusal === null || refusal === undefined) {
    return null;
  }
  return Object.freeze({ layer: refusal.layer, reason: refusal.reason, code: refusal.code });
}

export function unknownOutcome(
  code: WindowsProcessCode,
  layer: WindowsProcessLayer,
  message: string,
  detail: UnknownDetail = {},
): WindowsProcessUnknown {
  const identity = detail.identity ?? null;
  return Object.freeze({
    truthClass: "UNKNOWN" as const,
    code,
    layer,
    message,
    identity: identity === null ? null : processIdentity(identity.pid, identity.creationTime),
    brokerReason: sealedRefusal(detail.brokerReason),
  });
}

/**
 * The ONLY way to build a PROVEN outcome, and it refuses rather than trusts.
 *
 * A zero pid, a zero creation time or a non-integer exit are the shapes an
 * unparsed or defaulted status frame produces, and each would otherwise be
 * laundered into a proof. They come back as `PROCESS_BOUNDARY_IDENTITY_UNPROVEN`
 * on the transport layer, which is where the frame was read.
 */
export function provenRun(
  identity: WindowsProcessIdentity,
  exitCode: number,
): WindowsProcessOutcome {
  if (!isProvableIdentity(identity)) {
    return unknownOutcome(
      "PROCESS_BOUNDARY_IDENTITY_UNPROVEN",
      "WINDOWS_PROCESS_TRANSPORT",
      "the started frame did not carry a usable pid paired with a creation time",
    );
  }
  if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
    return unknownOutcome(
      "PROCESS_BOUNDARY_IDENTITY_UNPROVEN",
      "WINDOWS_PROCESS_TRANSPORT",
      "the completed frame did not carry an exact non-negative exit code",
      { identity },
    );
  }
  return Object.freeze({
    truthClass: "PROVEN" as const,
    identity: processIdentity(identity.pid, identity.creationTime),
    exitCode,
  });
}

export function isWindowsProcessCode(value: unknown): value is WindowsProcessCode {
  return typeof value === "string" && (WINDOWS_PROCESS_CODES as readonly string[]).includes(value);
}

export function isWindowsProcessLayer(value: unknown): value is WindowsProcessLayer {
  return typeof value === "string" && (WINDOWS_PROCESS_LAYERS as readonly string[]).includes(value);
}
