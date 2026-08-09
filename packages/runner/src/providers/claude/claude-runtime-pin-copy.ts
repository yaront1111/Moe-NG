import { createHash } from "node:crypto";
import { win32 } from "node:path";

import {
  describeError,
  refuse,
  type ClaudeRuntimePinFailure,
  type SourceEntry,
} from "./claude-runtime-pin-closure.js";
import { streamDigest, type ClaudeRuntimeFsPort } from "./claude-runtime-pin-fs.js";

/**
 * The staging and publication protocol for a content-addressed runtime pin.
 *
 * Nothing here decides whether a closure is admissible — that is
 * `claude-runtime-pin-closure.ts`. This module only moves proven bytes into a
 * private root without ever replacing anything that is already there.
 */

/** Unique per call within a process; combined with the pid across processes. */
let stagingSequence = 0;

export async function tryRemove(
  fs: ClaudeRuntimeFsPort,
  path: string,
): Promise<ClaudeRuntimePinFailure | null> {
  try {
    await fs.removeTree(path);
    return null;
  } catch (error) {
    return refuse("CLAUDE_RUNTIME_PIN_CLEANUP_FAILED", `${path}: ${describeError(error)}`);
  }
}

/**
 * Copies one entry while hashing what was actually written, then re-reads the
 * destination. The write-side hash catches a source rewritten mid-copy; the
 * re-read catches a destination that did not receive what was written.
 */
async function copyEntry(
  fs: ClaudeRuntimeFsPort,
  staging: string,
  source: SourceEntry,
): Promise<ClaudeRuntimePinFailure | null> {
  const destination = win32.join(staging, source.relativePath);
  await fs.ensureDirectory(win32.dirname(destination));
  const hash = createHash("sha256");
  const handle = await fs.openExclusiveWrite(destination);
  try {
    for await (const chunk of fs.readChunks(source.canonicalPath)) {
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    // Closed before anything else can fail, so a doomed copy never keeps a
    // handle open on a tree the caller is about to remove.
    await handle.close();
  }
  const written = hash.digest("hex");
  const stored = await streamDigest(fs, destination);
  if (written !== source.sha256 || stored !== source.sha256) {
    return refuse(
      "CLAUDE_RUNTIME_PIN_DESTINATION_MISMATCH",
      `${source.relativePath} copied as ${written}/${stored}, expected ${source.sha256}`,
    );
  }
  return null;
}

/** A source that changed after its bytes were copied invalidates the closure. */
async function confirmSources(
  fs: ClaudeRuntimeFsPort,
  sources: readonly SourceEntry[],
): Promise<ClaudeRuntimePinFailure | null> {
  for (const source of sources) {
    const current = await streamDigest(fs, source.canonicalPath);
    if (current !== source.sha256) {
      return refuse(
        "CLAUDE_RUNTIME_PIN_SOURCE_DRIFT",
        `${source.canonicalPath} now hashes to ${current}, was ${source.sha256}`,
      );
    }
  }
  return null;
}

export async function stageClosure(
  fs: ClaudeRuntimeFsPort,
  pinRoot: string,
  aggregate: string,
  sources: readonly SourceEntry[],
): Promise<string | ClaudeRuntimePinFailure> {
  stagingSequence += 1;
  // Same parent as the final root so publication is a rename on one volume.
  const staging = win32.join(
    pinRoot,
    `.staging-${aggregate.slice(0, 16)}-${process.pid}-${stagingSequence}`,
  );
  let failure: ClaudeRuntimePinFailure | null = null;
  try {
    await fs.createDirectoryExclusive(staging);
    for (const source of sources) {
      failure = await copyEntry(fs, staging, source);
      if (failure !== null) break;
    }
    failure ??= await confirmSources(fs, sources);
  } catch (error) {
    failure = refuse("CLAUDE_RUNTIME_PIN_COPY_FAILED", describeError(error));
  }
  if (failure === null) {
    return staging;
  }
  // A cleanup that fails outranks the copy failure: an unremovable partial tree
  // is the more serious unknown, and reporting the copy code would hide it.
  return (await tryRemove(fs, staging)) ?? failure;
}

/**
 * A root that already exists is never replaced. It is verified byte for byte
 * and adopted only on an exact match; anything else is preserved untouched and
 * refused, because a differing root under a content address is evidence of
 * tampering rather than a stale cache to overwrite.
 */
export async function verifyPublished(
  fs: ClaudeRuntimeFsPort,
  root: string,
  sources: readonly SourceEntry[],
): Promise<ClaudeRuntimePinFailure | null> {
  if ((await fs.entryKind(root)) !== "DIRECTORY") {
    return refuse("CLAUDE_RUNTIME_PIN_COLLISION", `${root} exists and is not a directory`);
  }
  for (const source of sources) {
    const pinned = win32.join(root, source.relativePath);
    if ((await fs.entryKind(pinned)) !== "FILE") {
      return refuse(
        "CLAUDE_RUNTIME_PIN_COLLISION",
        `published closure lacks ${source.relativePath}`,
      );
    }
    if ((await streamDigest(fs, pinned)) !== source.sha256) {
      return refuse(
        "CLAUDE_RUNTIME_PIN_COLLISION",
        `published ${source.relativePath} does not match the pinned digest`,
      );
    }
  }
  // Matching declared members is not enough: an undeclared neighbour is exactly
  // how a side-by-side load gets into an otherwise verified directory.
  const declared = new Set(sources.map((source) => source.relativePath));
  const extra = (await fs.listFiles(root)).filter((path) => !declared.has(path));
  if (extra.length > 0) {
    return refuse("CLAUDE_RUNTIME_PIN_COLLISION", `published closure holds ${extra.length} extra`);
  }
  return null;
}

export async function publish(
  fs: ClaudeRuntimeFsPort,
  staging: string,
  finalRoot: string,
  sources: readonly SourceEntry[],
): Promise<ClaudeRuntimePinFailure | null> {
  try {
    // Preflight, then treat a rename failure as a possible concurrent winner:
    // Windows can replace some targets, so the absence check is not enough.
    if ((await fs.entryKind(finalRoot)) !== "MISSING") {
      return (await tryRemove(fs, staging)) ?? (await verifyPublished(fs, finalRoot, sources));
    }
    await fs.rename(staging, finalRoot);
    return null;
  } catch (error) {
    const verdict =
      (await fs.entryKind(finalRoot)) === "MISSING"
        ? refuse("CLAUDE_RUNTIME_PIN_COPY_FAILED", describeError(error))
        : await verifyPublished(fs, finalRoot, sources);
    return (await tryRemove(fs, staging)) ?? verdict;
  }
}
