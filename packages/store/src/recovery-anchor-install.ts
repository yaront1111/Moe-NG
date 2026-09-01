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
  RECOVERY_ANCHOR_REQUEST_INVALID,
  RECOVERY_ANCHOR_SLOTS_DIR_NAME,
  RECOVERY_ANCHOR_SLOT_MANIFEST_NAME,
  RECOVERY_ANCHOR_SLOT_UNVERIFIABLE,
  RECOVERY_ANCHOR_UNREADABLE,
} from "./recovery-anchor-contracts.js";
import type {
  RecoveryAnchorInstallResult,
  RecoveryAnchorRecord,
  RecoveryAnchorRefused,
  RecoveryBindingSlotName,
} from "./recovery-anchor-contracts.js";
import {
  clearDirectory,
  digestBytes,
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
import {
  decodeRecoverySlotManifest,
  encodeRecoverySlotManifestV2,
} from "./recovery-slot-manifest.js";
import type { RecoverySlotManifestDecoded } from "./recovery-slot-manifest.js";

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

/**
 * `databaseDigest` is supplied by the caller rather than read off the anchor:
 * the anchor digests the payload as delivered, and the slot's database stops
 * being those bytes the moment the install transaction stamps it.
 */
function slotManifestBytes(anchor: RecoveryAnchorRecord, databaseDigest: string): Uint8Array | null {
  const encoded = encodeRecoverySlotManifestV2({
    databaseDigest,
    generationDigest: anchor.generationDigest,
    incarnationRef: anchor.incarnationRef,
    keyEpochRef: anchor.keyEpochRef,
    payloadDigests: anchor.payloadDigests,
  });
  return encoded.ok ? encoded.bytes : null;
}

/** The digest of the database file as it sits in the slot, or null if unreadable. */
async function digestSlotDatabase(slotRoot: string): Promise<string | null> {
  const bytes = await readFileIfReadable(join(slotRoot, RECOVERY_ANCHOR_DATABASE_NAME));
  return bytes === null ? null : digestBytes(bytes);
}

async function readSlotManifest(slotRoot: string): Promise<RecoverySlotManifestDecoded | null> {
  const bytes = await readFileIfReadable(join(slotRoot, RECOVERY_ANCHOR_SLOT_MANIFEST_NAME));
  if (bytes === null) return null;
  const decoded = decodeRecoverySlotManifest(bytes);
  return decoded.ok ? decoded : null;
}

/** Stamps the fresh incarnation and key epoch into the RESTORED database only. */
function stampIncarnation(
  slotRoot: string,
  request: RecoveryAnchorRequest,
): RecoveryAnchorInstallResult | null {
  // Opening the restored database is where a delivered payload is first judged: it
  // migrates, validates and can refuse. Those refusals are facts about the PAYLOAD, so
  // they belong in this function's typed result - a rejected promise here would make a
  // caller handle a durable-store throw that no other install failure produces.
  // The code is the one this file already uses for a slot database it cannot open and
  // read back, so nothing new enters the RECOVERY_ANCHOR roster.
  let store;
  try {
    store = SqliteEventStore.openForProject(
      join(slotRoot, RECOVERY_ANCHOR_DATABASE_NAME),
      request.projectId,
    );
  } catch {
    return RECOVERY_ANCHOR_SLOT_UNVERIFIABLE;
  }
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
  const decoded = await readSlotManifest(slotRoot);
  if (decoded === null) return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
  const manifest = decoded.manifest;

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
  // Historical /1 had no database-byte authority. Its nonempty artifact proof
  // is therefore mandatory; /2 may represent a database-only restore because
  // its databaseDigest covers the required payload directly.
  if (decoded.kind === "LEGACY_V1" && entries.length === 0) {
    return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
  }
  for (const [logicalPath, digest] of entries) {
    if (!(await readBackMatches(artifactPath(slotRoot, logicalPath), digest))) {
      return RECOVERY_ANCHOR_SLOT_UNVERIFIABLE;
    }
  }

  const databasePath = join(slotRoot, RECOVERY_ANCHOR_DATABASE_NAME);
  if (decoded.kind === "DIGEST_BOUND_V2" || decoded.kind === "LEGACY_V1_DIGEST") {
    // Absent is "no proof"; present-but-different is "bytes disagree with the
    // proof". Check before SQLite opens so malformed database bytes are answered
    // rather than raised.
    const observedDatabaseDigest = await digestSlotDatabase(slotRoot);
    if (observedDatabaseDigest === null) return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
    if (observedDatabaseDigest !== decoded.manifest.databaseDigest) {
      return RECOVERY_ANCHOR_SLOT_UNVERIFIABLE;
    }
  } else if ((await readFileIfReadable(databasePath)) === null) {
    return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
  }

  try {
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
  } catch {
    return RECOVERY_ANCHOR_SLOT_UNVERIFIABLE;
  }
  return null;
}

async function writeInactiveSlot(
  slotRoot: string,
  request: RecoveryAnchorRequest,
  anchor: RecoveryAnchorRecord,
): Promise<RecoveryAnchorRefused | null> {
  const manifestBytes = slotManifestBytes(anchor, anchor.databaseDigest);
  if (manifestBytes === null) return RECOVERY_ANCHOR_REQUEST_INVALID;
  await clearDirectory(slotRoot);
  await persistFileDurably(join(slotRoot, RECOVERY_ANCHOR_DATABASE_NAME), request.databaseBytes);
  for (const artifact of request.artifacts) {
    await persistFileDurably(artifactPath(slotRoot, artifact.logicalPath), artifact.bytes);
  }
  // Truthful for exactly this instant: the bytes just written ARE the
  // delivered payload. The post-stamp rewrite in runInstall replaces it.
  await persistFileDurably(
    join(slotRoot, RECOVERY_ANCHOR_SLOT_MANIFEST_NAME),
    manifestBytes,
  );
  return null;
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
  const unwritable = await writeInactiveSlot(slotRoot, request, prepared);
  if (unwritable !== null) return unwritable;

  fault?.("TRANSACTION");
  const stamped = stampIncarnation(slotRoot, request);
  if (stamped !== null) return stamped;

  // The transaction reopened and wrote the database, so the bytes flushed
  // during writeInactiveSlot are no longer the bytes now on disk, and neither
  // is their digest. The proof is re-taken from the file as it now sits, and a
  // file that cannot be read back yields no proof to write at all.
  fault?.("FILE_FSYNC");
  const stampedDatabaseDigest = await digestSlotDatabase(slotRoot);
  if (stampedDatabaseDigest === null) return RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN;
  const manifestBytes = slotManifestBytes(prepared, stampedDatabaseDigest);
  if (manifestBytes === null) return RECOVERY_ANCHOR_REQUEST_INVALID;
  await persistFileDurably(
    join(slotRoot, RECOVERY_ANCHOR_SLOT_MANIFEST_NAME),
    manifestBytes,
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
