/**
 * The install protocol's ordered boundaries, split out of recovery-anchor.ts so
 * neither file crowds the 250-line target.
 *
 * The ordering here IS the crash-safety guarantee: everything lands in the
 * inactive slot and is verified there, and only then does one atomic anchor
 * rewrite move the pointer. Nothing compensates or cleans up after a failure,
 * because nothing the current slot depends on was ever touched.
 */
import { join } from "node:path";

import {
  RECOVERY_ANCHOR_DATABASE_MISMATCH,
  RECOVERY_ANCHOR_DATABASE_NAME,
  RECOVERY_ANCHOR_FILE_NAME,
  RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN,
  RECOVERY_ANCHOR_SLOTS_DIR_NAME,
  RECOVERY_ANCHOR_SLOT_MANIFEST_NAME,
  RECOVERY_ANCHOR_SLOT_MANIFEST_VERSION,
  RECOVERY_ANCHOR_SLOT_UNVERIFIABLE,
  RECOVERY_ANCHOR_UNREADABLE,
} from "./recovery-anchor-contracts.js";
import type {
  RecoveryAnchorInstallResult,
  RecoveryAnchorRecord,
  RecoveryAnchorRefused,
  RecoveryAnchorSlotManifest,
  RecoveryBindingSlotName,
} from "./recovery-anchor-contracts.js";
import {
  clearDirectory,
  persistDirectoryDurably,
  persistFileDurably,
  publishFileAtomically,
  readBackMatches,
  readFileIfPresent,
  readFileIfReadable,
} from "./recovery-anchor-fs.js";
import { markInstalled } from "./recovery-anchor-marker.js";
import {
  decodeAnchorRecord,
  encodeAnchorRecord,
  resealAnchorRecord,
} from "./recovery-anchor-record.js";
import type { RecoveryAnchorRequest } from "./recovery-anchor-record.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import {
  RECOVERY_BINDING_CODEC_VERSION,
  RECOVERY_BINDING_SLOTS,
} from "./recovery-install-contracts.js";

const encoder = new TextEncoder();

/**
 * Which ROW inside a restored database holds its recovery binding. This is not
 * the file slot: the row namespace is internal to one database and describes
 * that database, while the file slot says which of two directories is live.
 * Conflating them would make a slot rename mean two different things.
 */
const ANCHOR_BINDING_ROW_SLOT = RECOVERY_BINDING_SLOTS[0];

export function anchorPath(root: string): string {
  return join(root, RECOVERY_ANCHOR_FILE_NAME);
}

export function slotDirectory(root: string, slot: RecoveryBindingSlotName): string {
  return join(root, RECOVERY_ANCHOR_SLOTS_DIR_NAME, slot);
}

function artifactPath(slotRoot: string, logicalPath: string): string {
  return join(slotRoot, ...logicalPath.split("/"));
}

export async function readStoredAnchor(
  root: string,
): Promise<RecoveryAnchorRecord | RecoveryAnchorRefused | null> {
  let bytes: Buffer | null;
  try {
    bytes = await readFileIfPresent(anchorPath(root));
  } catch {
    // Only ENOENT means "no anchor". An anchor that EXISTS but cannot be read
    // proves nothing about which slot is live, and answering "absent" here
    // would skip fence-reuse detection and aim the next install at the live
    // slot — the one thing this module exists to never do.
    return RECOVERY_ANCHOR_UNREADABLE;
  }
  return bytes === null ? null : decodeAnchorRecord(bytes);
}

function slotManifestBytes(anchor: RecoveryAnchorRecord): Uint8Array {
  const manifest: RecoveryAnchorSlotManifest = {
    generationDigest: anchor.generationDigest,
    incarnationRef: anchor.incarnationRef,
    keyEpochRef: anchor.keyEpochRef,
    payloadDigests: anchor.payloadDigests,
    slotManifestVersion: RECOVERY_ANCHOR_SLOT_MANIFEST_VERSION,
  };
  return encoder.encode(JSON.stringify(manifest));
}

async function readSlotManifest(slotRoot: string): Promise<RecoveryAnchorSlotManifest | null> {
  const bytes = await readFileIfReadable(join(slotRoot, RECOVERY_ANCHOR_SLOT_MANIFEST_NAME));
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as RecoveryAnchorSlotManifest;
    return candidate.slotManifestVersion === RECOVERY_ANCHOR_SLOT_MANIFEST_VERSION
      ? candidate
      : null;
  } catch {
    return null;
  }
}

/** Stamps the fresh incarnation and key epoch into the RESTORED database only. */
function stampIncarnation(
  slotRoot: string,
  request: RecoveryAnchorRequest,
): RecoveryAnchorInstallResult | null {
  const store = SqliteEventStore.openForProject(
    join(slotRoot, RECOVERY_ANCHOR_DATABASE_NAME),
    request.projectId,
  );
  try {
    const result = store.installRecoveryBinding({
      bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
      incarnationRef: request.incarnationRef,
      installedAt: request.preparedAt,
      keyEpochRef: request.keyEpochRef,
      payload: encoder.encode(request.generationDigest),
      slot: ANCHOR_BINDING_ROW_SLOT,
    });
    return result.ok ? null : result;
  } finally {
    store.close();
  }
}

/**
 * Read-back verification of ONE slot, judged against that slot's OWN manifest.
 * A fresh reader after a crash usually has to verify the slot the install was
 * not writing, and grading it against the in-flight anchor's digests would fail
 * a slot that is perfectly intact.
 */
export async function verifySlot(
  slotRoot: string,
  projectId: string,
  selectedBy: RecoveryAnchorRecord | null = null,
): Promise<RecoveryAnchorRefused | null> {
  const manifest = await readSlotManifest(slotRoot);
  if (manifest === null) return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;

  /**
   * A slot can be internally consistent and still be the WRONG slot. Once the
   * anchor is INSTALLED it names the generation its current slot must hold, so
   * the two are cross-checked; before the switch they legitimately differ (the
   * anchor describes the restore in flight, the current slot the prior one),
   * which is why this runs only when a record is supplied.
   */
  if (
    selectedBy !== null &&
    (manifest.incarnationRef !== selectedBy.incarnationRef ||
      manifest.generationDigest !== selectedBy.generationDigest)
  ) {
    return RECOVERY_ANCHOR_DATABASE_MISMATCH;
  }

  const entries = Object.entries(manifest.payloadDigests);
  if (entries.length === 0) return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
  for (const [logicalPath, digest] of entries) {
    if (!(await readBackMatches(artifactPath(slotRoot, logicalPath), digest))) {
      return RECOVERY_ANCHOR_SLOT_UNVERIFIABLE;
    }
  }

  const databasePath = join(slotRoot, RECOVERY_ANCHOR_DATABASE_NAME);
  if ((await readFileIfReadable(databasePath)) === null) {
    return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
  }
  const store = SqliteEventStore.openForProject(databasePath, projectId);
  try {
    const read = store.readRecoveryBinding(ANCHOR_BINDING_ROW_SLOT);
    if (!read.ok || read.outcome !== "FOUND") return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
    if (
      read.binding.incarnationRef !== manifest.incarnationRef ||
      read.binding.keyEpochRef !== manifest.keyEpochRef
    ) {
      return RECOVERY_ANCHOR_DATABASE_MISMATCH;
    }
  } finally {
    store.close();
  }
  return null;
}

async function writeInactiveSlot(
  slotRoot: string,
  request: RecoveryAnchorRequest,
  anchor: RecoveryAnchorRecord,
): Promise<void> {
  await clearDirectory(slotRoot);
  await persistFileDurably(join(slotRoot, RECOVERY_ANCHOR_DATABASE_NAME), request.databaseBytes);
  for (const artifact of request.artifacts) {
    await persistFileDurably(artifactPath(slotRoot, artifact.logicalPath), artifact.bytes);
  }
  await persistFileDurably(
    join(slotRoot, RECOVERY_ANCHOR_SLOT_MANIFEST_NAME),
    slotManifestBytes(anchor),
  );
}

async function persistSlotDurably(slotRoot: string, request: RecoveryAnchorRequest): Promise<void> {
  const directories = new Set<string>([slotRoot]);
  for (const artifact of request.artifacts) {
    const segments = artifact.logicalPath.split("/");
    segments.pop();
    if (segments.length > 0) directories.add(join(slotRoot, ...segments));
  }
  for (const directory of directories) {
    await persistDirectoryDurably(directory);
  }
}

export async function runInstall(
  request: RecoveryAnchorRequest,
  prepared: RecoveryAnchorRecord,
): Promise<RecoveryAnchorInstallResult> {
  const fault = request.injectFault;
  const slotRoot = slotDirectory(request.anchorRoot, prepared.targetSlot);

  fault?.("INACTIVE_INSTALL");
  await writeInactiveSlot(slotRoot, request, prepared);

  fault?.("TRANSACTION");
  const stamped = stampIncarnation(slotRoot, request);
  if (stamped !== null) return stamped;

  // The transaction reopened and wrote the database, so the bytes flushed
  // during writeInactiveSlot are no longer the bytes now on disk.
  fault?.("FILE_FSYNC");
  await persistFileDurably(
    join(slotRoot, RECOVERY_ANCHOR_SLOT_MANIFEST_NAME),
    slotManifestBytes(prepared),
  );

  fault?.("DIRECTORY_PERSISTENCE");
  await persistSlotDurably(slotRoot, request);

  fault?.("VERIFICATION");
  const unverifiable = await verifySlot(slotRoot, request.projectId);
  if (unverifiable !== null) return unverifiable;

  // ONE atomic switch. Until this rename lands every reader resolves the prior
  // slot; after it, every reader resolves the verified restored one.
  fault?.("SWITCH");
  const switched = resealAnchorRecord(prepared, { currentSlot: prepared.targetSlot });
  await publishFileAtomically(anchorPath(request.anchorRoot), encodeAnchorRecord(switched));

  fault?.("INSTALLED_MARKER");
  return markInstalled(anchorPath(request.anchorRoot), switched);
}
