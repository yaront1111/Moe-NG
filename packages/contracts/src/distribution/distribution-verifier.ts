import { hasExactKeys, isPlainRecord, isSafeArray } from "../runtime/runtime-guards.js";

import {
  DISTRIBUTION_COMPONENT_KINDS,
  canonicalUnsignedManifestBytes,
  distributionRefusal,
  isCanonicalText,
} from "./distribution-contract.js";
import type {
  DistributionApiRange,
  DistributionComponentKind,
  DistributionContainer,
  DistributionManifest,
  DistributionRefusal,
  DistributionRefusalReason,
  DistributionSkillEntry,
  DistributionSource,
  DistributionTemplateEntry,
} from "./distribution-contract.js";

/**
 * Signature verification is a PORT, so this kernel stays pure and dependency-free: it
 * never chooses a crypto implementation, holds a key, or reads the environment.
 */
export type DistributionSignaturePort = (input: {
  readonly keyId: string;
  readonly message: Uint8Array;
  readonly signature: string;
}) => boolean;

/**
 * What the host TRUSTS, supplied from outside the observed set.
 *
 * Nothing here may be derived from the containers being checked. A distribution whose
 * components all agree with each other is not thereby correct — an entirely stale build
 * is perfectly self-consistent — so agreement is never evidence and only these values
 * decide admission.
 */
export interface StartupDistributionExpectation {
  readonly apiCompatibilityRange: DistributionApiRange;
  readonly buildToolVersions: Readonly<Record<string, string>>;
  readonly builtInSkills: readonly DistributionSkillEntry[];
  readonly componentKinds: Readonly<Record<string, DistributionComponentKind>>;
  readonly contractSchemaHash: string;
  readonly instructionTemplates: readonly DistributionTemplateEntry[];
  readonly source: DistributionSource;
  readonly trustedKeyIds: readonly string[];
}

export interface ObservedDistributionComponent {
  readonly container: DistributionContainer;
  readonly recomputedAggregateDigest: string;
  readonly recomputedAssetDigests: Readonly<Record<string, string>>;
}

export interface DistributionAdmission {
  readonly componentIds: readonly string[];
  readonly ok: true;
  readonly sourceSha: string;
}

export type DistributionAdmissionResult = DistributionAdmission | DistributionRefusal;

const EXPECTATION_KEYS = [
  "apiCompatibilityRange", "buildToolVersions", "builtInSkills", "componentKinds",
  "contractSchemaHash", "instructionTemplates", "source", "trustedKeyIds",
] as const;

const no = (reason: DistributionRefusalReason): DistributionRefusal =>
  distributionRefusal(reason, "DISTRIBUTION_STARTUP");

/**
 * A fail-closed sanity gate, not a hostile-input parser: the expectation is the host's
 * own trusted configuration. An empty key list or empty component set would make every
 * later comparison vacuously satisfiable, so both are refused outright.
 */
function isUsableExpectation(value: unknown): value is StartupDistributionExpectation {
  if (!isPlainRecord(value) || !hasExactKeys(value, EXPECTATION_KEYS, [])) return false;
  const keys = value["trustedKeyIds"];
  if (!isSafeArray(keys) || keys.length === 0 || !keys.every(isCanonicalText)) return false;
  const kinds = value["componentKinds"];
  if (!isPlainRecord(kinds) || Object.keys(kinds).length === 0) return false;
  if (!Object.values(kinds).every(
    (kind) => DISTRIBUTION_COMPONENT_KINDS.includes(kind as DistributionComponentKind),
  )) return false;
  if (!isPlainRecord(value["apiCompatibilityRange"])) return false;
  if (!isPlainRecord(value["buildToolVersions"]) || !isPlainRecord(value["source"])) return false;
  if (!isCanonicalText(value["contractSchemaHash"])) return false;
  return isSafeArray(value["builtInSkills"]) && isSafeArray(value["instructionTemplates"]);
}

function sameStringRecord(
  observed: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const left = Object.keys(observed).sort();
  const right = Object.keys(expected).sort();
  if (left.length !== right.length || left.some((key, at) => key !== right[at])) return false;
  return left.every((key) => observed[key] === expected[key]);
}

/**
 * Compares identity triples by value after sorting, so declaration order is irrelevant.
 * The projector spells out every compared field: a structural comparison would silently
 * stop covering a field the day one is added to the entry type.
 */
function sameIdentities<T>(
  observed: readonly T[], expected: readonly T[], identity: (entry: T) => string,
): boolean {
  if (observed.length !== expected.length) return false;
  const left = observed.map(identity).sort();
  const right = expected.map(identity).sort();
  return left.every((item, at) => item === right[at]);
}

const skillIdentity = (entry: DistributionSkillEntry): string =>
  [entry.skillId, entry.version, entry.digest].join(" ");
const templateIdentity = (entry: DistributionTemplateEntry): string =>
  [entry.templateId, entry.version, entry.digest].join(" ");

/** Provenance the manifest asserts, against provenance the host trusts. */
function provenanceRefusal(
  manifest: DistributionManifest, expected: StartupDistributionExpectation,
): DistributionRefusalReason | undefined {
  if (manifest.source.sourceSha !== expected.source.sourceSha
    || manifest.source.objectFormat !== expected.source.objectFormat) {
    return "SOURCE_SHA_MISMATCH";
  }
  if (manifest.contractSchemaHash !== expected.contractSchemaHash) return "SCHEMA_HASH_MISMATCH";
  const range = manifest.apiCompatibilityRange;
  const wanted = expected.apiCompatibilityRange;
  if (range.commandEnvelopeVersion !== wanted.commandEnvelopeVersion
    || range.errorRegistryVersion !== wanted.errorRegistryVersion
    || range.queryEnvelopeVersion !== wanted.queryEnvelopeVersion) {
    return "API_RANGE_MISMATCH";
  }
  if (!sameStringRecord(manifest.buildToolVersions, expected.buildToolVersions)) {
    return "BUILD_TOOL_MISMATCH";
  }
  if (!sameIdentities(manifest.builtInSkills, expected.builtInSkills, skillIdentity)) {
    return "BUILT_IN_SKILL_DRIFT";
  }
  if (!sameIdentities(
    manifest.instructionTemplates, expected.instructionTemplates, templateIdentity,
  )) {
    return "INSTRUCTION_TEMPLATE_DRIFT";
  }
  return undefined;
}

/** Bytes the host recomputed, against digests the signature covers. */
function digestRefusal(
  component: ObservedDistributionComponent,
): DistributionRefusalReason | undefined {
  const { manifest } = component.container;
  const declared = manifest.assets.map((asset) => asset.path);
  const recomputed = Object.keys(component.recomputedAssetDigests).sort();
  if (recomputed.length !== declared.length
    || recomputed.some((path, at) => path !== declared[at])) {
    return "ASSET_SET_MISMATCH";
  }
  if (manifest.assets.some(
    (asset) => component.recomputedAssetDigests[asset.path] !== asset.sha256,
  )) {
    return "ASSET_DIGEST_MISMATCH";
  }
  if (component.recomputedAggregateDigest !== manifest.aggregateDigest) {
    return "AGGREGATE_DIGEST_MISMATCH";
  }
  return undefined;
}

function componentSetRefusal(
  observedIds: readonly string[], expectedIds: readonly string[],
): DistributionRefusalReason | undefined {
  if (new Set(observedIds).size !== observedIds.length) return "COMPONENT_DUPLICATE";
  if (expectedIds.some((id) => !observedIds.includes(id))) return "COMPONENT_SET_INCOMPLETE";
  if (observedIds.some((id) => !expectedIds.includes(id))) return "COMPONENT_SET_UNEXPECTED";
  return undefined;
}

/**
 * Admits a whole distribution or refuses it. There is no partial admission and no launch
 * affordance on the result: callers get identifiers, never a capability.
 */
export function verifyDistributionSet(
  observed: readonly ObservedDistributionComponent[],
  expectation: unknown,
  verifySignature: DistributionSignaturePort,
): DistributionAdmissionResult {
  if (!isUsableExpectation(expectation)) return no("EXPECTATION_INVALID");
  if (!isSafeArray(observed)) return no("EXPECTATION_INVALID");
  const observedIds = observed.map((entry) => entry.container.manifest.componentId);
  const expectedIds = Object.keys(expectation.componentKinds).sort();
  const setRefusal = componentSetRefusal(observedIds, expectedIds);
  if (setRefusal !== undefined) return no(setRefusal);
  for (const component of observed) {
    const { manifest, signature } = component.container;
    if (expectation.componentKinds[manifest.componentId] !== manifest.componentKind) {
      return no("COMPONENT_KIND_MISMATCH");
    }
    if (!expectation.trustedKeyIds.includes(manifest.signingKeyId)) {
      return no("SIGNING_KEY_UNTRUSTED");
    }
    let verified = false;
    try {
      verified = verifySignature({
        keyId: manifest.signingKeyId,
        message: canonicalUnsignedManifestBytes(manifest),
        signature,
      });
    } catch {
      return no("SIGNATURE_PORT_FAILED");
    }
    if (!verified) return no("SIGNATURE_INVALID");
    const provenance = provenanceRefusal(manifest, expectation);
    if (provenance !== undefined) return no(provenance);
    const digests = digestRefusal(component);
    if (digests !== undefined) return no(digests);
  }
  const first = observed[0];
  if (first === undefined) return no("COMPONENT_SET_INCOMPLETE");
  return Object.freeze({
    componentIds: Object.freeze([...observedIds].sort()),
    ok: true as const,
    sourceSha: first.container.manifest.source.sourceSha,
  });
}
