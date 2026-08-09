import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ArtifactRef } from "../artifacts/artifact-contract.js";
import { canonicalDigest, sha256Hex } from "../canonical.js";
import type { ObservationClock } from "../providers/claude/claude-observation.js";
import type { ScopeObservation } from "../scope/scope-contract.js";
import type {
  WorkspaceInputEntry, WorkspaceInputManifest, WorkspaceProducer, WorkspaceResultManifest,
} from "../workspace/workspace-contract.js";
import { buildInputManifest, buildResultManifest } from "../workspace/workspace-manifest.js";
import type {
  RecoveryInventoryEnumerationContext,
  RecoveryInventoryItem,
  RecoveryInventoryPortReading,
  RecoveryInventoryRegistration,
} from "./recovery-inventory-contract.js";

/**
 * Recovery-window enumerator for the WORKSPACE class.
 *
 * It reads real bytes: the tree under each declared root is walked here and sealed
 * through the shipped `buildInputManifest`, with `buildResultManifest` sealing the
 * result tree of a workspace that declares one. No manifest, digest or path rule
 * is reimplemented in this module.
 *
 * THE NEGATIVE PROOF IS A SEALED DIGEST, NOT A FLAG. A lister that says "there are
 * no workspaces" has produced nothing anyone can verify later, so an empty answer
 * with nothing sealed stays UNKNOWN. A root that was walked and sealed empty is
 * different: the empty manifest's digest IS the proof it was looked at. A root
 * that could not be read, or a tree member that is not a regular file, truncates
 * the enumeration rather than shrinking it.
 */
export const WORKSPACE_INVENTORY_VERSION = "moe-workspace-inventory/1" as const;

const CLASS = "WORKSPACE" as const;

const UNAVAILABLE: RecoveryInventoryPortReading = Object.freeze({ status: "UNAVAILABLE" as const });

export interface WorkspaceInventoryResultAspect {
  readonly scopeObservation: ScopeObservation;
  readonly authoredPaths: readonly string[];
  readonly declaredArtifactRefs: readonly ArtifactRef[];
}

/** `workspaceRef` is the stable external name every item identity hangs off. */
export interface WorkspaceInventorySource {
  readonly workspaceRef: string;
  readonly baseIdentity: string;
  readonly rootPath: string;
  readonly producer: WorkspaceProducer;
  readonly result: WorkspaceInventoryResultAspect | null;
}

export interface WorkspaceInventoryListing {
  readonly workspaces: readonly WorkspaceInventorySource[];
  /** False when the lister could not prove it saw every workspace. */
  readonly listingComplete: boolean;
}

export interface WorkspaceInventoryPort {
  readonly list: () => WorkspaceInventoryListing;
}

export interface WorkspaceInventoryInput {
  readonly port: WorkspaceInventoryPort;
  readonly clock: ObservationClock;
}

/** `provenTotal` is false when some member of the tree could not be accounted for. */
interface WorkspaceScan {
  readonly entries: readonly WorkspaceInputEntry[];
  readonly provenTotal: boolean;
}

/** Null means the root itself could not be read: unknown, never empty. */
async function scanWorkspace(source: WorkspaceInventorySource): Promise<WorkspaceScan | null> {
  let listing;
  try {
    listing = await readdir(source.rootPath, { withFileTypes: true, recursive: true });
  } catch {
    return null;
  }
  const entries: WorkspaceInputEntry[] = [];
  let provenTotal = true;
  for (const dirent of listing) {
    if (dirent.isDirectory()) continue;
    // A symlink, junction or device node carries no bytes this seam may claim,
    // and dropping it silently would report an unaccounted path as absent.
    if (!dirent.isFile()) {
      provenTotal = false;
      continue;
    }
    const absolute = join(dirent.parentPath, dirent.name);
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      provenTotal = false;
      continue;
    }
    entries.push({
      path: relative(source.rootPath, absolute).replaceAll("\\", "/"),
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
      producer: source.producer,
    });
  }
  return { entries, provenTotal };
}

/** The whole scanned tree is the result tree; nothing here invents authorship. */
function sealResult(
  aspect: WorkspaceInventoryResultAspect,
  inputManifest: WorkspaceInputManifest,
): WorkspaceResultManifest | null {
  const built = buildResultManifest({
    inputManifest,
    scopeObservation: aspect.scopeObservation,
    authoredPaths: aspect.authoredPaths,
    resultTreeEntries: inputManifest.entries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      byteLength: entry.byteLength,
      origin: "INHERITED" as const,
      kind: "REGULAR" as const,
    })),
    declaredArtifactRefs: aspect.declaredArtifactRefs,
  });
  return built.ok ? built.manifest : null;
}

function inputItem(
  source: WorkspaceInventorySource,
  entry: WorkspaceInputEntry,
  manifest: WorkspaceInputManifest,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): RecoveryInventoryItem {
  return {
    class: CLASS,
    projectTag: context.projectTag,
    identity: { kind: "PATH", path: `${source.workspaceRef}/${entry.path}` },
    observedAt,
    facts: {
      origin: "INPUT",
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      producerKind: entry.producer.kind,
      baseIdentity: manifest.baseIdentity,
    },
    sourceProofDigest: manifest.sha256,
  };
}

function resultItem(
  source: WorkspaceInventorySource,
  manifest: WorkspaceResultManifest,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): RecoveryInventoryItem {
  return {
    class: CLASS,
    projectTag: context.projectTag,
    identity: { kind: "OPAQUE", id: `workspace-result:${source.workspaceRef}` },
    observedAt,
    facts: {
      origin: "RESULT",
      inputManifestSha256: manifest.inputManifestSha256,
      scopeObservationSha256: manifest.scopeObservationSha256,
      inheritedCount: manifest.inheritedEntries.length,
      authoredCount: manifest.authoredEntries.length,
      artifactRefCount: manifest.declaredArtifactRefs.length,
      baseIdentity: manifest.baseIdentity,
    },
    sourceProofDigest: manifest.sha256,
  };
}

interface Collected {
  readonly items: readonly RecoveryInventoryItem[];
  readonly sealed: readonly string[];
  readonly complete: boolean;
}

/**
 * Two spellings of one workspace ref are deliberately NOT merged here: both rows
 * are emitted and the aggregate refuses the collision. A last-writer-wins merge in
 * this loop would erase one real workspace and report the survivor as complete.
 */
async function collectSource(
  source: WorkspaceInventorySource,
  context: RecoveryInventoryEnumerationContext,
  observedAt: string,
): Promise<Collected | null> {
  const scan = await scanWorkspace(source);
  if (scan === null) return { items: [], sealed: [], complete: false };
  const built = buildInputManifest({ baseIdentity: source.baseIdentity, entries: scan.entries });
  if (!built.ok) return null;
  const items = built.manifest.entries.map((entry) =>
    inputItem(source, entry, built.manifest, context, observedAt),
  );
  const sealed = [built.manifest.sha256];
  if (source.result !== null) {
    const result = sealResult(source.result, built.manifest);
    if (result === null) return null;
    sealed.push(result.sha256);
    items.push(resultItem(source, result, context, observedAt));
  }
  return { items, sealed, complete: scan.provenTotal };
}

export async function enumerateWorkspaceInventory(
  input: WorkspaceInventoryInput,
  context: RecoveryInventoryEnumerationContext,
): Promise<RecoveryInventoryPortReading> {
  let listing: WorkspaceInventoryListing;
  try {
    listing = input.port.list();
  } catch {
    return UNAVAILABLE;
  }
  const observedAt = input.clock.observedAt();
  const items: RecoveryInventoryItem[] = [];
  const sealed: string[] = [];
  let complete = listing.listingComplete;
  for (const source of listing.workspaces) {
    const collected = await collectSource(source, context, observedAt);
    if (collected === null) return UNAVAILABLE;
    items.push(...collected.items);
    sealed.push(...collected.sealed);
    complete &&= collected.complete;
  }
  const proof =
    sealed.length === 0
      ? null
      : canonicalDigest({ version: WORKSPACE_INVENTORY_VERSION, sealed: [...sealed].sort() });
  return { status: "ENUMERATED", items, complete, negativeProofDigest: proof };
}

/** A factory for the same reason as the provider slice: ports, not module state. */
export function workspaceInventoryRegistration(
  input: WorkspaceInventoryInput,
): RecoveryInventoryRegistration {
  return Object.freeze({
    class: CLASS,
    enumerate: (context: RecoveryInventoryEnumerationContext) =>
      enumerateWorkspaceInventory(input, context),
  });
}
