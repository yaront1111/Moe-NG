import { join } from "node:path";

import {
  artifactFailure,
  attempt,
  refMatches,
  refRejection,
  sha256Hex,
  type ArtifactRef,
  type ArtifactReferenceProof,
  type ArtifactStore,
  type ArtifactStoreOptions,
  type DeleteArtifactResult,
  type StageArtifactResult,
  type VerifyArtifactResult,
} from "./artifact-contract.js";

/**
 * Content-addressed artifact staging.
 *
 * The protocol is exactly the one the design mandates for anything the database
 * may reference: written -> flushed -> renamed -> persisted -> verified ->
 * referenced. A reference is returned only after the final step, so a caller can
 * never hold an address that is not durable and byte-verified. Deletion is
 * refused unless the caller proves zero references; uncertainty keeps the bytes.
 */
export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
  const { fs, nextStagingCounter } = options;
  const objectsDirectory = join(options.root, "objects");
  const addressOf = (sha256: string): string => join(objectsDirectory, sha256);

  /** Best effort: a leftover temp is inert, an unverified address is not. */
  const discard = (path: string): void => {
    try {
      fs.unlink(path);
    } catch {
      // A failed cleanup never upgrades a failure into a reference.
    }
  };

  /**
   * Decides whether the object already at `address` is the same content.
   * Renaming over an existing address is never allowed: on win32 it silently
   * replaces a closed destination (hiding corruption) and throws EPERM while a
   * concurrent reader holds it open.
   */
  const reuseExisting = (address: string, ref: ArtifactRef, temp: string): StageArtifactResult => {
    const read = attempt("RUNNER_ARTIFACT_VERIFY_FAILED", () => fs.readAll(address));
    discard(temp);
    if (!read.ok) {
      return read;
    }
    if (!refMatches(read.value, ref)) {
      return artifactFailure(
        "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
        `object at ${ref.sha256} does not hash to its own address`,
      );
    }
    return Object.freeze({ ok: true as const, ref, deduplicated: true });
  };

  /** written -> flushed -> closed, or nothing addressable survives. */
  const writeTemp = (temp: string, bytes: Uint8Array): StageArtifactResult | null => {
    const opened = attempt("RUNNER_ARTIFACT_WRITE_FAILED", () => fs.openWrite(temp));
    if (!opened.ok) {
      return opened;
    }
    const fd = opened.value;
    const written = attempt("RUNNER_ARTIFACT_WRITE_FAILED", () => fs.write(fd, bytes));
    const flushed = written.ok
      ? attempt("RUNNER_ARTIFACT_FLUSH_FAILED", () => fs.fsync(fd))
      : written;
    if (!flushed.ok) {
      attempt("RUNNER_ARTIFACT_CLOSE_FAILED", () => fs.close(fd));
      discard(temp);
      return flushed;
    }
    const closed = attempt("RUNNER_ARTIFACT_CLOSE_FAILED", () => fs.close(fd));
    if (!closed.ok) {
      discard(temp);
      return closed;
    }
    return null;
  };

  /** renamed -> persisted -> verified, or the address is emptied again. */
  const publish = (temp: string, address: string, ref: ArtifactRef): StageArtifactResult => {
    const renamed = attempt("RUNNER_ARTIFACT_RENAME_FAILED", () => fs.rename(temp, address));
    if (!renamed.ok) {
      discard(temp);
      return renamed;
    }
    const persisted = attempt("RUNNER_ARTIFACT_PERSIST_FAILED", () =>
      fs.persistAfterRename(address),
    );
    if (!persisted.ok) {
      discard(address);
      return persisted;
    }
    const verified = attempt("RUNNER_ARTIFACT_VERIFY_FAILED", () => fs.readAll(address));
    if (!verified.ok) {
      discard(address);
      return verified;
    }
    if (!refMatches(verified.value, ref)) {
      // Leaving the mismatch in place would poison the address forever: every
      // future staging of the true content would dedup onto the wrong bytes.
      discard(address);
      return artifactFailure(
        "RUNNER_ARTIFACT_VERIFY_FAILED",
        `object at ${ref.sha256} failed post-rename verification`,
      );
    }
    return Object.freeze({ ok: true as const, ref, deduplicated: false });
  };

  const stageArtifact = (bytes: Uint8Array): StageArtifactResult => {
    const ref: ArtifactRef = Object.freeze({
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
    });
    const counter = nextStagingCounter();
    if (!Number.isSafeInteger(counter) || counter < 0) {
      return artifactFailure(
        "RUNNER_ARTIFACT_STAGING_INVALID",
        "staging counter must be a non-negative safe integer",
      );
    }
    const address = addressOf(ref.sha256);
    // Same directory as the address: a cross-volume rename degrades to a
    // non-atomic copy, and the ".tmp" suffix keeps a partial write unaddressable.
    const temp = join(objectsDirectory, `${ref.sha256.slice(0, 16)}.${counter}.tmp`);

    const staged = writeTemp(temp, bytes);
    if (staged !== null) {
      return staged;
    }
    const occupied = attempt("RUNNER_ARTIFACT_VERIFY_FAILED", () => fs.exists(address));
    if (!occupied.ok) {
      discard(temp);
      return occupied;
    }
    return occupied.value ? reuseExisting(address, ref, temp) : publish(temp, address, ref);
  };

  const verifyArtifact = (ref: ArtifactRef): VerifyArtifactResult => {
    const rejection = refRejection(ref);
    if (rejection !== null) {
      return artifactFailure("RUNNER_ARTIFACT_REF_INVALID", rejection);
    }
    const address = addressOf(ref.sha256);
    const found = attempt("RUNNER_ARTIFACT_VERIFY_FAILED", () => fs.exists(address));
    if (!found.ok) {
      return found;
    }
    if (!found.value) {
      return artifactFailure("RUNNER_ARTIFACT_MISSING", `no object at ${ref.sha256}`);
    }
    const read = attempt("RUNNER_ARTIFACT_VERIFY_FAILED", () => fs.readAll(address));
    if (!read.ok) {
      return read;
    }
    if (!refMatches(read.value, ref)) {
      return artifactFailure(
        "RUNNER_ARTIFACT_ADDRESS_CORRUPT",
        `object at ${ref.sha256} does not hash to its own address`,
      );
    }
    return Object.freeze({ ok: true as const });
  };

  const deleteArtifact = (
    ref: ArtifactRef,
    proof: ArtifactReferenceProof,
  ): DeleteArtifactResult => {
    const rejection = refRejection(ref);
    if (rejection !== null) {
      return artifactFailure("RUNNER_ARTIFACT_REF_INVALID", rejection);
    }
    if (proof.state === "REFERENCED") {
      return artifactFailure("RUNNER_ARTIFACT_REFS_PRESENT", "artifact is still referenced");
    }
    if (proof.state !== "ZERO_REFERENCES" || proof.scannedGenerations.length === 0) {
      return artifactFailure(
        "RUNNER_ARTIFACT_REFS_UNCERTAIN",
        "deletion requires a ZERO_REFERENCES proof naming the scanned generations",
      );
    }
    const address = addressOf(ref.sha256);
    const found = attempt("RUNNER_ARTIFACT_VERIFY_FAILED", () => fs.exists(address));
    if (!found.ok) {
      return found;
    }
    if (!found.value) {
      return Object.freeze({ ok: true as const, deleted: false });
    }
    const removed = attempt("RUNNER_ARTIFACT_DELETE_FAILED", () => fs.unlink(address));
    if (!removed.ok) {
      return removed;
    }
    return Object.freeze({ ok: true as const, deleted: true });
  };

  return Object.freeze({ stageArtifact, verifyArtifact, deleteArtifact });
}
