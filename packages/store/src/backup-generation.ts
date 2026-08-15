import { createHash, createPublicKey, sign as edSign } from "node:crypto";
import { open, mkdir, rm, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { captureDatabaseAtCursor } from "./backup-generation-capture.js";
import {
  BACKUP_GENERATION_MANIFEST_VERSION,
  type BackupGenerationManifest,
  type BackupGenerationRefused,
  type BackupObjectDescriptor,
  refuseBackupGeneration,
} from "./backup-generation-contracts.js";
import {
  destinationIsUnsafe,
  sealBackupRequest,
  type SealedRequest,
} from "./backup-generation-request.js";
import {
  canonicalManifestBytes,
  computeGenerationDigest,
  inspectClosure,
  verifyBackupGeneration,
} from "./backup-generation-manifest.js";
import { publishStagedGeneration } from "./backup-generation-publish.js";

export interface BackupGenerationCreated {
  readonly container: unknown;
  readonly generationPath: string;
  readonly manifest: BackupGenerationManifest;
  readonly manifestPath: string;
  readonly ok: true;
  readonly restorable: true;
}

export type BackupGenerationCreateResult = BackupGenerationCreated | BackupGenerationRefused;

/** Write, fsync and re-read: a write that was never persisted is not evidence. */
async function persistFile(path: string, payload: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  try {
    await handle.write(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyDeclaredObject(
  entry: BackupObjectDescriptor & { sourcePath: string },
  stagingRoot: string,
): Promise<BackupGenerationRefused | null> {
  let payload: Buffer;
  try {
    payload = await readFile(entry.sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refuseBackupGeneration(code === "ENOENT" ? "OBJECT_MISSING" : "OBJECT_UNREADABLE");
  }
  if (String(payload.byteLength) !== entry.byteLength) {
    return refuseBackupGeneration("OBJECT_SIZE_MISMATCH");
  }
  if (createHash("sha256").update(payload).digest("hex") !== entry.digest) {
    return refuseBackupGeneration("OBJECT_DIGEST_MISMATCH");
  }
  const destination = join(stagingRoot, ...entry.logicalPath.split("/"));
  await persistFile(destination, payload);
  const reread = await readFile(destination);
  if (createHash("sha256").update(reread).digest("hex") !== entry.digest) {
    return refuseBackupGeneration("DURABILITY_FAULT");
  }
  return null;
}

/**
 * Builds one cursor-bound, signed, self-verified backup generation.
 *
 * Ordering is the guarantee: nothing is published to the final path until every
 * declared byte has been copied, re-read and verified, and the manifest itself
 * has passed the same production verifier a consumer would run.
 */
export async function createBackupGeneration(
  input: unknown,
): Promise<BackupGenerationCreateResult> {
  const sealed = sealBackupRequest(input);
  if ("ok" in sealed && sealed.ok === false) return sealed;
  const request = sealed as SealedRequest;

  const closureFault = inspectClosure(request.objects, request.sourceGenerationDigest);
  if (closureFault !== null) return refuseBackupGeneration(closureFault);
  if (destinationIsUnsafe(request.destinationPath, request.databasePath)) {
    return refuseBackupGeneration("DESTINATION_UNSAFE");
  }
  for (const entry of request.objects) {
    if (entry.logicalPath.includes("..") || entry.logicalPath.startsWith("/")) {
      return refuseBackupGeneration("DESTINATION_UNSAFE");
    }
  }

  const finalPath = resolve(request.destinationPath);
  const stagingRoot = `${finalPath}.staging`;
  try {
    await rm(stagingRoot, { force: true, recursive: true });
    await mkdir(stagingRoot, { recursive: true });

    const capture = await captureDatabaseAtCursor(
      request.databasePath,
      request.projectId,
      request.cursor,
      join(stagingRoot, "database.sqlite"),
    );
    if (!capture.ok) return refuseBackupGeneration(capture.reason);

    for (const entry of request.objects) {
      const fault = await copyDeclaredObject(entry, stagingRoot);
      if (fault !== null) return fault;
    }

    const draft = {
      cursor: capture.captured.cursor,
      databaseByteLength: capture.captured.byteLength,
      databaseDigest: capture.captured.digest,
      generationDigest: "",
      keyChain: request.keyChain,
      objects: request.objects.map((entry) => ({
        byteLength: entry.byteLength,
        category: entry.category,
        digest: entry.digest,
        logicalId: entry.logicalId,
        logicalPath: entry.logicalPath,
        sourceGenerationDigest: entry.sourceGenerationDigest,
      })),
      projectId: request.projectId,
      sourceGenerationDigest: request.sourceGenerationDigest,
      version: BACKUP_GENERATION_MANIFEST_VERSION,
    } satisfies BackupGenerationManifest;
    const manifest = Object.freeze({
      ...draft,
      generationDigest: computeGenerationDigest(draft),
    }) as BackupGenerationManifest;

    let signature: string;
    let publicKeySpkiDer: string;
    try {
      signature = edSign(null, canonicalManifestBytes(manifest), request.privateKey).toString("hex");
      // Derived from the private key rather than accepted from the caller, so a
      // container can never advertise a key its signature was not made with.
      publicKeySpkiDer = createPublicKey(request.privateKey)
        .export({ format: "der", type: "spki" })
        .toString("hex");
    } catch {
      return refuseBackupGeneration("MANIFEST_SIGNATURE_INVALID");
    }

    const container = Object.freeze({
      keyId: request.signingKeyId,
      manifest,
      publicKeySpkiDer,
      signature,
    });
    const observedLogicalPaths = manifest.objects.map((entry) => entry.logicalPath);
    const selfCheck = verifyBackupGeneration(
      container,
      { anchoredKeys: [{ keyId: request.signingKeyId, publicKeySpkiDer }] },
      { observedLogicalPaths },
    );
    if (!selfCheck.ok) return selfCheck;

    await persistFile(
      join(stagingRoot, "manifest.json"),
      new TextEncoder().encode(JSON.stringify(container)),
    );
    await publishStagedGeneration(stagingRoot, finalPath);

    const manifestPath = join(finalPath, "manifest.json");
    // Reopen and fsync the published manifest: on Windows the directory rename
    // is not itself durable, so the final bytes are what get persisted.
    const persisted = await open(manifestPath, "r+");
    try {
      await persisted.sync();
    } finally {
      await persisted.close();
    }

    const published = JSON.parse(await readFile(manifestPath, "utf8"));
    const finalCheck = verifyBackupGeneration(
      published,
      { anchoredKeys: [{ keyId: request.signingKeyId, publicKeySpkiDer }] },
      { observedLogicalPaths },
    );
    if (!finalCheck.ok) return finalCheck;

    return Object.freeze({
      container,
      generationPath: finalPath,
      manifest,
      manifestPath,
      ok: true,
      restorable: true,
    } as const);
  } catch {
    return refuseBackupGeneration("DURABILITY_FAULT");
  } finally {
    await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
  }
}

export { verifyBackupGeneration };
