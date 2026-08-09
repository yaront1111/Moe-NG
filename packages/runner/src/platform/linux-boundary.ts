import { isCanonicalUtcTimestamp } from "../canonical.js";
import {
  isFactAgeMs,
  linuxRefusal,
  payloadRejection,
  type LinuxClassificationContext,
} from "./linux-facts.js";
import { canonicalEpochMillis } from "./platform-instant.js";
import {
  PLATFORM_ENVELOPE_KEYS,
  PLATFORM_TRUTH_CLASSES,
  hostIdentityMatches,
  platformBoundaryRejection,
  platformFailure,
  readHostIdentity,
  snapshotExactRecord,
  type PlatformBoundary,
  type PlatformBoundaryVerdict,
  type PlatformFailure,
  type PlatformTruthClass,
} from "./platform-contract.js";

/**
 * Linux boundary classification: the gate order, and only the gate order.
 *
 * The host under discussion is a caller-supplied field, not the machine this
 * code runs on. That is what lets a non-Linux machine exercise the on-host path
 * at all, and it is what keeps every verdict reproducible: nothing here reads a
 * clock, an environment, or a process.
 */
export { PLATFORM_LINUX_LAYER } from "./linux-facts.js";
export type {
  LinuxBoundaryPayloads,
  LinuxClassificationContext,
  LinuxPathFact,
  LinuxWorkspaceFact,
} from "./linux-facts.js";

/**
 * A boundary name outside the frozen vocabulary is refused by the OS-neutral
 * contract layer, not by Linux — it is a fact about the call, not about a host.
 * Hence the union return: there is no honest verdict to build when there is no
 * boundary to attach one to.
 */
export function classifyLinuxBoundary(
  boundary: unknown,
  envelope: unknown,
  context: unknown,
): PlatformBoundaryVerdict | PlatformFailure {
  const rejection = platformBoundaryRejection(boundary, "PLATFORM_CONTRACT");
  if (rejection !== null) {
    return rejection;
  }
  const named = boundary as PlatformBoundary;
  // The context is caller-supplied too. Trusting it would make a malformed
  // context THROW out of a published seam instead of refusing, which is the one
  // outcome a consumer cannot fail closed on.
  const settings = readClassificationContext(context);
  if (settings === null) {
    return platformFailure(
      "PLATFORM_FACT_MALFORMED",
      "PLATFORM_CONTRACT",
      named,
      "classification context is not a record of a usable host, canonical asOf and maxFactAgeMs",
    );
  }
  const failure = envelopeRejection(named, envelope, settings);
  return Object.freeze({
    boundary: named,
    truthClass: (failure === null ? "PROVEN" : "UNKNOWN") satisfies PlatformTruthClass,
    failure,
  });
}

/**
 * Gate order is load-bearing. Absence is answered before shape, shape before
 * host, host before freshness, and the caller's own claim last — so no input
 * can score better by leaving a field out than by supplying a bad one, and no
 * later gate can raise an earlier UNKNOWN back to PROVEN.
 */
function envelopeRejection(
  boundary: PlatformBoundary,
  envelope: unknown,
  context: LinuxClassificationContext,
): PlatformFailure | null {
  if (envelope === null || envelope === undefined) {
    return linuxRefusal("PLATFORM_FACT_ABSENT", boundary, "no fact was supplied for this boundary");
  }
  const snapshot = snapshotExactRecord(envelope, PLATFORM_ENVELOPE_KEYS);
  if (snapshot === null) {
    return linuxRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "fact envelope is not a record of exactly host, observedAt, truthClass and fact",
    );
  }
  const host = readHostIdentity(snapshot["host"]);
  if (host === null) {
    return linuxRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact envelope has no usable host");
  }
  if (!hostIdentityMatches(host, context.host)) {
    return linuxRefusal(
      "PLATFORM_HOST_MISMATCH",
      boundary,
      "fact was observed on a different host than the one declared",
    );
  }
  const observedAt = snapshot["observedAt"];
  if (!isCanonicalUtcTimestamp(observedAt) || !isTruthClass(snapshot["truthClass"])) {
    return linuxRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "observedAt is not a canonical UTC instant or truthClass is outside the vocabulary",
    );
  }
  const stale = freshnessRejection(boundary, observedAt, context);
  if (stale !== null) {
    return stale;
  }
  if (snapshot["truthClass"] !== "PROVEN") {
    return linuxRefusal(
      "PLATFORM_FACT_UNPROVEN",
      boundary,
      "the caller did not claim this fact proven",
    );
  }
  return payloadRejection(boundary, snapshot["fact"], context);
}

/**
 * Compares two caller-supplied instants and nothing else. A fact dated after
 * `asOf` is refused rather than credited: post-dating is the cheapest way to
 * defeat a freshness window implemented as a subtraction.
 */
function freshnessRejection(
  boundary: PlatformBoundary,
  observedAt: string,
  context: LinuxClassificationContext,
): PlatformFailure | null {
  const observed = canonicalEpochMillis(observedAt);
  const asOf = canonicalEpochMillis(context.asOf);
  if (observed === null || asOf === null) {
    return linuxRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "an instant could not be placed on a line",
    );
  }
  const ageMs = asOf - observed;
  if (ageMs < 0 || ageMs > context.maxFactAgeMs) {
    return linuxRefusal(
      "PLATFORM_FACT_STALE",
      boundary,
      "fact was not observed inside the caller's freshness window",
    );
  }
  return null;
}

function isTruthClass(value: unknown): value is PlatformTruthClass {
  return typeof value === "string" && (PLATFORM_TRUTH_CLASSES as readonly string[]).includes(value);
}

const CONTEXT_KEYS = Object.freeze(["host", "asOf", "maxFactAgeMs"] as const);

/** Returns a validated copy so the classifier compares the bytes it checked. */
export function readClassificationContext(value: unknown): LinuxClassificationContext | null {
  const snapshot = snapshotExactRecord(value, CONTEXT_KEYS);
  if (snapshot === null) {
    return null;
  }
  const host = readHostIdentity(snapshot["host"]);
  const asOf = snapshot["asOf"];
  const maxFactAgeMs = snapshot["maxFactAgeMs"];
  if (host === null || !isCanonicalUtcTimestamp(asOf) || !isFactAgeMs(maxFactAgeMs)) {
    return null;
  }
  return Object.freeze({ host, asOf, maxFactAgeMs });
}
