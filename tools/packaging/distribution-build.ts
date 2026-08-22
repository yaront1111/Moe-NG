import { createHash, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  DISTRIBUTION_COMPONENT_KINDS,
  DISTRIBUTION_CONTAINER_VERSION,
  DISTRIBUTION_MANIFEST_VERSION,
  DISTRIBUTION_SIGNATURE_ALGORITHM,
  canonicalContainerBytes,
  canonicalUnsignedManifestBytes,
  distributionRefusal,
  isCanonicalText,
  normalizeLogicalPath,
} from "../../packages/contracts/src/distribution/distribution-contract.js";
import type {
  DistributionApiRange,
  DistributionComponentKind,
  DistributionManifest,
  DistributionRefusal,
  DistributionSource,
} from "../../packages/contracts/src/distribution/distribution-contract.js";
import {
  decodeDistributionContainerBytes,
  parseDistributionManifest,
} from "../../packages/contracts/src/distribution/distribution-parser.js";
import { validateSkillManifestBytes } from "../../packages/skills/src/index.js";

export interface DistributionBuildAsset {
  readonly bytes: Uint8Array;
  readonly path: string;
}

export interface DistributionBuildTemplate {
  readonly bytes: Uint8Array;
  readonly templateId: string;
  readonly version: string;
}

/**
 * Exact-key build input. Runtime, user and project skills are NOT accepted here: they
 * are external provenance per the 2026-08-07 roadmap amendment, and an extra key is a
 * refusal rather than a payload this packager silently embeds or rewrites.
 */
export interface DistributionBuildInput {
  readonly apiCompatibilityRange: DistributionApiRange;
  readonly assets: readonly DistributionBuildAsset[];
  readonly buildToolVersions: Readonly<Record<string, string>>;
  readonly builtInSkillManifestBytes: readonly Uint8Array[];
  readonly componentId: string;
  readonly componentKind: DistributionComponentKind;
  readonly contractSchemaHash: string;
  readonly instructionTemplates: readonly DistributionBuildTemplate[];
  readonly signingKeyId: string;
  readonly source: DistributionSource;
}

export type DistributionBuildResult =
  | {
    readonly containerBytes: Uint8Array;
    readonly manifest: DistributionManifest;
    readonly manifestBytes: Uint8Array;
    readonly ok: true;
  }
  | DistributionRefusal;

const BUILD_KEYS = [
  "apiCompatibilityRange", "assets", "buildToolVersions", "builtInSkillManifestBytes",
  "componentId", "componentKind", "contractSchemaHash", "instructionTemplates",
  "signingKeyId", "source",
] as const;
const ASSET_KEYS = ["bytes", "path"] as const;
const TEMPLATE_KEYS = ["bytes", "templateId", "version"] as const;

const refuse = (reason: Parameters<typeof distributionRefusal>[0]): DistributionRefusal =>
  distributionRefusal(reason, "DISTRIBUTION_PACKAGER");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function isBuildInput(value: unknown): value is DistributionBuildInput {
  if (!exactKeys(value, BUILD_KEYS)) return false;
  const input = value as Readonly<Record<string, unknown>>;
  const assets = input["assets"];
  const templates = input["instructionTemplates"];
  const skills = input["builtInSkillManifestBytes"];
  if (!Array.isArray(assets) || !Array.isArray(templates) || !Array.isArray(skills)) return false;
  if (!assets.every((a) => exactKeys(a, ASSET_KEYS)
    && (a as DistributionBuildAsset).bytes instanceof Uint8Array)) return false;
  if (!templates.every((t) => exactKeys(t, TEMPLATE_KEYS)
    && (t as DistributionBuildTemplate).bytes instanceof Uint8Array
    && isCanonicalText((t as DistributionBuildTemplate).templateId))) return false;
  return skills.every((entry) => entry instanceof Uint8Array);
}

/**
 * One digest over the whole asset set. Built from the SORTED (path, digest) pairs with
 * explicit LF framing, so enumeration order cannot change the aggregate. The framing is
 * injective only because every path here has passed `normalizeLogicalPath`, which refuses
 * control characters: a path free of LF cannot spell another pair's framing, and a digest
 * is fixed-width hex. Without that charset rule, "a\n<digest>\nb" and the two-asset set
 * {a, b} would frame to identical bytes.
 */
function aggregateDigestHex(assets: ReadonlyArray<{ path: string; sha256: string }>): string {
  const hash = createHash("sha256");
  for (const asset of [...assets].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    hash.update(asset.path);
    hash.update("\n");
    hash.update(asset.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** Raw 32-byte Ed25519 public key as hex: the tail of the SPKI DER encoding. */
export function publicKeyHex(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

/**
 * Packages one component deterministically and signs it.
 *
 * No clock, no filesystem read, no environment access, no child process, and the private
 * key is used once and never logged, returned or embedded. The same bytes, key and
 * metadata therefore yield byte-identical output on any host.
 *
 * The container is only returned once it has been decoded back through the SAME bounded
 * decoder the startup gate uses. The encoder has no size limit of its own on purpose: the
 * admissible envelope is the decoder's (per-string and whole-body byte caps), and a second
 * copy of those numbers here could drift from it. An asset too large to carry therefore
 * refuses at build time as CONTAINER_BYTES_INVALID under the packager's layer, rather than
 * packaging and signing cleanly into a release that can never start.
 */
export function buildDistributionContainer(
  input: unknown, privateKey: KeyObject,
): DistributionBuildResult {
  if (!isBuildInput(input)) return refuse("BUILD_INPUT_INVALID");
  if (!DISTRIBUTION_COMPONENT_KINDS.includes(input.componentKind)) {
    return refuse("BUILD_INPUT_INVALID");
  }
  const assets: Array<{ byteLength: number; path: string; sha256: string }> = [];
  // Collected as pairs and materialised with Object.fromEntries, NOT by assigning into an
  // object literal: `payload["__proto__"] = ...` silently creates no own property, so a
  // component with such an asset would package a container missing a declared file.
  const payload: Array<readonly [string, string]> = [];
  const seenPaths = new Set<string>();
  for (const asset of input.assets) {
    const path = normalizeLogicalPath(asset.path);
    if (path === undefined) return refuse("ASSET_PATH_INVALID");
    if (seenPaths.has(path)) return refuse("ASSET_PATH_DUPLICATE");
    seenPaths.add(path);
    assets.push({ byteLength: asset.bytes.byteLength, path, sha256: sha256Hex(asset.bytes) });
    payload.push([path, Buffer.from(asset.bytes).toString("base64")]);
  }
  const builtInSkills: Array<{ digest: string; skillId: string; version: string }> = [];
  for (const bytes of input.builtInSkillManifestBytes) {
    const validated = validateSkillManifestBytes(bytes);
    if (!validated.ok) return refuse("SKILL_IDENTITY_INVALID");
    builtInSkills.push({
      digest: validated.identityDigest,
      skillId: validated.manifest.skillId,
      version: validated.manifest.version,
    });
  }
  const instructionTemplates = input.instructionTemplates.map((template) => ({
    digest: sha256Hex(template.bytes),
    templateId: template.templateId,
    version: template.version,
  }));
  const parsed = parseDistributionManifest({
    aggregateDigest: aggregateDigestHex(assets),
    apiCompatibilityRange: input.apiCompatibilityRange,
    assets,
    buildToolVersions: input.buildToolVersions,
    builtInSkills,
    componentId: input.componentId,
    componentKind: input.componentKind,
    contractSchemaHash: input.contractSchemaHash,
    instructionTemplates,
    manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
    signatureAlgorithm: DISTRIBUTION_SIGNATURE_ALGORITHM,
    signingKeyId: input.signingKeyId,
    source: input.source,
  }, "DISTRIBUTION_PACKAGER");
  if (!parsed.ok) return parsed;
  const manifestBytes = canonicalUnsignedManifestBytes(parsed.manifest);
  const signature = Buffer.from(sign(null, manifestBytes, privateKey)).toString("hex");
  const containerBytes = canonicalContainerBytes({
    assets: Object.fromEntries(payload),
    containerVersion: DISTRIBUTION_CONTAINER_VERSION,
    manifest: parsed.manifest,
    signature,
  });
  const admissible = decodeDistributionContainerBytes(containerBytes, "DISTRIBUTION_PACKAGER");
  if (!admissible.ok) return admissible;
  return Object.freeze({
    containerBytes, manifest: parsed.manifest, manifestBytes, ok: true as const,
  });
}
