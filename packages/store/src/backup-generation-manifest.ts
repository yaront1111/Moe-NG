import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

import {
  BACKUP_GENERATION_MANIFEST_VERSION,
  BACKUP_OBJECT_CATEGORIES,
  type BackupGenerationContainer,
  type BackupGenerationManifest,
  type BackupGenerationTrust,
  type BackupGenerationVerifyResult,
  type BackupObjectDescriptor,
  isCanonicalDecimal,
  isLowercaseHex,
  isSafeLogicalPath,
  isWellFormedIdentifier,
  refuseBackupGeneration,
} from "./backup-generation-contracts.js";

const SHA256_HEX_LENGTH = 64;

/**
 * Deterministic byte projection of a manifest, excluding ONLY `generationDigest`
 * — the field these bytes produce. Keys are emitted in sorted order at every
 * level, so two manifests that differ solely in property insertion order or in
 * caller-supplied descriptor order produce identical bytes.
 */
export function canonicalManifestBytes(manifest: BackupGenerationManifest): Uint8Array {
  const objects = [...manifest.objects]
    .sort((left, right) => (left.logicalId < right.logicalId ? -1 : 1))
    .map((entry) => ({
      byteLength: entry.byteLength,
      category: entry.category,
      digest: entry.digest,
      logicalId: entry.logicalId,
      logicalPath: entry.logicalPath,
      sourceGenerationDigest: entry.sourceGenerationDigest,
    }));
  const keyChain = [...manifest.keyChain]
    .sort((left, right) => (left.keyId < right.keyId ? -1 : 1))
    .map((entry) => ({ keyId: entry.keyId, role: entry.role }));
  return new TextEncoder().encode(
    JSON.stringify({
      cursor: manifest.cursor,
      databaseByteLength: manifest.databaseByteLength,
      databaseDigest: manifest.databaseDigest,
      keyChain,
      objects,
      projectId: manifest.projectId,
      sourceGenerationDigest: manifest.sourceGenerationDigest,
      version: manifest.version,
    }),
  );
}

export function computeGenerationDigest(manifest: BackupGenerationManifest): string {
  return createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex");
}

function isDescriptorShaped(value: unknown): value is BackupObjectDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    isCanonicalDecimal(entry.byteLength) &&
    typeof entry.category === "string" &&
    (BACKUP_OBJECT_CATEGORIES as readonly string[]).includes(entry.category) &&
    isLowercaseHex(entry.digest, SHA256_HEX_LENGTH) &&
    isWellFormedIdentifier(entry.logicalId) &&
    isSafeLogicalPath(entry.logicalPath) &&
    isLowercaseHex(entry.sourceGenerationDigest, SHA256_HEX_LENGTH)
  );
}

/**
 * Structural validation of a closure that has already been shape-checked per
 * descriptor. Returns a reason rather than throwing so every caller funnels
 * into the same frozen refusal tuple.
 */
export function inspectClosure(
  objects: readonly BackupObjectDescriptor[],
  sourceGenerationDigest: string,
):
  | "CATEGORY_INCOMPLETE"
  | "MIXED_SOURCE_GENERATION"
  | "OBJECT_DUPLICATE_IDENTITY"
  | null {
  const identities = new Set<string>();
  const destinations = new Set<string>();
  for (const entry of objects) {
    if (entry.sourceGenerationDigest !== sourceGenerationDigest) return "MIXED_SOURCE_GENERATION";
    // Case-folded, so a case-insensitive filesystem cannot collapse two
    // "distinct" destinations into one file after the check has passed.
    const destination = entry.logicalPath.toLowerCase();
    if (identities.has(entry.logicalId) || destinations.has(destination)) {
      return "OBJECT_DUPLICATE_IDENTITY";
    }
    identities.add(entry.logicalId);
    destinations.add(destination);
  }
  const present = new Set(objects.map((entry) => entry.category));
  for (const category of BACKUP_OBJECT_CATEGORIES) {
    if (!present.has(category)) return "CATEGORY_INCOMPLETE";
  }
  return null;
}

function isManifestShaped(value: unknown): value is BackupGenerationManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== BACKUP_GENERATION_MANIFEST_VERSION) return false;
  if (!isCanonicalDecimal(manifest.cursor)) return false;
  if (!isCanonicalDecimal(manifest.databaseByteLength)) return false;
  if (!isLowercaseHex(manifest.databaseDigest, SHA256_HEX_LENGTH)) return false;
  if (!isLowercaseHex(manifest.generationDigest, SHA256_HEX_LENGTH)) return false;
  if (!isLowercaseHex(manifest.sourceGenerationDigest, SHA256_HEX_LENGTH)) return false;
  if (!isWellFormedIdentifier(manifest.projectId)) return false;
  if (!Array.isArray(manifest.objects) || manifest.objects.length === 0) return false;
  if (!Array.isArray(manifest.keyChain) || manifest.keyChain.length === 0) return false;
  // `every` on a sparse array skips holes, so length is compared against the
  // count of own indices: a sparse array must not read as a dense one.
  if (Object.keys(manifest.objects).length !== manifest.objects.length) return false;
  if (!manifest.objects.every(isDescriptorShaped)) return false;
  return manifest.keyChain.every(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      isWellFormedIdentifier((entry as Record<string, unknown>).keyId) &&
      ((entry as Record<string, unknown>).role === "LEAF" ||
        (entry as Record<string, unknown>).role === "ROOT"),
  );
}

function isContainerShaped(value: unknown): value is BackupGenerationContainer {
  if (typeof value !== "object" || value === null) return false;
  const container = value as Record<string, unknown>;
  return (
    isWellFormedIdentifier(container.keyId) &&
    typeof container.signature === "string" &&
    /^[0-9a-f]+$/.test(container.signature) &&
    typeof container.publicKeySpkiDer === "string" &&
    isManifestShaped(container.manifest)
  );
}

export interface VerifyBackupGenerationOptions {
  /**
   * Logical paths actually present in the generation directory. Supplied by the
   * caller so this module stays pure and testable without a filesystem; the
   * coordinator passes a real listing. Omitted means "inventory not observed",
   * which is not the same as "inventory verified".
   */
  readonly observedLogicalPaths?: readonly string[];
}

/**
 * The production verifier. Order is deliberate and fails closed at each stage:
 * shape, then recomputed digest, then observed inventory, then external key
 * anchoring, and only then the signature. Anchoring precedes verification so a
 * replacement key travelling inside the container can never authorize itself.
 */
export function verifyBackupGeneration(
  container: unknown,
  trust: unknown,
  options: VerifyBackupGenerationOptions = {},
): BackupGenerationVerifyResult {
  if (!isContainerShaped(container)) return refuseBackupGeneration("REQUEST_SHAPE_INVALID");
  if (
    typeof trust !== "object" ||
    trust === null ||
    !Array.isArray((trust as BackupGenerationTrust).anchoredKeys)
  ) {
    return refuseBackupGeneration("REQUEST_SHAPE_INVALID");
  }
  const manifest = container.manifest;

  const closureFault = inspectClosure(manifest.objects, manifest.sourceGenerationDigest);
  if (closureFault !== null) return refuseBackupGeneration(closureFault);

  if (computeGenerationDigest(manifest) !== manifest.generationDigest) {
    return refuseBackupGeneration("MANIFEST_DIGEST_MISMATCH");
  }

  const observed = options.observedLogicalPaths;
  if (observed !== undefined) {
    const declared = new Set(manifest.objects.map((entry) => entry.logicalPath));
    if (observed.length !== declared.size) return refuseBackupGeneration("INVENTORY_MISMATCH");
    for (const path of observed) {
      if (!declared.has(path)) return refuseBackupGeneration("INVENTORY_MISMATCH");
    }
  }

  const leaf = manifest.keyChain.find((entry) => entry.role === "LEAF");
  if (leaf === undefined || leaf.keyId !== container.keyId) {
    return refuseBackupGeneration("KEY_CHAIN_UNTRUSTED");
  }
  const anchored = (trust as BackupGenerationTrust).anchoredKeys.find(
    (entry) => entry?.keyId === leaf.keyId,
  );
  if (anchored === undefined || typeof anchored.publicKeySpkiDer !== "string") {
    return refuseBackupGeneration("KEY_CHAIN_UNTRUSTED");
  }

  try {
    // Verified against the ANCHORED key bytes, never the carried ones: a
    // container that swapped in its own key must fail here, not pass.
    const key = createPublicKey({
      format: "der",
      key: Buffer.from(anchored.publicKeySpkiDer, "hex"),
      type: "spki",
    });
    const signed = edVerify(
      null,
      canonicalManifestBytes(manifest),
      key,
      Buffer.from(container.signature, "hex"),
    );
    if (!signed) return refuseBackupGeneration("MANIFEST_SIGNATURE_INVALID");
  } catch {
    // A malformed key or signature is indistinguishable from a forged one here,
    // and both are non-authoritative.
    return refuseBackupGeneration("MANIFEST_SIGNATURE_INVALID");
  }

  return Object.freeze({ manifest, ok: true, restorable: true } as const);
}
