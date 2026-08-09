import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  ARTIFACT_ADDRESS_PATTERN,
  ARTIFACT_STAGING_PATTERN,
  MAX_ARTIFACT_ENUMERATION_ENTRIES,
  enumerationFailure,
  sha256Hex,
  type ArtifactDirectoryEntry,
  type ArtifactEnumerationResult,
  type ArtifactFsPort,
  type ArtifactObjectObservation,
  type ArtifactStagingObservation,
} from "./artifact-contract.js";

/**
 * Bounded enumeration of an artifact store's own `<root>/objects` directory.
 *
 * Split out of artifact-store.ts because that file had roughly forty lines of
 * headroom under the per-file cap and this is more than forty lines of it. The
 * store still owns the decision to enumerate; this owns only how.
 *
 * The three facts the task rail separates are three different answers here:
 * a MISSING directory refuses, a readable but empty directory SUCCEEDS with a
 * digest, and an unreadable listing or entry refuses with a different code.
 * Returning an empty array for a directory that could not be read would let a
 * caller conclude "no artifacts" from "I could not look".
 *
 * Nothing is ever skipped. An entry that is not a valid content address or a
 * valid staging temp is REPORTED, because silently ignoring what it does not
 * recognise is how an enumerator hides the corruption it exists to find.
 */
export function enumerateArtifactsAt(
  fs: ArtifactFsPort,
  objectsDirectory: string,
): ArtifactEnumerationResult {
  const listDirectory = fs.listDirectory;
  if (listDirectory === undefined) {
    return enumerationFailure(
      "RUNNER_ARTIFACT_ENUMERATION_UNAVAILABLE",
      "the injected artifact filesystem port does not support directory listing",
      "ARTIFACT_STORE",
    );
  }
  if (!fs.exists(objectsDirectory)) {
    return enumerationFailure(
      "RUNNER_ARTIFACT_MISSING",
      "the artifact objects directory does not exist",
      "ARTIFACT_FS_PORT",
    );
  }

  let entries: readonly ArtifactDirectoryEntry[];
  try {
    entries = listDirectory.call(fs, objectsDirectory);
  } catch {
    // The OS error text is deliberately dropped: it carries absolute paths.
    return enumerationFailure(
      "RUNNER_ARTIFACT_VERIFY_FAILED",
      "the artifact objects directory could not be read",
      "ARTIFACT_FS_PORT",
    );
  }
  if (entries.length > MAX_ARTIFACT_ENUMERATION_ENTRIES) {
    return enumerationFailure(
      "RUNNER_ARTIFACT_ENUMERATION_LIMIT",
      `the artifact objects directory holds more than ${MAX_ARTIFACT_ENUMERATION_ENTRIES} entries`,
      "ARTIFACT_FS_PORT",
    );
  }

  // Sorted before anything is read, so a port that lists in a different order
  // produces byte-identical output and an identical observation digest.
  const ordered = [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const objects: ArtifactObjectObservation[] = [];
  const staging: ArtifactStagingObservation[] = [];
  for (const entry of ordered) {
    const classified = classify(fs, objectsDirectory, entry);
    if (!classified.ok) return classified.failure;
    if (classified.object !== undefined) objects.push(classified.object);
    if (classified.staging !== undefined) staging.push(classified.staging);
  }
  return Object.freeze({
    ok: true as const,
    objects: Object.freeze(objects),
    staging: Object.freeze(staging),
    entryCount: objects.length + staging.length,
    observationDigest: digestObservation(objects, staging),
  });
}

interface Classified {
  readonly ok: true;
  readonly object?: ArtifactObjectObservation;
  readonly staging?: ArtifactStagingObservation;
}

type ClassifyResult = Classified | { readonly ok: false; readonly failure: ArtifactEnumerationResult & { ok: false } };

function corrupt(detail: string): { readonly ok: false; readonly failure: ArtifactEnumerationResult & { ok: false } } {
  return { ok: false as const, failure: enumerationFailure("RUNNER_ARTIFACT_ADDRESS_CORRUPT", detail, "ARTIFACT_STORE") };
}

function classify(
  fs: ArtifactFsPort,
  objectsDirectory: string,
  entry: ArtifactDirectoryEntry,
): ClassifyResult {
  // A directory or a symlink where a content address belongs is a layout fault,
  // not an I/O fault, so ARTIFACT_STORE answers rather than the port.
  if (entry.kind !== "FILE") {
    return corrupt(`entry "${entry.name}" is a ${entry.kind.toLowerCase()}, not an artifact file`);
  }
  const isObject = ARTIFACT_ADDRESS_PATTERN.test(entry.name);
  const isStaging = ARTIFACT_STAGING_PATTERN.test(entry.name);
  if (!isObject && !isStaging) {
    return corrupt(`entry "${entry.name}" is neither a content address nor a staging temp`);
  }

  let bytes: Uint8Array;
  try {
    bytes = fs.readAll(join(objectsDirectory, entry.name));
  } catch {
    return {
      ok: false as const,
      failure: enumerationFailure(
        "RUNNER_ARTIFACT_VERIFY_FAILED",
        `entry "${entry.name}" could not be read`,
        "ARTIFACT_FS_PORT",
      ),
    };
  }
  const digest = sha256Hex(bytes);
  if (isObject) {
    // The address is a claim about the bytes. An enumerator that reported the
    // name without checking it would launder corruption into an inventory.
    if (digest !== entry.name) {
      return corrupt(`entry "${entry.name}" does not hash to its own address`);
    }
    return { ok: true as const, object: Object.freeze({ sha256: digest, byteLength: bytes.byteLength }) };
  }
  return {
    ok: true as const,
    staging: Object.freeze({ name: entry.name, byteLength: bytes.byteLength, sha256: digest }),
  };
}

/** Length-framed so no entry name can forge a boundary inside the digest. */
function digestObservation(
  objects: readonly ArtifactObjectObservation[],
  staging: readonly ArtifactStagingObservation[],
): string {
  const canonical = ["MOE-ARTIFACT-INVENTORY/1", `O${objects.length}`];
  for (const object of objects) {
    canonical.push(`${object.sha256}:${object.byteLength}`);
  }
  canonical.push(`S${staging.length}`);
  for (const temp of staging) {
    canonical.push(`${temp.name.length}:${temp.name}${temp.sha256}:${temp.byteLength}`);
  }
  return createHash("sha256").update(canonical.join("\n"), "utf8").digest("hex");
}
