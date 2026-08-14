import { isCanonicalUtcTimestamp } from "../../canonical.js";
import {
  PLATFORM_BOUNDARIES,
  PLATFORM_OBSERVATION_VERSION,
  isPlatformFailure,
  platformFailure,
  readHostIdentity,
  snapshotExactRecord,
  type PlatformBoundary,
  type PlatformBoundaryVerdict,
  type PlatformErrorCode,
  type PlatformFactEnvelope,
  type PlatformHostIdentity,
  type PlatformLayer,
  type PlatformObservation,
} from "../platform-contract.js";
import {
  PLATFORM_MACOS_LAYER,
  classifyMacosBoundary,
  type MacosBoundaryPayloads,
  type MacosClassificationContext,
} from "./macos-boundary.js";
import { isMacosFactAgeMs } from "./macos-facts.js";

/**
 * The macOS platform observation seam.
 *
 * This module OBSERVES NOTHING ITSELF. It classifies facts a caller claims to
 * have observed, on a host the caller names, against an instant the caller
 * supplies. Run on any machine it returns UNKNOWN for every boundary unless the
 * caller hands it coherent, fresh, on-host evidence — which is the honest
 * answer, because no process here has looked at a real mac. A PROVEN verdict
 * from this function means "the supplied darwin observation is coherent", never
 * "this host is a conforming mac"; host-native evidence is a different task's
 * deliverable and cannot be manufactured here.
 */
export { PLATFORM_MACOS_LAYER, classifyMacosBoundary } from "./macos-boundary.js";
export type {
  MacosBoundaryPayloads,
  MacosClassificationContext,
  MacosPathFact,
  MacosWorkspaceFact,
} from "./macos-boundary.js";

/**
 * The `host.os` value this adapter, and only this adapter, speaks for. Node
 * spells macOS "darwin"; internal rather than exported, because a consumer
 * comparing against it would be re-implementing the gate below.
 */
const PLATFORM_MACOS_OS = "darwin" as const;

export const MACOS_SUPPORTED_ARCHITECTURES = Object.freeze(["x64", "arm64"] as const);
export type MacosSupportedArchitecture = (typeof MACOS_SUPPORTED_ARCHITECTURES)[number];

/**
 * Every boundary is a required key. A caller that did not observe something
 * says so with an explicit `null`; a MISSING key is a coverage gap, not a
 * silent absence. Otherwise "I have no lock evidence" and "I forgot locks
 * exist" would be the same input, and the second would quietly look like the
 * first.
 */
export type MacosBoundaryFacts = {
  readonly [Boundary in PlatformBoundary]: PlatformFactEnvelope<
    MacosBoundaryPayloads[Boundary]
  > | null;
};

export interface ObserveMacosPlatformInput {
  readonly host: PlatformHostIdentity;
  readonly asOf: string;
  readonly maxFactAgeMs: number;
  readonly facts: MacosBoundaryFacts;
}

const INPUT_KEYS = Object.freeze(["host", "asOf", "maxFactAgeMs", "facts"] as const);

/**
 * Gate order is load-bearing and the short-circuits are the point: an off-host
 * or wrong-architecture input is refused BEFORE any per-boundary work, because
 * a macOS verdict about a linux fact would be meaningless whatever the fact
 * says. Shape failures answer as PLATFORM_CONTRACT and host/architecture
 * failures as PLATFORM_MACOS, so a caller can tell "you called this wrong" from
 * "this does not hold here".
 */
export function observeMacosPlatform(input: unknown): PlatformObservation {
  const snapshot = snapshotExactRecord(input, INPUT_KEYS);
  if (snapshot === null) {
    return refuseEvery(null, "PLATFORM_FACT_MALFORMED", "PLATFORM_CONTRACT", "input is not a record of exactly host, asOf, maxFactAgeMs and facts");
  }
  const host = readHostIdentity(snapshot["host"]);
  if (host === null) {
    return refuseEvery(null, "PLATFORM_FACT_MALFORMED", "PLATFORM_CONTRACT", "input carries no usable host identity");
  }
  const asOf = snapshot["asOf"];
  const maxFactAgeMs = snapshot["maxFactAgeMs"];
  if (!isCanonicalUtcTimestamp(asOf) || !isMacosFactAgeMs(maxFactAgeMs)) {
    return refuseEvery(null, "PLATFORM_FACT_MALFORMED", "PLATFORM_CONTRACT", "asOf is not a canonical UTC instant or maxFactAgeMs is not a safe non-negative integer");
  }
  if (host.os !== PLATFORM_MACOS_OS) {
    return refuseEvery(host, "PLATFORM_HOST_MISMATCH", PLATFORM_MACOS_LAYER, "the declared host is not a darwin host, so no macOS fact can be proven about it");
  }
  if (!isSupportedArchitecture(host.arch)) {
    return refuseEvery(host, "PLATFORM_ARCH_UNSUPPORTED", PLATFORM_MACOS_LAYER, "this adapter does not classify facts on the declared architecture");
  }
  const facts = snapshotExactRecord(snapshot["facts"], PLATFORM_BOUNDARIES);
  if (facts === null) {
    return refuseEvery(host, "PLATFORM_COVERAGE_INCOMPLETE", PLATFORM_MACOS_LAYER, "facts does not name every platform boundary exactly once");
  }
  const context: MacosClassificationContext = { host, asOf, maxFactAgeMs };
  return observation(
    host,
    PLATFORM_BOUNDARIES.map((boundary) => boundaryVerdict(boundary, facts[boundary], context)),
  );
}

function boundaryVerdict(
  boundary: PlatformBoundary,
  envelope: unknown,
  context: MacosClassificationContext,
): PlatformBoundaryVerdict {
  const result = classifyMacosBoundary(boundary, envelope, context);
  if (isPlatformFailure(result)) {
    // Unreachable while `boundary` comes from the frozen vocabulary; fail
    // closed rather than assume, because the alternative is a thrown error.
    return Object.freeze({ boundary, truthClass: "UNKNOWN" as const, failure: result });
  }
  return result;
}

function refuseEvery(
  host: PlatformHostIdentity | null,
  code: PlatformErrorCode,
  layer: PlatformLayer,
  message: string,
): PlatformObservation {
  return observation(
    host,
    PLATFORM_BOUNDARIES.map((boundary) =>
      Object.freeze({
        boundary,
        truthClass: "UNKNOWN" as const,
        failure: platformFailure(code, layer, boundary, message),
      }),
    ),
  );
}

/**
 * Aggregate truth is AND across every boundary, and the length check is part of
 * the rule rather than a sanity assertion: `every` on a short list is vacuously
 * true, so a truncated verdict set would otherwise read as PROVEN.
 */
function observation(
  host: PlatformHostIdentity | null,
  verdicts: readonly PlatformBoundaryVerdict[],
): PlatformObservation {
  const complete =
    verdicts.length === PLATFORM_BOUNDARIES.length &&
    verdicts.every((verdict) => verdict.truthClass === "PROVEN");
  return Object.freeze({
    observationVersion: PLATFORM_OBSERVATION_VERSION,
    host,
    verdicts: Object.freeze([...verdicts]),
    truthClass: complete ? ("PROVEN" as const) : ("UNKNOWN" as const),
  });
}

function isSupportedArchitecture(value: string): value is MacosSupportedArchitecture {
  return (MACOS_SUPPORTED_ARCHITECTURES as readonly string[]).includes(value);
}
