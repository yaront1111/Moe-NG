import { isNormalizedText, isPlainRecord } from "../../canonical.js";
import {
  CLAUDE_RECONCILIATION_VERSION,
  type ClaudeReconciliation,
} from "../../providers/claude/claude-cancel-reconcile.js";
import {
  CLAUDE_RUNTIME_OBSERVATION_VERSION,
  RUNTIME_PINNING_METHODS,
  type ProviderRuntimeObservation,
  type RuntimePinningMethod,
} from "../../providers/claude/claude-observation.js";
import type { CrashClassification } from "../../recovery/crash-classification.js";
import { SCOPE_OBSERVATION_VERSION, type ScopeObservation } from "../../scope/scope-contract.js";
import { parseMirroredLease, type MirroredLeaseRecord } from "../../supervisor/effect-shape.js";
import {
  WORKSPACE_INPUT_MANIFEST_VERSION,
  type WorkspaceInputManifest,
} from "../../workspace/workspace-contract.js";
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
} from "../platform-contract.js";

/**
 * What each macOS boundary's fact payload has to look like, and how a payload
 * is refused.
 *
 * Structurally this mirrors the Linux adapter and deliberately does NOT import
 * it. Today's shape agreement is a coincidence of which contracts the two
 * systems share; the moment one diverges, a delegating adapter must fork or
 * start lying. More importantly, every refusal below has to be attributable to
 * darwin — calling the Linux classifier would return `PLATFORM_LINUX` verdicts
 * about a mac, the inherited judgement this seam exists to prevent.
 *
 * Nothing here launches, signals or measures anything: no `child_process`, no
 * clock, no `process.platform`, no randomness. Every input is caller-supplied.
 */
export const PLATFORM_MACOS_LAYER: PlatformLayer = "PLATFORM_MACOS";

export interface MacosClassificationContext {
  readonly host: PlatformHostIdentity;
  readonly asOf: string;
  readonly maxFactAgeMs: number;
}

/** The Git/workspace boundary observes two existing records together. */
export interface MacosWorkspaceFact {
  readonly scope: ScopeObservation;
  readonly workspace: WorkspaceInputManifest;
}

/**
 * The one boundary with no pre-existing runner contract behind it. macOS paths
 * are POSIX, so the absolute-path rule matches Linux's — stated here rather
 * than borrowed, because a rule this adapter does not own can change under it.
 */
export interface MacosPathFact {
  readonly path: string;
  readonly symlinkTarget: string | null;
  readonly resolvedPath: string;
}

export interface MacosBoundaryPayloads {
  readonly PROVIDER_LAUNCH: ProviderRuntimeObservation;
  readonly GIT_WORKSPACE: MacosWorkspaceFact;
  readonly PATH_SYMLINK: MacosPathFact;
  readonly LOCK: MirroredLeaseRecord;
  readonly SIGNAL_CANCELLATION: ClaudeReconciliation;
  readonly RUNTIME_CLOSURE: ProviderRuntimeObservation;
  readonly CRASH_RECOVERY: CrashClassification;
}

const MAX_MACOS_PATH_CHARS = 400;
const PROVIDER_OBSERVATION_KEYS = Object.freeze([
  "observationVersion", "providerId", "resolvedRuntimeClosure", "reportedVersion",
  "adapterCapabilitySchemaDigest", "pinningMethod", "platformIdentity", "freshness",
  "truthClass", "observationDigest",
] as const);
const WORKSPACE_FACT_KEYS = Object.freeze(["scope", "workspace"] as const);
const PATH_FACT_KEYS = Object.freeze(["path", "symlinkTarget", "resolvedPath"] as const);

export function macosRefusal(
  code: PlatformErrorCode,
  boundary: PlatformBoundary,
  message: string,
): PlatformFailure {
  return platformFailure(code, PLATFORM_MACOS_LAYER, boundary, message);
}

/**
 * Exhaustive by construction and with no `default`: the declared return type
 * makes an unhandled boundary a compile error rather than an implicit
 * `undefined` that would read downstream as "nothing was wrong with it".
 */
export function macosPayloadRejection(
  boundary: PlatformBoundary,
  fact: unknown,
  context: MacosClassificationContext,
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
        ? macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a mirrored lease record")
        : null;
    case "SIGNAL_CANCELLATION":
      return macosOwnValue(fact, "reconciliationVersion") === CLAUDE_RECONCILIATION_VERSION
        ? null
        : macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a Claude reconciliation");
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
  context: MacosClassificationContext,
  isClosure: boolean,
): PlatformFailure | null {
  const snapshot = snapshotExactRecord(fact, PROVIDER_OBSERVATION_KEYS);
  if (snapshot === null || snapshot["observationVersion"] !== CLAUDE_RUNTIME_OBSERVATION_VERSION) {
    return macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a runtime observation");
  }
  const identity = readHostIdentity(snapshot["platformIdentity"]);
  if (identity === null) {
    return macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "the observation has no identity");
  }
  if (!hostIdentityMatches(identity, context.host)) {
    return macosRefusal(
      "PLATFORM_HOST_MISMATCH",
      boundary,
      "the observation names a different host than the one declared",
    );
  }
  const pinningMethod = snapshot["pinningMethod"];
  if (!isPinningMethod(pinningMethod)) {
    return macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "pinningMethod is out of vocabulary");
  }
  if (isClosure && pinningMethod === "UNSUPPORTED") {
    return macosRefusal(
      "PLATFORM_CLOSURE_UNPINNABLE",
      boundary,
      "the runtime closure cannot be pinned on this host",
    );
  }
  if (snapshot["truthClass"] !== "PROVEN") {
    return macosRefusal("PLATFORM_FACT_UNPROVEN", boundary, "the provider did not prove this");
  }
  return null;
}

function workspaceRejection(boundary: PlatformBoundary, fact: unknown): PlatformFailure | null {
  const snapshot = snapshotExactRecord(fact, WORKSPACE_FACT_KEYS);
  if (
    snapshot === null ||
    macosOwnValue(snapshot["scope"], "observationVersion") !== SCOPE_OBSERVATION_VERSION ||
    macosOwnValue(snapshot["workspace"], "manifestVersion") !== WORKSPACE_INPUT_MANIFEST_VERSION
  ) {
    return macosRefusal(
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
    !isPosixAbsolutePath(snapshot["path"]) ||
    !isPosixAbsolutePath(snapshot["resolvedPath"]) ||
    (snapshot["symlinkTarget"] !== null && !isPosixAbsolutePath(snapshot["symlinkTarget"]))
  ) {
    return macosRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "fact is not an absolute path observation with a null or absolute symlink target",
    );
  }
  return null;
}

/** A crash classification that refused is not evidence about a platform. */
function crashRejection(boundary: PlatformBoundary, fact: unknown): PlatformFailure | null {
  const kind = macosOwnValue(fact, "kind");
  if (!isPlainRecord(fact) || typeof kind !== "string") {
    return macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact is not a crash classification");
  }
  if (kind === "REFUSED") {
    return macosRefusal("PLATFORM_FACT_UNPROVEN", boundary, "the crash classification refused");
  }
  if (macosOwnValue(fact, "ok") !== true) {
    return macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "the classification is not ok");
  }
  return null;
}

/** Reads an own DATA property, so no accessor on a hostile record is ever invoked. */
export function macosOwnValue(value: unknown, key: string): unknown {
  try {
    if (!isPlainRecord(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** A freshness window is a count of milliseconds; Infinity and NaN are not one. */
export function isMacosFactAgeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPinningMethod(value: unknown): value is RuntimePinningMethod {
  return typeof value === "string" && (RUNTIME_PINNING_METHODS as readonly string[]).includes(value);
}

function isPosixAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= MAX_MACOS_PATH_CHARS &&
    isNormalizedText(value)
  );
}
