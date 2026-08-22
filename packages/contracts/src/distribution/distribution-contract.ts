import { isNonEmptyString } from "../runtime/runtime-guards.js";
import type { GitObjectFormat } from "../phase0-evidence-contract.js";

export const DISTRIBUTION_MANIFEST_VERSION = "moe-distribution-manifest/1" as const;
export const DISTRIBUTION_CONTAINER_VERSION = "moe-distribution-container/1" as const;
export const DISTRIBUTION_SIGNATURE_ALGORITHM = "ed25519" as const;

/** Closed set. IDE_ADAPTER is declared here before any IDE adapter is built. */
export const DISTRIBUTION_COMPONENT_KINDS = Object.freeze([
  "CONTROL_ROOM", "DAEMON", "IDE_ADAPTER", "MCP_BRIDGE", "PROVIDER_ADAPTER",
] as const);

export const DISTRIBUTION_REFUSAL_LAYERS = Object.freeze([
  "DISTRIBUTION_PACKAGER", "DISTRIBUTION_STARTUP",
] as const);

export const DISTRIBUTION_REFUSAL_REASONS = Object.freeze([
  "AGGREGATE_DIGEST_MISMATCH", "API_RANGE_MISMATCH", "ASSET_DIGEST_INVALID",
  "ASSET_DIGEST_MISMATCH", "ASSET_PATH_DUPLICATE", "ASSET_PATH_INVALID", "ASSET_SET_EMPTY",
  "ASSET_SET_MISMATCH", "BUILD_INPUT_INVALID", "BUILD_TOOL_MISMATCH", "BUILT_IN_SKILL_DRIFT",
  "COMPONENT_DUPLICATE", "COMPONENT_KIND_MISMATCH", "COMPONENT_SET_INCOMPLETE",
  "COMPONENT_SET_UNEXPECTED", "CONTAINER_BYTES_INVALID", "CONTAINER_SCHEMA_INVALID",
  "CONTAINER_VERSION_UNSUPPORTED", "EXPECTATION_INVALID", "INSTRUCTION_TEMPLATE_DRIFT",
  "LAUNCH_PORT_FAILED", "MANIFEST_SCHEMA_INVALID", "MANIFEST_VERSION_UNSUPPORTED",
  "SCHEMA_HASH_MISMATCH", "SIGNATURE_ALGORITHM_UNSUPPORTED", "SIGNATURE_INVALID",
  "SIGNATURE_PORT_FAILED", "SIGNING_KEY_UNTRUSTED", "SKILL_IDENTITY_DUPLICATE",
  "SKILL_IDENTITY_INVALID", "SOURCE_PROVENANCE_INVALID", "SOURCE_SHA_MISMATCH",
  "TEMPLATE_IDENTITY_DUPLICATE", "TEMPLATE_IDENTITY_INVALID",
] as const);

export type DistributionComponentKind = (typeof DISTRIBUTION_COMPONENT_KINDS)[number];
export type DistributionRefusalLayer = (typeof DISTRIBUTION_REFUSAL_LAYERS)[number];
export type DistributionRefusalReason = (typeof DISTRIBUTION_REFUSAL_REASONS)[number];

export interface DistributionRefusal {
  readonly code: "DISTRIBUTION_MISMATCH";
  readonly ok: false;
  readonly reason: DistributionRefusalReason;
  readonly refusedBy: DistributionRefusalLayer;
}

export interface DistributionApiRange {
  readonly commandEnvelopeVersion: string;
  readonly errorRegistryVersion: string;
  readonly queryEnvelopeVersion: string;
}

export interface DistributionSource {
  readonly objectFormat: GitObjectFormat;
  readonly sourceSha: string;
}

export interface DistributionAsset {
  readonly byteLength: number;
  readonly path: string;
  readonly sha256: string;
}

export interface DistributionSkillEntry {
  readonly digest: string;
  readonly skillId: string;
  readonly version: string;
}

export interface DistributionTemplateEntry {
  readonly digest: string;
  readonly templateId: string;
  readonly version: string;
}

/**
 * Everything a signature must cover. The signature itself is deliberately NOT a field:
 * it sits beside the manifest on the container, so "excluded from the bytes it signs" is
 * a structural property rather than a field the codec has to remember to skip.
 */
export interface DistributionManifest {
  readonly aggregateDigest: string;
  readonly apiCompatibilityRange: DistributionApiRange;
  readonly assets: readonly DistributionAsset[];
  readonly buildToolVersions: Readonly<Record<string, string>>;
  readonly builtInSkills: readonly DistributionSkillEntry[];
  readonly componentId: string;
  readonly componentKind: DistributionComponentKind;
  readonly contractSchemaHash: string;
  readonly instructionTemplates: readonly DistributionTemplateEntry[];
  readonly manifestVersion: typeof DISTRIBUTION_MANIFEST_VERSION;
  readonly signatureAlgorithm: typeof DISTRIBUTION_SIGNATURE_ALGORITHM;
  readonly signingKeyId: string;
  readonly source: DistributionSource;
}

export interface DistributionContainer {
  readonly assets: Readonly<Record<string, string>>;
  readonly containerVersion: typeof DISTRIBUTION_CONTAINER_VERSION;
  readonly manifest: DistributionManifest;
  readonly signature: string;
}

export type DistributionManifestResult =
  | { readonly manifest: DistributionManifest; readonly ok: true }
  | DistributionRefusal;

export type DistributionContainerResult =
  | { readonly container: DistributionContainer; readonly ok: true }
  | DistributionRefusal;

export function distributionRefusal(
  reason: DistributionRefusalReason,
  refusedBy: DistributionRefusalLayer,
): DistributionRefusal {
  return Object.freeze({
    code: "DISTRIBUTION_MISMATCH" as const, ok: false as const, reason, refusedBy,
  });
}

export const MAX_LOGICAL_PATH_CHARS = 320;
/**
 * C0 controls and DEL are never part of a logical path. The aggregate digest frames each
 * (path, digest) pair with LF, so a path that may carry LF could spell another pair's
 * framing and two different asset sets would share one aggregate.
 */
export const LOGICAL_PATH_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
export const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/u;
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
export const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
export const SOURCE_SHA_LENGTHS: Readonly<Record<GitObjectFormat, number>> = Object.freeze({
  sha1: 40, sha256: 64,
});

/** Text a signature can rely on: well-formed, NFC, non-empty. */
export function isCanonicalText(value: unknown): value is string {
  return isNonEmptyString(value) && value.isWellFormed() && value.normalize("NFC") === value;
}

/**
 * A safe relative logical path, or `undefined`. Only a single leading `./` is stripped;
 * every other traversal, root, drive or device spelling is refused outright, so two hosts
 * cannot canonicalize the same tree into different bytes. Control characters are refused
 * as well: the aggregate digest's LF framing is injective only over paths that cannot
 * contain the framing byte.
 */
export function normalizeLogicalPath(value: unknown): string | undefined {
  if (!isCanonicalText(value) || value.length > MAX_LOGICAL_PATH_CHARS) return undefined;
  const path = value.startsWith("./") ? value.slice(2) : value;
  if (path.length === 0 || path.includes("\\") || path.includes(":")) return undefined;
  if (LOGICAL_PATH_CONTROL_PATTERN.test(path)) return undefined;
  if (path.startsWith("/")) return undefined;
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") return undefined;
    if (segment.endsWith(".") || segment.endsWith(" ")) return undefined;
  }
  return path;
}

/** Sorted-key JSON with no whitespace: one tree, one byte string, on every host. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const body = Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${body.join(",")}}`;
}

/** The bytes a signature covers: everything in the manifest, and only the manifest. */
export function canonicalUnsignedManifestBytes(manifest: DistributionManifest): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest));
}

export function canonicalContainerBytes(container: DistributionContainer): Uint8Array {
  return new TextEncoder().encode(canonicalJson(container));
}
