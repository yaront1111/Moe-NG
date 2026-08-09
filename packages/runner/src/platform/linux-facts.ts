import { isNormalizedText, isPlainRecord } from "../canonical.js";
import {
  CLAUDE_RECONCILIATION_VERSION,
  type ClaudeReconciliation,
} from "../providers/claude/claude-cancel-reconcile.js";
import {
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  RUNTIME_PINNING_METHODS,
  type ProviderRuntimeObservation,
  type RuntimePinningMethod,
} from "../providers/claude/claude-observation.js";
import type { CrashClassification } from "../recovery/crash-classification.js";
import { SCOPE_OBSERVATION_VERSION, type ScopeObservation } from "../scope/scope-contract.js";
import { parseMirroredLease, type MirroredLeaseRecord } from "../supervisor/effect-shape.js";
import {
  WORKSPACE_INPUT_MANIFEST_VERSION,
  type WorkspaceInputManifest,
} from "../workspace/workspace-contract.js";
import {
  hostIdentityMatches,
  platformFailure,
  readHostIdentity,
  snapshotExactRecord,
  type PlatformBoundary,
  type PlatformErrorCode,
  type PlatformFailure,
  type PlatformHostIdentity,
  type PlatformLayer,
} from "./platform-contract.js";

/**
 * What each Linux boundary's fact payload has to look like, and how a payload
 * is refused.
 *
 * Every check here composes a contract another area already owns — a provider
 * runtime observation, a scope observation, a workspace manifest, a mirrored
 * lease, a reconciliation, a crash classification — and re-derives none of
 * their semantics. Nothing in this module launches, signals or measures
 * anything: no `child_process`, no clock, no `process.platform`, no randomness.
 */
export const PLATFORM_LINUX_LAYER: PlatformLayer = "PLATFORM_LINUX";

export interface LinuxClassificationContext {
  readonly host: PlatformHostIdentity;
  readonly asOf: string;
  readonly maxFactAgeMs: number;
}

/** The Git/workspace boundary observes two existing records together. */
export interface LinuxWorkspaceFact {
  readonly scope: ScopeObservation;
  readonly workspace: WorkspaceInputManifest;
}

/** The one boundary with no pre-existing runner contract behind it. */
export interface LinuxPathFact {
  readonly path: string;
  readonly symlinkTarget: string | null;
  readonly resolvedPath: string;
}

export interface LinuxBoundaryPayloads {
  readonly PROVIDER_LAUNCH: ProviderRuntimeObservation;
  readonly GIT_WORKSPACE: LinuxWorkspaceFact;
  readonly PATH_SYMLINK: LinuxPathFact;
  readonly LOCK: MirroredLeaseRecord;
  readonly SIGNAL_CANCELLATION: ClaudeReconciliation;
  readonly RUNTIME_CLOSURE: ProviderRuntimeObservation;
  readonly CRASH_RECOVERY: CrashClassification;
}

const MAX_PLATFORM_PATH_CHARS = 400;
const PROVIDER_OBSERVATION_KEYS = Object.freeze([
  "observationVersion",
  "providerId",
  "resolvedRuntimeClosure",
  "reportedVersion",
  "adapterCapabilitySchemaDigest",
  "pinningMethod",
  "platformIdentity",
  "freshness",
  "truthClass",
  "observationDigest",
] as const);
const WORKSPACE_FACT_KEYS = Object.freeze(["scope", "workspace"] as const);
const PATH_FACT_KEYS = Object.freeze(["path", "symlinkTarget", "resolvedPath"] as const);

export function linuxRefusal(
  code: PlatformErrorCode,
  boundary: PlatformBoundary,
  message: string,
): PlatformFailure {
  return platformFailure(code, PLATFORM_LINUX_LAYER, boundary, message);
}

/**
 * Exhaustive by construction: the declared return type makes an unhandled
 * boundary a compile error rather than an implicit `undefined` that would read
 * downstream as "nothing was wrong with it".
 */
export function payloadRejection(
  boundary: PlatformBoundary,
  fact: unknown,
  context: LinuxClassificationContext,
): PlatformFailure | null {
  switch (boundary) {
    case "PROVIDER_LAUNCH":
      return providerRejection(boundary, fact, context, false);
    case "RUNTIME_CLOSURE":
      return providerRejection(boundary, fact, context, true);
    case "GIT_WORKSPACE":
      return workspaceRejection(boundary, fact);
    case "PATH_SYMLINK":
      return pathRejection(boundary, fact);
    case "LOCK":
      return parseMirroredLease(fact) === null
        ? linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a mirrored lease record")
        : null;
    case "SIGNAL_CANCELLATION":
      return ownValue(fact, "reconciliationVersion") === CLAUDE_RECONCILIATION_VERSION
        ? null
        : linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a Claude reconciliation");
    case "CRASH_RECOVERY":
      return crashRejection(boundary, fact);
  }
}

/**
 * The provider's own `truthClass` is MAPPED onto a platform verdict, never
 * adopted: a PROVEN provider observation is a candidate that has already had to
 * clear the envelope's host and freshness gates before it reaches here.
 */
function providerRejection(
  boundary: PlatformBoundary,
  fact: unknown,
  context: LinuxClassificationContext,
  isClosure: boolean,
): PlatformFailure | null {
  const snapshot = snapshotExactRecord(fact, PROVIDER_OBSERVATION_KEYS);
  if (snapshot === null || snapshot["observationVersion"] !== CLAUDE_RUNTIME_OBSERVATION_VERSION) {
    return linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a runtime observation");
  }
  const identity = readHostIdentity(snapshot["platformIdentity"]);
  if (identity === null) {
    return linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "the observation has no usable identity");
  }
  if (!hostIdentityMatches(identity, context.host)) {
    return linuxRefusal(
      "PLATFORM_HOST_MISMATCH",
      boundary,
      "the observation names a different host than the one declared",
    );
  }
  const pinningMethod = snapshot["pinningMethod"];
  if (!isPinningMethod(pinningMethod)) {
    return linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "pinningMethod is outside the vocabulary");
  }
  if (isClosure && pinningMethod === "UNSUPPORTED") {
    return linuxRefusal(
      "PLATFORM_CLOSURE_UNPINNABLE",
      boundary,
      "the runtime closure cannot be pinned on this host",
    );
  }
  if (snapshot["truthClass"] !== "PROVEN") {
    return linuxRefusal("PLATFORM_FACT_UNPROVEN", boundary, "the provider did not prove this");
  }
  return null;
}

function workspaceRejection(boundary: PlatformBoundary, fact: unknown): PlatformFailure | null {
  const snapshot = snapshotExactRecord(fact, WORKSPACE_FACT_KEYS);
  if (
    snapshot === null ||
    ownValue(snapshot["scope"], "observationVersion") !== SCOPE_OBSERVATION_VERSION ||
    ownValue(snapshot["workspace"], "manifestVersion") !== WORKSPACE_INPUT_MANIFEST_VERSION
  ) {
    return linuxRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "fact is not a scope observation paired with a workspace input manifest",
    );
  }
  return null;
}

function pathRejection(boundary: PlatformBoundary, fact: unknown): PlatformFailure | null {
  const snapshot = snapshotExactRecord(fact, PATH_FACT_KEYS);
  if (
    snapshot === null ||
    !isAbsolutePath(snapshot["path"]) ||
    !isAbsolutePath(snapshot["resolvedPath"]) ||
    (snapshot["symlinkTarget"] !== null && !isAbsolutePath(snapshot["symlinkTarget"]))
  ) {
    return linuxRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "fact is not an absolute path observation with a null or absolute symlink target",
    );
  }
  return null;
}

/** A crash classification that refused is not evidence about a platform. */
function crashRejection(boundary: PlatformBoundary, fact: unknown): PlatformFailure | null {
  const kind = ownValue(fact, "kind");
  if (!isPlainRecord(fact) || typeof kind !== "string") {
    return linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a crash classification");
  }
  if (kind === "REFUSED") {
    return linuxRefusal("PLATFORM_FACT_UNPROVEN", boundary, "the crash classification refused");
  }
  if (ownValue(fact, "ok") !== true) {
    return linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "the classification is not affirmative");
  }
  return null;
}

/** Reads an own DATA property, so no accessor on a hostile record is ever invoked. */
export function ownValue(value: unknown, key: string): unknown {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/** A freshness window is a count of milliseconds; Infinity and NaN are not one. */
export function isFactAgeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPinningMethod(value: unknown): value is RuntimePinningMethod {
  return typeof value === "string" && (RUNTIME_PINNING_METHODS as readonly string[]).includes(value);
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= MAX_PLATFORM_PATH_CHARS &&
    isNormalizedText(value)
  );
}
