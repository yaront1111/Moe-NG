import { decodeBoundedJsonBytes } from "../bounded-json.js";
import {
  hasExactKeys, isHex64, isPlainRecord, isSafeArray, isSafeCount,
} from "../runtime/runtime-guards.js";

import {
  BASE64_PATTERN,
  DISTRIBUTION_COMPONENT_KINDS,
  DISTRIBUTION_CONTAINER_VERSION,
  DISTRIBUTION_MANIFEST_VERSION,
  DISTRIBUTION_SIGNATURE_ALGORITHM,
  SIGNATURE_PATTERN,
  SKILL_ID_PATTERN,
  SOURCE_SHA_LENGTHS,
  distributionRefusal,
  isCanonicalText,
  normalizeLogicalPath,
} from "./distribution-contract.js";
import type {
  DistributionApiRange,
  DistributionComponentKind,
  DistributionContainerResult,
  DistributionManifestResult,
  DistributionRefusal,
  DistributionRefusalLayer,
  DistributionRefusalReason,
  DistributionSkillEntry,
  DistributionSource,
  DistributionTemplateEntry,
} from "./distribution-contract.js";

const MANIFEST_KEYS = [
  "aggregateDigest", "apiCompatibilityRange", "assets", "buildToolVersions", "builtInSkills",
  "componentId", "componentKind", "contractSchemaHash", "instructionTemplates",
  "manifestVersion", "signatureAlgorithm", "signingKeyId", "source",
] as const;
const RANGE_KEYS = [
  "commandEnvelopeVersion", "errorRegistryVersion", "queryEnvelopeVersion",
] as const;
const CONTAINER_KEYS = ["assets", "containerVersion", "manifest", "signature"] as const;

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, item]) => isCanonicalText(key) && isCanonicalText(item))) {
    return undefined;
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, string>>;
}

function parseRange(value: unknown): DistributionApiRange | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, RANGE_KEYS, [])) return undefined;
  if (!RANGE_KEYS.every((key) => isCanonicalText(value[key]))) return undefined;
  return Object.freeze({
    commandEnvelopeVersion: value["commandEnvelopeVersion"] as string,
    errorRegistryVersion: value["errorRegistryVersion"] as string,
    queryEnvelopeVersion: value["queryEnvelopeVersion"] as string,
  });
}

/** The digest length is chosen BY the declared object format, never guessed from length. */
function parseSource(value: unknown): DistributionSource | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["objectFormat", "sourceSha"], [])) {
    return undefined;
  }
  const format = value["objectFormat"];
  if (format !== "sha1" && format !== "sha256") return undefined;
  const sha = value["sourceSha"];
  const width = SOURCE_SHA_LENGTHS[format];
  if (typeof sha !== "string" || !new RegExp(`^[0-9a-f]{${width}}$`, "u").test(sha)) {
    return undefined;
  }
  return Object.freeze({ objectFormat: format, sourceSha: sha });
}

/** Assets sorted by path, so enumeration order can never reach the signed bytes. */
function parseAssets(value: unknown): readonly unknown[] | DistributionRefusalReason {
  if (!isSafeArray(value)) return "MANIFEST_SCHEMA_INVALID";
  if (value.length === 0) return "ASSET_SET_EMPTY";
  const assets: Array<Readonly<Record<string, unknown>>> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ["byteLength", "path", "sha256"], [])) {
      return "MANIFEST_SCHEMA_INVALID";
    }
    const path = normalizeLogicalPath(entry["path"]);
    if (path === undefined) return "ASSET_PATH_INVALID";
    if (!isHex64(entry["sha256"])) return "ASSET_DIGEST_INVALID";
    if (!isSafeCount(entry["byteLength"])) return "MANIFEST_SCHEMA_INVALID";
    if (seen.has(path.toLowerCase())) return "ASSET_PATH_DUPLICATE";
    seen.add(path.toLowerCase());
    assets.push(Object.freeze({ byteLength: entry["byteLength"], path, sha256: entry["sha256"] }));
  }
  return Object.freeze(assets.sort((left, right) =>
    ((left["path"] as string) < (right["path"] as string) ? -1 : 1)));
}

/** One routine for both identity lists; `idKey` selects the vocabulary and the reasons. */
function parseIdentities(
  value: unknown,
  idKey: "skillId" | "templateId",
  invalid: DistributionRefusalReason,
  duplicate: DistributionRefusalReason,
): readonly unknown[] | DistributionRefusalReason {
  if (!isSafeArray(value)) return "MANIFEST_SCHEMA_INVALID";
  const entries: Array<Readonly<Record<string, string>>> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ["digest", idKey, "version"], [])) {
      return "MANIFEST_SCHEMA_INVALID";
    }
    const id = entry[idKey];
    if (!isCanonicalText(id) || !isCanonicalText(entry["version"]) || !isHex64(entry["digest"])) {
      return invalid;
    }
    if (idKey === "skillId" && !SKILL_ID_PATTERN.test(id)) return invalid;
    if (seen.has(id)) return duplicate;
    seen.add(id);
    entries.push(Object.freeze({
      digest: entry["digest"], [idKey]: id, version: entry["version"],
    }));
  }
  return Object.freeze(entries.sort((left, right) =>
    ((left[idKey] ?? "") < (right[idKey] ?? "") ? -1 : 1)));
}

function isReason(value: unknown): value is DistributionRefusalReason {
  return typeof value === "string";
}

/**
 * Fails closed on unknown input, returning a deeply frozen normalized manifest.
 *
 * `refusedBy` is the CALLER's layer: the same malformed bytes are a packager fault at
 * build time and a startup fault at admission, and a hardcoded layer would lie about one
 * of them.
 */
export function parseDistributionManifest(
  value: unknown, refusedBy: DistributionRefusalLayer,
): DistributionManifestResult {
  const no = (reason: DistributionRefusalReason): DistributionRefusal =>
    distributionRefusal(reason, refusedBy);
  if (!isPlainRecord(value) || !hasExactKeys(value, MANIFEST_KEYS, [])) {
    return no("MANIFEST_SCHEMA_INVALID");
  }
  if (value["manifestVersion"] !== DISTRIBUTION_MANIFEST_VERSION) {
    return no("MANIFEST_VERSION_UNSUPPORTED");
  }
  if (value["signatureAlgorithm"] !== DISTRIBUTION_SIGNATURE_ALGORITHM) {
    return no("SIGNATURE_ALGORITHM_UNSUPPORTED");
  }
  const kind = value["componentKind"] as DistributionComponentKind;
  if (!DISTRIBUTION_COMPONENT_KINDS.includes(kind)) return no("MANIFEST_SCHEMA_INVALID");
  if (!isCanonicalText(value["componentId"]) || !isCanonicalText(value["signingKeyId"])) {
    return no("MANIFEST_SCHEMA_INVALID");
  }
  if (!isHex64(value["contractSchemaHash"]) || !isHex64(value["aggregateDigest"])) {
    return no("MANIFEST_SCHEMA_INVALID");
  }
  const source = parseSource(value["source"]);
  if (source === undefined) return no("SOURCE_PROVENANCE_INVALID");
  const apiCompatibilityRange = parseRange(value["apiCompatibilityRange"]);
  const buildToolVersions = stringRecord(value["buildToolVersions"]);
  if (apiCompatibilityRange === undefined || buildToolVersions === undefined) {
    return no("MANIFEST_SCHEMA_INVALID");
  }
  const assets = parseAssets(value["assets"]);
  if (isReason(assets)) return no(assets);
  const skills = parseIdentities(
    value["builtInSkills"], "skillId", "SKILL_IDENTITY_INVALID", "SKILL_IDENTITY_DUPLICATE",
  );
  if (isReason(skills)) return no(skills);
  const templates = parseIdentities(
    value["instructionTemplates"], "templateId",
    "TEMPLATE_IDENTITY_INVALID", "TEMPLATE_IDENTITY_DUPLICATE",
  );
  if (isReason(templates)) return no(templates);
  return Object.freeze({
    manifest: Object.freeze({
      aggregateDigest: value["aggregateDigest"] as string,
      apiCompatibilityRange,
      assets: assets as readonly { byteLength: number; path: string; sha256: string }[],
      buildToolVersions,
      builtInSkills: skills as readonly DistributionSkillEntry[],
      componentId: value["componentId"],
      componentKind: kind,
      contractSchemaHash: value["contractSchemaHash"] as string,
      instructionTemplates: templates as readonly DistributionTemplateEntry[],
      manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
      signatureAlgorithm: DISTRIBUTION_SIGNATURE_ALGORITHM,
      signingKeyId: value["signingKeyId"],
      source,
    }),
    ok: true as const,
  });
}

/**
 * Admits an observed container. The carried asset key set must EQUAL the manifest's
 * declared paths: a container carrying extra bytes nobody signed for is as wrong as one
 * missing an asset, so both directions refuse.
 */
export function parseDistributionContainer(
  value: unknown, refusedBy: DistributionRefusalLayer,
): DistributionContainerResult {
  const no = (reason: DistributionRefusalReason): DistributionRefusal =>
    distributionRefusal(reason, refusedBy);
  if (!isPlainRecord(value) || !hasExactKeys(value, CONTAINER_KEYS, [])) {
    return no("CONTAINER_SCHEMA_INVALID");
  }
  if (value["containerVersion"] !== DISTRIBUTION_CONTAINER_VERSION) {
    return no("CONTAINER_VERSION_UNSUPPORTED");
  }
  const signature = value["signature"];
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    return no("SIGNATURE_INVALID");
  }
  const parsed = parseDistributionManifest(value["manifest"], refusedBy);
  if (!parsed.ok) return parsed;
  const payload = value["assets"];
  if (!isPlainRecord(payload)) return no("CONTAINER_SCHEMA_INVALID");
  const declared = parsed.manifest.assets.map((asset) => asset.path);
  const carried = Object.keys(payload).sort();
  if (carried.length !== declared.length || carried.some((path, at) => path !== declared[at])) {
    return no("ASSET_SET_MISMATCH");
  }
  const encoded = carried.map((path) => [path, payload[path]] as const);
  if (!encoded.every(([, body]) => typeof body === "string" && BASE64_PATTERN.test(body))) {
    return no("CONTAINER_SCHEMA_INVALID");
  }
  return Object.freeze({
    container: Object.freeze({
      assets: Object.freeze(Object.fromEntries(encoded)) as Readonly<Record<string, string>>,
      containerVersion: DISTRIBUTION_CONTAINER_VERSION,
      manifest: parsed.manifest,
      signature,
    }),
    ok: true as const,
  });
}

export function decodeDistributionContainerBytes(
  bytes: Uint8Array, refusedBy: DistributionRefusalLayer,
): DistributionContainerResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return distributionRefusal("CONTAINER_BYTES_INVALID", refusedBy);
  return parseDistributionContainer(decoded.value, refusedBy);
}
