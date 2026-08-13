import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { deepFreeze } from "../../canonical.js";
import { WINDOWS_PROCESS_CODES,
  WINDOWS_PROCESS_LAYERS } from "../../platform/windows/windows-process-contract.js";
import { exactRecord, isCount, oneOf, readOwnDataProperty } from "../../supervisor/effect-shape.js";
import { parseProcessExit,
  parseReconciliationReference } from "../../supervisor/process-observation.js";
import { type ClaudeProcessExit } from "./claude-cancel-reconcile.js";
import { decodeRefusedArm, isInstance, isSafeNativePromise, isSafeObject, readCapability,
  type Capability } from "./claude-launcher-port-results.js";
import { type ClaudeLaunchErrorCode, type ClaudeLaunchLayer,
  type ClaudeStreamEvidence } from "./claude-launcher-contract.js";

/**
 * Total decoding for the process-lifecycle side of the launcher.
 *
 * A live boundary is NOT an exact plain record — `BrokerSession` is a class with
 * `cancel`/`close` on its prototype — so cleanup is captured by a bounded
 * descriptor walk rather than by record parsing. Cleanup is captured FIRST and
 * on its own: once a provider may have spawned, the ability to kill it matters
 * more than whether the rest of the object validates, and a reader that gave up
 * on the first bad field would leak the child it just created.
 */
export interface BoundaryCleanup {
  readonly cancel: Capability;
  readonly close: Capability;
}

export interface SafeBoundary extends BoundaryCleanup {
  readonly started: Promise<unknown>;
  readonly completed: Promise<unknown>;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export type BoundaryAdaptation =
  /** A fully validated typed Windows refusal: nothing was created, nothing to clean. */
  | { readonly kind: "REFUSAL"; readonly code: ClaudeLaunchErrorCode;
      readonly layer: ClaudeLaunchLayer }
  | { readonly kind: "BOUNDARY"; readonly boundary: SafeBoundary }
  /** Cleanup is owned, the rest is not usable: cancel, close, then release. */
  | { readonly kind: "BROKEN"; readonly cleanup: BoundaryCleanup }
  /** No cleanup could be captured, so a spawn can neither be ruled out nor undone. */
  | { readonly kind: "UNOWNED" };

export interface NormalizedIdentity {
  readonly pid: number;
  readonly creationTime: bigint;
}

export type NormalizedStart =
  | { readonly kind: "IDENTITY"; readonly identity: NormalizedIdentity }
  | { readonly kind: "UNKNOWN"; readonly code: ClaudeLaunchErrorCode;
      readonly layer: ClaudeLaunchLayer }
  | { readonly kind: "MALFORMED" };

export type NormalizedOutcome =
  | { readonly kind: "PROVEN"; readonly identity: NormalizedIdentity; readonly exitCode: number }
  | { readonly kind: "UNKNOWN"; readonly code: ClaudeLaunchErrorCode;
      readonly layer: ClaudeLaunchLayer }
  | { readonly kind: "MALFORMED" };

export type NormalizedObservation =
  | { readonly kind: "OBSERVED"; readonly processExit: ClaudeProcessExit; readonly proven: boolean }
  | { readonly kind: "REFUSED"; readonly code: ClaudeLaunchErrorCode;
      readonly layer: ClaudeLaunchLayer }
  | { readonly kind: "MALFORMED" };

const MALFORMED = Object.freeze({ kind: "MALFORMED" as const });
const UNOWNED: BoundaryAdaptation = Object.freeze({ kind: "UNOWNED" as const });
const UNKNOWN_KEYS = ["truthClass", "code", "layer", "message", "identity", "brokerReason"] as const;
const PROVEN_KEYS = ["truthClass", "identity", "exitCode"] as const;
const IDENTITY_KEYS = ["pid", "creationTime"] as const;
const BROKER_KEYS = ["layer", "reason", "code"] as const;
const OBSERVED_KEYS = ["kind", "ok", "observation"] as const;
const OBSERVATION_KEYS = ["processExit", "proven", "reconciliation"] as const;

function readIdentity(value: unknown): NormalizedIdentity | null {
  const parsed = exactRecord(value, IDENTITY_KEYS);
  if (parsed === null) return null;
  const creationTime = parsed["creationTime"];
  if (!isCount(parsed["pid"]) || parsed["pid"] <= 0) return null;
  if (typeof creationTime !== "bigint" || creationTime <= 0n) return null;
  return Object.freeze({ pid: parsed["pid"], creationTime });
}

function isBrokerReason(value: unknown): boolean {
  if (value === null) return true;
  const parsed = exactRecord(value, BROKER_KEYS);
  return parsed !== null && oneOf(parsed["layer"], WINDOWS_PROCESS_LAYERS) &&
    isCount(parsed["reason"]) && isCount(parsed["code"]);
}

/** A Windows refusal keeps its own code and layer only after all six fields validate. */
function readWindowsRefusal(
  value: unknown,
): { readonly code: ClaudeLaunchErrorCode; readonly layer: ClaudeLaunchLayer } | null {
  const parsed = exactRecord(value, UNKNOWN_KEYS);
  if (parsed === null || parsed["truthClass"] !== "UNKNOWN") return null;
  if (!oneOf(parsed["code"], WINDOWS_PROCESS_CODES)) return null;
  if (!oneOf(parsed["layer"], WINDOWS_PROCESS_LAYERS)) return null;
  if (typeof parsed["message"] !== "string" || !isBrokerReason(parsed["brokerReason"])) return null;
  if (parsed["identity"] !== null && readIdentity(parsed["identity"]) === null) return null;
  return Object.freeze({ code: parsed["code"], layer: parsed["layer"] });
}

export function normalizeStart(value: unknown): NormalizedStart {
  const identity = readIdentity(value);
  if (identity !== null) return Object.freeze({ kind: "IDENTITY" as const, identity });
  const refusal = readWindowsRefusal(value);
  return refusal === null ? MALFORMED
    : Object.freeze({ kind: "UNKNOWN" as const, code: refusal.code, layer: refusal.layer });
}

export function normalizeOutcome(value: unknown): NormalizedOutcome {
  const proven = exactRecord(value, PROVEN_KEYS);
  if (proven !== null) {
    const identity = readIdentity(proven["identity"]);
    if (proven["truthClass"] !== "PROVEN" || identity === null) return MALFORMED;
    if (!isCount(proven["exitCode"])) return MALFORMED;
    return Object.freeze({ kind: "PROVEN" as const, identity, exitCode: proven["exitCode"] });
  }
  const refusal = readWindowsRefusal(value);
  return refusal === null ? MALFORMED
    : Object.freeze({ kind: "UNKNOWN" as const, code: refusal.code, layer: refusal.layer });
}

export function normalizeObservation(value: unknown): NormalizedObservation {
  const refused = decodeRefusedArm(value);
  if (refused !== null) {
    return refused.kind === "REFUSED"
      ? Object.freeze({ kind: "REFUSED" as const, code: refused.code, layer: refused.layer })
      : MALFORMED;
  }
  const parsed = exactRecord(value, OBSERVED_KEYS);
  if (parsed === null || parsed["kind"] !== "OBSERVED" || parsed["ok"] !== true) return MALFORMED;
  const observation = exactRecord(parsed["observation"], OBSERVATION_KEYS);
  if (observation === null || typeof observation["proven"] !== "boolean") return MALFORMED;
  const processExit = parseProcessExit(observation["processExit"]);
  if (processExit === null) return MALFORMED;
  const reconciliation = observation["reconciliation"];
  if (reconciliation !== null && parseReconciliationReference(reconciliation) === null) {
    return MALFORMED;
  }
  if (observation["proven"] !== (processExit.kind !== "UNOBSERVED")) return MALFORMED;
  return Object.freeze({ kind: "OBSERVED" as const, processExit: Object.freeze({ ...processExit }),
    proven: observation["proven"] });
}

/** A hostile stream must reach BROKEN, which still owns cleanup, never UNOWNED. */
const isSafeReadable = (value: unknown): value is Readable =>
  isSafeObject(value) && isInstance(value, Readable);
export function adaptBoundaryOpen(value: unknown): BoundaryAdaptation {
  const refusal = readWindowsRefusal(value);
  if (refusal !== null) {
    return Object.freeze({ kind: "REFUSAL" as const, code: refusal.code, layer: refusal.layer });
  }
  const cancel = readCapability(value, "cancel");
  const close = readCapability(value, "close");
  if (cancel === null || close === null) return UNOWNED;
  const cleanup: BoundaryCleanup = Object.freeze({ cancel, close });
  const broken: BoundaryAdaptation = Object.freeze({ kind: "BROKEN" as const, cleanup });
  const source = value as object;
  const started = readOwnDataProperty(source, "started");
  const completed = readOwnDataProperty(source, "completed");
  const stdout = readOwnDataProperty(source, "providerStdout");
  const stderr = readOwnDataProperty(source, "providerStderr");
  if (!started.ok || !started.present || !completed.ok || !completed.present) return broken;
  if (!stdout.ok || !stdout.present || !stderr.ok || !stderr.present) return broken;
  if (!isSafeNativePromise(started.value) || !isSafeNativePromise(completed.value)) return broken;
  if (!isSafeReadable(stdout.value) || !isSafeReadable(stderr.value)) return broken;
  return Object.freeze({ kind: "BOUNDARY" as const, boundary: Object.freeze({ cancel, close,
    started: started.value, completed: completed.value,
    stdout: stdout.value, stderr: stderr.value }) });
}

export interface CapturedStream {
  readonly evidence: ClaudeStreamEvidence;
  readonly failed: boolean;
}

/** Bounded capture: the digest covers every byte, the copy stops at `limit`. */
export async function captureStream(
  stream: Readable, limit: number, tailLimit: number,
): Promise<CapturedStream> {
  const hash = createHash("sha256");
  const captured: Buffer[] = [];
  let capturedLength = 0;
  let tail = Buffer.alloc(0);
  let byteLength = 0;
  try {
    for await (const value of stream) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      hash.update(bytes);
      byteLength += bytes.length;
      if (capturedLength < limit) {
        const part = bytes.subarray(0, limit - capturedLength);
        captured.push(Buffer.from(part)); capturedLength += part.length;
      }
      tail = bytes.length >= tailLimit ? Buffer.from(bytes.subarray(-tailLimit)) :
        Buffer.concat([tail, bytes]).subarray(-tailLimit);
    }
    return finishCapture(false);
  } catch { return finishCapture(true); }
  function finishCapture(failed: boolean): CapturedStream {
    return deepFreeze({ failed, evidence: { capturedBase64: Buffer.concat(captured).toString("base64"),
      tailBase64: tail.toString("base64"), byteLength, sha256: hash.digest("hex"),
      truncated: byteLength > limit, complete: !failed } });
  }
}
