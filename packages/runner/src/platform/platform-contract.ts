import { isNormalizedText, isPlainRecord } from "../canonical.js";

/**
 * OS-neutral vocabulary for platform boundary observation.
 *
 * Declares WHAT a platform boundary is and HOW a refusal is shaped; classifies
 * nothing. Every judgement about an operating system lives in that OS's own
 * adapter, so a second OS can be added without touching the shared shape and —
 * the point of the separation — without inheriting another OS's proven facts.
 * The only OS names here are the `PLATFORM_LINUX` and `PLATFORM_MACOS` members
 * of `PLATFORM_LAYERS`, which name refusing layers, not behaviour.
 */
export const PLATFORM_OBSERVATION_VERSION = "moe-platform-observation/1" as const;

/**
 * The boundaries where an operating system can change an outcome the runner
 * otherwise treats as settled. Frozen and hand-written: a boundary that nobody
 * classifies cannot be added, and a boundary that disappears takes its tests
 * red with it.
 */
export const PLATFORM_BOUNDARIES = Object.freeze([
  "PROVIDER_LAUNCH",
  "GIT_WORKSPACE",
  "PATH_SYMLINK",
  "LOCK",
  "SIGNAL_CANCELLATION",
  "RUNTIME_CLOSURE",
  "CRASH_RECOVERY",
] as const);
export type PlatformBoundary = (typeof PLATFORM_BOUNDARIES)[number];

/**
 * Layers, because "the observation was refused" is not an answer. A caller must
 * be able to tell the OS-neutral shape gate — this is not a boundary name, this
 * is not a host record — from an OS adapter's judgement that a well-formed fact
 * does not hold on this host. Only the second is evidence about a platform.
 * One member per OS adapter and no shared "PLATFORM_OS" catch-all: a darwin
 * refusal spelled the same way as a Linux one is indistinguishable from an
 * inherited one, which is the failure this split exists to prevent.
 */
export const PLATFORM_LAYERS = Object.freeze(
  ["PLATFORM_CONTRACT", "PLATFORM_LINUX", "PLATFORM_MACOS"] as const,
);
export type PlatformLayer = (typeof PLATFORM_LAYERS)[number];

/** UNKNOWN is the default and the floor: nothing in this area may raise it. */
export const PLATFORM_TRUTH_CLASSES = Object.freeze(["PROVEN", "UNKNOWN"] as const);
export type PlatformTruthClass = (typeof PLATFORM_TRUTH_CLASSES)[number];

export const PLATFORM_ERROR_CODES = Object.freeze([
  "PLATFORM_BOUNDARY_UNKNOWN",
  "PLATFORM_FACT_MALFORMED",
  "PLATFORM_FACT_ABSENT",
  "PLATFORM_HOST_MISMATCH",
  "PLATFORM_FACT_STALE",
  "PLATFORM_FACT_UNPROVEN",
  "PLATFORM_ARCH_UNSUPPORTED",
  "PLATFORM_CLOSURE_UNPINNABLE",
  "PLATFORM_COVERAGE_INCOMPLETE",
] as const);
export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[number];

/**
 * Declared here rather than imported. `PlatformIdentity` already exists twice —
 * in the Claude adapter and in the Codex one — each that adapter's local record
 * of what it observed. Importing either would bind the OS-neutral contract to
 * one provider and bless one duplicate as canonical; unifying them is a
 * refactor of two adapters, not this boundary's call.
 */
export interface PlatformHostIdentity {
  readonly os: string;
  readonly arch: string;
  readonly osVersion: string;
}

/**
 * Most runner contracts a platform boundary classifies — a workspace manifest,
 * a mirrored lease, a reconciliation, a crash classification — carry neither a
 * host nor an instant, because neither is a fact about them; the caller states
 * both alongside the fact. `truthClass` is the caller's own claim about the
 * payload, which an adapter maps onto a verdict and never simply adopts.
 */
export interface PlatformFactEnvelope<Fact> {
  readonly host: PlatformHostIdentity;
  readonly observedAt: string;
  readonly truthClass: PlatformTruthClass;
  readonly fact: Fact;
}

export const PLATFORM_ENVELOPE_KEYS = Object.freeze(["host", "observedAt", "truthClass", "fact"] as const);

export const PLATFORM_HOST_KEYS = Object.freeze(["os", "arch", "osVersion"] as const);

export interface PlatformFailure {
  readonly ok: false;
  readonly code: PlatformErrorCode;
  readonly layer: PlatformLayer;
  /** Null when the refusal is not about one boundary — an unusable boundary name. */
  readonly boundary: PlatformBoundary | null;
  readonly message: string;
}

export function platformFailure(
  code: PlatformErrorCode,
  layer: PlatformLayer,
  boundary: PlatformBoundary | null,
  message: string,
): PlatformFailure {
  return Object.freeze({ ok: false as const, code, layer, boundary, message });
}

export function isPlatformFailure(value: unknown): value is PlatformFailure {
  return (
    isPlainRecord(value) &&
    value["ok"] === false &&
    typeof value["code"] === "string" &&
    typeof value["layer"] === "string" &&
    typeof value["message"] === "string"
  );
}

export interface PlatformBoundaryVerdict {
  readonly boundary: PlatformBoundary;
  readonly truthClass: PlatformTruthClass;
  readonly failure: PlatformFailure | null;
}

export interface PlatformObservation {
  readonly observationVersion: typeof PLATFORM_OBSERVATION_VERSION;
  /** Null when the caller's host record was unusable; an invented default host
   * would put a fact on the observation that nobody supplied. */
  readonly host: PlatformHostIdentity | null;
  readonly verdicts: readonly PlatformBoundaryVerdict[];
  readonly truthClass: PlatformTruthClass;
}

export function isPlatformBoundary(value: unknown): value is PlatformBoundary {
  return typeof value === "string" && (PLATFORM_BOUNDARIES as readonly string[]).includes(value);
}

/** The OS-neutral shape gate: is this even a boundary this package knows? */
export function platformBoundaryRejection(boundary: unknown, layer: PlatformLayer): PlatformFailure | null {
  if (isPlatformBoundary(boundary)) {
    return null;
  }
  return platformFailure(
    "PLATFORM_BOUNDARY_UNKNOWN",
    layer,
    null,
    "boundary is not a member of the frozen platform boundary vocabulary",
  );
}

/**
 * Shape only. Deliberately does not know what any particular `os` value means —
 * deciding that "linux" is this host's operating system is an adapter's
 * judgement, and putting it here would make the shared contract answer for one
 * OS on behalf of every other.
 */
export function platformHostRejection(
  host: unknown,
  layer: PlatformLayer,
  boundary: PlatformBoundary | null = null,
): PlatformFailure | null {
  if (readHostIdentity(host) === null) {
    return platformFailure(
      "PLATFORM_FACT_MALFORMED",
      layer,
      boundary,
      "host identity is not a record of bounded normalized os, arch and osVersion",
    );
  }
  return null;
}

/**
 * Returns the host as a frozen copy rather than a boolean, so a caller compares
 * the bytes the gate validated. Re-reading the original is what lets a hostile
 * record pass validation and then be recorded as something else.
 */
export function readHostIdentity(value: unknown): PlatformHostIdentity | null {
  const snapshot = snapshotExactRecord(value, PLATFORM_HOST_KEYS);
  if (snapshot === null) {
    return null;
  }
  for (const key of PLATFORM_HOST_KEYS) {
    if (!isBoundedIdentityText(snapshot[key])) {
      return null;
    }
  }
  return Object.freeze({
    os: snapshot["os"] as string,
    arch: snapshot["arch"] as string,
    osVersion: snapshot["osVersion"] as string,
  });
}

/** Structural equality across all three fields; a partial match is not a match. */
export function hostIdentityMatches(a: PlatformHostIdentity, b: PlatformHostIdentity): boolean {
  return a.os === b.os && a.arch === b.arch && a.osVersion === b.osVersion;
}

export const MAX_PLATFORM_IDENTITY_CHARS = 128;

export function isBoundedIdentityText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PLATFORM_IDENTITY_CHARS &&
    isNormalizedText(value)
  );
}

/**
 * Lifts every named key out of its own property DESCRIPTOR into a
 * null-prototype snapshot, so no accessor is ever invoked — not even once. A
 * record that computes its own fields can answer one way for validation and
 * another for the record, and refusing it outright is cheaper than out-reading
 * it. An unexpected own key is a rejection, not something to ignore.
 *
 * Exactness is counted over `Reflect.ownKeys`, not `Object.keys`, which reports
 * neither symbol-keyed nor non-enumerable own properties — two places to hide a
 * field from a count meant to be exact. Each expected key must then be an
 * ENUMERABLE own data property, because `Reflect.ownKeys` alone would accept
 * the hidden spelling of a field the old count rejected.
 */
export function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  // Every reflective call below can be trapped by a proxy and made to throw.
  // Refusing is the fail-closed answer; propagating would turn a hostile input
  // into an exception out of a seam whose callers can only handle a refusal.
  try {
    if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== keys.length) {
      return null;
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}
