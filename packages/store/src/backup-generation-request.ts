import type { KeyObject } from "node:crypto";
import { resolve, sep } from "node:path";

import {
  type BackupGenerationRefused,
  type BackupKeyChainEntry,
  type BackupObjectDescriptor,
  isCanonicalDecimal,
  isWellFormedIdentifier,
  refuseBackupGeneration,
} from "./backup-generation-contracts.js";

/**
 * A caller's request after it has been copied out of caller-owned memory. Split
 * from the coordinator so that module stays under the per-file cap and so the
 * sealing rules can be read without the orchestration around them.
 */
export interface SealedRequest {
  readonly cursor: string;
  readonly databasePath: string;
  readonly destinationPath: string;
  readonly keyChain: readonly BackupKeyChainEntry[];
  readonly objects: readonly (BackupObjectDescriptor & { readonly sourcePath: string })[];
  readonly privateKey: KeyObject;
  readonly projectId: string;
  readonly signingKeyId: string;
  readonly sourceGenerationDigest: string;
}

/**
 * One synchronous pass over caller-owned values before any await.
 *
 * Re-reading a caller's object after an await would let a getter or a
 * concurrent mutation change what was already validated, so every field is
 * copied out exactly once here and never consulted again.
 */
export function sealBackupRequest(input: unknown): SealedRequest | BackupGenerationRefused {
  if (typeof input !== "object" || input === null) {
    return refuseBackupGeneration("REQUEST_SHAPE_INVALID");
  }
  const raw = input as Record<string, unknown>;
  const signing = raw.signing as { keyId?: unknown; privateKey?: unknown } | undefined;
  if (
    !isCanonicalDecimal(raw.cursor) ||
    !isWellFormedIdentifier(raw.projectId) ||
    typeof raw.databasePath !== "string" ||
    typeof raw.destinationPath !== "string" ||
    typeof raw.sourceGenerationDigest !== "string" ||
    !Array.isArray(raw.objects) ||
    // `every` skips holes, so a sparse array would pass an element check while
    // carrying undefined entries. Own-index count is what rejects it.
    Object.keys(raw.objects).length !== raw.objects.length ||
    !Array.isArray(raw.keyChain) ||
    typeof signing !== "object" ||
    signing === null ||
    !isWellFormedIdentifier(signing.keyId)
  ) {
    return refuseBackupGeneration("REQUEST_SHAPE_INVALID");
  }

  const objects: (BackupObjectDescriptor & { sourcePath: string })[] = [];
  for (const candidate of raw.objects as unknown[]) {
    if (typeof candidate !== "object" || candidate === null) {
      return refuseBackupGeneration("REQUEST_SHAPE_INVALID");
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.sourcePath !== "string" || !isCanonicalDecimal(entry.byteLength)) {
      return refuseBackupGeneration("REQUEST_SHAPE_INVALID");
    }
    objects.push({
      byteLength: entry.byteLength,
      category: entry.category as BackupObjectDescriptor["category"],
      digest: String(entry.digest),
      logicalId: String(entry.logicalId),
      logicalPath: String(entry.logicalPath),
      sourceGenerationDigest: String(entry.sourceGenerationDigest),
      sourcePath: entry.sourcePath,
    });
  }

  return {
    cursor: raw.cursor,
    databasePath: raw.databasePath,
    destinationPath: raw.destinationPath,
    keyChain: (raw.keyChain as BackupKeyChainEntry[]).map((entry) => ({
      keyId: String(entry?.keyId),
      role: entry?.role === "ROOT" ? "ROOT" : "LEAF",
    })),
    objects,
    privateKey: signing.privateKey as KeyObject,
    projectId: raw.projectId,
    signingKeyId: signing.keyId,
    sourceGenerationDigest: raw.sourceGenerationDigest,
  };
}

/**
 * A destination may not be, contain, or live inside the database it captures.
 * Compared on resolved absolute paths with a trailing separator, so `/data/dbx`
 * is not mistaken for a child of `/data/db`.
 */
export function destinationIsUnsafe(destinationPath: string, databasePath: string): boolean {
  const destination = resolve(destinationPath);
  const database = resolve(databasePath);
  return (
    destination === database ||
    database.startsWith(destination + sep) ||
    destination.startsWith(database + sep)
  );
}
