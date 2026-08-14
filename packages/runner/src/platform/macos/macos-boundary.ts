import { isCanonicalUtcTimestamp } from "../../canonical.js";
import { canonicalEpochMillis } from "../platform-instant.js";
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
} from "../platform-contract.js";
import {
  isMacosFactAgeMs,
  macosPayloadRejection,
  macosRefusal,
  type MacosClassificationContext,
} from "./macos-facts.js";

/**
 * macOS boundary classification: the gate order, and only the gate order.
 *
 * The host under discussion is a caller-supplied field, not the machine this
 * code runs on. That is what lets a non-darwin machine exercise the on-host
 * path at all, and it is what keeps every verdict reproducible: nothing here
 * reads a clock, an environment, or a process. A green run of these gates on a
 * Windows box says the classifier is correct — it says nothing about any mac.
 */
export { PLATFORM_MACOS_LAYER } from "./macos-facts.js";
export type {
  MacosBoundaryPayloads,
  MacosClassificationContext,
  MacosPathFact,
  MacosWorkspaceFact,
} from "./macos-facts.js";

/**
 * A boundary name outside the frozen vocabulary is refused by the OS-neutral
 * contract layer, not by macOS — it is a fact about the call, not about a host.
 * Hence the union return: there is no honest verdict to build when there is no
 * boundary to attach one to.
 */
export function classifyMacosBoundary(
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
  const settings = readMacosClassificationContext(context);
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
  context: MacosClassificationContext,
): PlatformFailure | null {
  if (envelope === null || envelope === undefined) {
    return macosRefusal("PLATFORM_FACT_ABSENT", boundary, "no fact was supplied for this boundary");
  }
  const snapshot = snapshotExactRecord(envelope, PLATFORM_ENVELOPE_KEYS);
  if (snapshot === null) {
    return macosRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "fact envelope is not a record of exactly host, observedAt, truthClass and fact",
    );
  }
  const host = readHostIdentity(snapshot["host"]);
  if (host === null) {
    return macosRefusal("PLATFORM_FACT_MALFORMED", boundary, "fact envelope has no usable host");
  }
  // Bound to the host the CONTEXT asserts, not merely to something darwin-ish:
  // a fact observed on a different mac is still a fact about a different mac.
  if (!hostIdentityMatches(host, context.host)) {
    return macosRefusal(
      "PLATFORM_HOST_MISMATCH",
      boundary,
      "fact was observed on a different host than the one declared",
    );
  }
  const observedAt = snapshot["observedAt"];
  if (!isCanonicalUtcTimestamp(observedAt) || !isTruthClass(snapshot["truthClass"])) {
    return macosRefusal(
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
    return macosRefusal(
      "PLATFORM_FACT_UNPROVEN",
      boundary,
      "the caller did not claim this fact proven",
    );
  }
  return macosPayloadRejection(boundary, snapshot["fact"], context);
}

/**
 * Compares two caller-supplied instants and nothing else. A fact dated after
 * `asOf` is refused rather than credited: post-dating is the cheapest way to
 * defeat a freshness window implemented as a subtraction.
 */
function freshnessRejection(
  boundary: PlatformBoundary,
  observedAt: string,
  context: MacosClassificationContext,
): PlatformFailure | null {
  const observed = canonicalEpochMillis(observedAt);
  const asOf = canonicalEpochMillis(context.asOf);
  if (observed === null || asOf === null) {
    return macosRefusal(
      "PLATFORM_FACT_MALFORMED",
      boundary,
      "an instant could not be placed on a line",
    );
  }
  const ageMs = asOf - observed;
  if (ageMs < 0 || ageMs > context.maxFactAgeMs) {
    return macosRefusal(
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
export function readMacosClassificationContext(
  value: unknown,
): MacosClassificationContext | null {
  const snapshot = snapshotExactRecord(value, CONTEXT_KEYS);
  if (snapshot === null) {
    return null;
  }
  const host = readHostIdentity(snapshot["host"]);
  const asOf = snapshot["asOf"];
  const maxFactAgeMs = snapshot["maxFactAgeMs"];
  if (host === null || !isCanonicalUtcTimestamp(asOf) || !isMacosFactAgeMs(maxFactAgeMs)) {
    return null;
  }
  return Object.freeze({ host, asOf, maxFactAgeMs });
}
