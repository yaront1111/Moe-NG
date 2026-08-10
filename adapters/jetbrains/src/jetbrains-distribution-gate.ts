/**
 * The startup distribution compatibility gate.
 *
 * It does NOT verify a distribution. Signature, digest, provenance and
 * component-identity admission belong to the packager/startup authority
 * (verifyDistributionSet), which is not reachable from a workspace package and
 * must not be cloned here — a second implementation of an admission rule is the
 * fork this boundary exists to prevent. What remains is the question no other
 * layer can answer: whether the distribution on disk is one THIS adapter build
 * can talk to, given that an IDE plugin ships and updates independently of it.
 */

import {
  DISTRIBUTION_COMPONENT_KINDS,
  DISTRIBUTION_MANIFEST_VERSION,
  distributionRefusal,
} from "@moe/contracts";
import type {
  DistributionApiRange,
  DistributionComponentKind,
  DistributionManifest,
  DistributionRefusal,
} from "@moe/contracts";

/**
 * The component kinds a JetBrains session cannot run without. Drawn from the
 * frozen kind set, so a kind that stops existing is a compile error here.
 */
export const JETBRAINS_REQUIRED_COMPONENT_KINDS = Object.freeze(
  ["CONTROL_ROOM", "DAEMON"] as const,
) satisfies readonly DistributionComponentKind[];

/** What this adapter build was compiled against, supplied by the host. */
export interface JetBrainsDistributionExpectation {
  readonly apiCompatibilityRange: DistributionApiRange;
}

const MANIFEST_KEYS = [
  "aggregateDigest", "apiCompatibilityRange", "assets", "buildToolVersions", "builtInSkills",
  "componentId", "componentKind", "contractSchemaHash", "instructionTemplates", "manifestVersion",
  "signatureAlgorithm", "signingKeyId", "source",
] as const satisfies readonly (keyof DistributionManifest)[];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isVersionText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Every field is checked, not just the container. Two ranges that are both empty
 * compare EQUAL, so an unvalidated range admits any distribution at all — the
 * comparison would still run and still pass while deciding nothing.
 */
const isRange = (value: unknown): value is DistributionApiRange =>
  isRecord(value)
  && isVersionText(value["commandEnvelopeVersion"])
  && isVersionText(value["errorRegistryVersion"])
  && isVersionText(value["queryEnvelopeVersion"]);

const isManifestShaped = (value: unknown): value is DistributionManifest =>
  isRecord(value)
  && MANIFEST_KEYS.every((key) => Object.hasOwn(value, key))
  && isRange(value["apiCompatibilityRange"]);

const refuse = (
  reason: Parameters<typeof distributionRefusal>[0],
): DistributionRefusal => distributionRefusal(reason, "DISTRIBUTION_STARTUP");

const sameRange = (observed: DistributionApiRange, wanted: DistributionApiRange): boolean =>
  observed.commandEnvelopeVersion === wanted.commandEnvelopeVersion
  && observed.errorRegistryVersion === wanted.errorRegistryVersion
  && observed.queryEnvelopeVersion === wanted.queryEnvelopeVersion;

/**
 * Refuses an unusable distribution, or returns null to admit it. Ordered from
 * the most structural question to the most specific: a manifest that cannot be
 * read has no version to compare, and a kind outside the frozen set cannot be
 * required or duplicated. Every refusal names DISTRIBUTION_STARTUP, because the
 * packager is a different party and claiming its label would be a lie.
 */
export function admitDistribution(
  discovered: unknown,
  expectation: unknown,
): DistributionRefusal | null {
  // The host's own configuration crosses the same foreign boundary the evidence
  // does. An unusable expectation is refused outright rather than compared
  // against, which is the production verifier's stance for the same reason.
  if (!isRecord(expectation) || !isRange(expectation["apiCompatibilityRange"])) {
    return refuse("EXPECTATION_INVALID");
  }
  const wanted = expectation["apiCompatibilityRange"];
  if (!Array.isArray(discovered)) return refuse("MANIFEST_SCHEMA_INVALID");
  const manifests: readonly unknown[] = discovered;
  if (!manifests.every(isManifestShaped)) return refuse("MANIFEST_SCHEMA_INVALID");
  const admitted: readonly DistributionManifest[] = manifests;
  if (admitted.some((entry) => entry.manifestVersion !== DISTRIBUTION_MANIFEST_VERSION)) {
    return refuse("MANIFEST_VERSION_UNSUPPORTED");
  }
  if (!admitted.every((entry) => DISTRIBUTION_COMPONENT_KINDS.includes(entry.componentKind))) {
    return refuse("COMPONENT_KIND_MISMATCH");
  }
  for (const kind of JETBRAINS_REQUIRED_COMPONENT_KINDS) {
    const matching = admitted.filter((entry) => entry.componentKind === kind);
    if (matching.length > 1) return refuse("COMPONENT_DUPLICATE");
    const only = matching[0];
    if (only === undefined) return refuse("COMPONENT_SET_INCOMPLETE");
    if (!sameRange(only.apiCompatibilityRange, wanted)) {
      return refuse("API_RANGE_MISMATCH");
    }
  }
  return null;
}
