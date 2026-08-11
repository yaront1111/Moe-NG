/**
 * Request validation, identity and the on-disk form of the anchor record.
 *
 * Split from recovery-anchor.ts so the install protocol there stays readable;
 * the prerequisite split sqlite-schema-recovery-manifest.ts out of
 * sqlite-schema-manifest.ts for the same reason.
 */
import { digestBytes } from "./recovery-anchor-fs.js";
import {
  RECOVERY_ANCHOR_CODEC_VERSION,
  RECOVERY_ANCHOR_CODEC_VERSION_UNSUPPORTED,
  RECOVERY_ANCHOR_DIGEST_MISMATCH,
  RECOVERY_ANCHOR_REQUEST_INVALID,
} from "./recovery-anchor-contracts.js";
import type {
  RecoveryAnchorArtifact,
  RecoveryAnchorRecord,
  RecoveryAnchorRefused,
  RecoveryAnchorState,
  RecoveryBindingSlotName,
} from "./recovery-anchor-contracts.js";

const encoder = new TextEncoder();

export interface RecoveryAnchorRequest {
  readonly anchorRoot: string;
  readonly artifacts: readonly RecoveryAnchorArtifact[];
  readonly databaseBytes: Uint8Array;
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly injectFault: ((point: string) => void) | null;
  readonly keyEpochRef: string;
  readonly preparedAt: string;
  readonly projectId: string;
  readonly restoreCommandId: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * A logical path that could escape its slot is refused before anything is
 * written. Backslashes are rejected outright rather than normalised: on win32
 * "a\\b" and "a/b" resolve to the SAME file while comparing as different
 * strings, so the duplicate-path check below would pass and one artifact would
 * silently overwrite the other — and still verify, because only the survivor is
 * ever read back.
 */
function safeLogicalPath(value: unknown): value is string {
  return (
    nonEmptyString(value) &&
    !value.startsWith("/") &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !/^[a-zA-Z]:/u.test(value)
  );
}

function readArtifacts(value: unknown): readonly RecoveryAnchorArtifact[] | null {
  if (!Array.isArray(value)) return null;
  const artifacts: RecoveryAnchorArtifact[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const candidate = entry as Record<string, unknown>;
    const bytes = candidate["bytes"];
    if (!(bytes instanceof Uint8Array) || !safeLogicalPath(candidate["logicalPath"])) return null;
    artifacts.push(Object.freeze({ bytes, logicalPath: candidate["logicalPath"] }));
  }
  // Duplicate logical paths would let one artifact silently overwrite another
  // and still verify, because only the survivor is ever read back.
  if (new Set(artifacts.map((entry) => entry.logicalPath)).size !== artifacts.length) return null;
  return Object.freeze(artifacts);
}

export function readAnchorRequest(input: unknown): RecoveryAnchorRequest | RecoveryAnchorRefused {
  if (input === null || typeof input !== "object") return RECOVERY_ANCHOR_REQUEST_INVALID;
  const source = input as Record<string, unknown>;
  const payload = source["payload"];
  if (payload === null || typeof payload !== "object") return RECOVERY_ANCHOR_REQUEST_INVALID;
  const payloadSource = payload as Record<string, unknown>;
  const databaseBytes = payloadSource["databaseBytes"];
  const artifacts = readArtifacts(payloadSource["artifacts"]);
  const injectFault = source["injectFault"];

  if (
    !nonEmptyString(source["anchorRoot"]) ||
    !nonEmptyString(source["generationDigest"]) ||
    !nonEmptyString(source["incarnationRef"]) ||
    !nonEmptyString(source["keyEpochRef"]) ||
    !nonEmptyString(source["preparedAt"]) ||
    !nonEmptyString(source["projectId"]) ||
    !nonEmptyString(source["restoreCommandId"]) ||
    !(databaseBytes instanceof Uint8Array) ||
    databaseBytes.byteLength === 0 ||
    artifacts === null ||
    (injectFault !== undefined && typeof injectFault !== "function")
  ) {
    return RECOVERY_ANCHOR_REQUEST_INVALID;
  }
  // The incarnation and the key epoch must be distinguishable values; a restore
  // that fenced itself with the same string twice has fenced nothing.
  if (source["incarnationRef"] === source["keyEpochRef"]) return RECOVERY_ANCHOR_REQUEST_INVALID;

  return Object.freeze({
    anchorRoot: source["anchorRoot"],
    artifacts,
    databaseBytes,
    generationDigest: source["generationDigest"],
    incarnationRef: source["incarnationRef"],
    injectFault: (injectFault as ((point: string) => void) | undefined) ?? null,
    keyEpochRef: source["keyEpochRef"],
    preparedAt: source["preparedAt"],
    projectId: source["projectId"],
    restoreCommandId: source["restoreCommandId"],
  });
}

/**
 * The fence. Binds the restore command to the exact generation, incarnation and
 * key epoch it was prepared for, and survives PREPARED -> INSTALLED unchanged
 * so a resume can prove it is the same attempt rather than a new one.
 */
export function computePreparedIdentity(request: RecoveryAnchorRequest): string {
  return digestBytes(
    encoder.encode(
      JSON.stringify([
        RECOVERY_ANCHOR_CODEC_VERSION,
        request.generationDigest,
        request.incarnationRef,
        request.keyEpochRef,
        request.preparedAt,
        request.restoreCommandId,
      ]),
    ),
  );
}

/** Every field except the digest itself, in a fixed order. */
function identityTuple(record: Omit<RecoveryAnchorRecord, "anchorDigest">): unknown[] {
  return [
    record.anchorCodecVersion,
    record.currentSlot,
    record.databaseDigest,
    record.generationDigest,
    record.incarnationRef,
    record.keyEpochRef,
    Object.entries(record.payloadDigests).sort(([left], [right]) => (left < right ? -1 : 1)),
    record.preparedAt,
    record.preparedIdentity,
    record.projectId,
    record.restoreCommandId,
    record.restoredAuthorityRevoked,
    record.restoredLifecycle,
    record.restoredReadiness,
    record.state,
    record.targetSlot,
  ];
}

export function sealAnchorRecord(
  draft: Omit<RecoveryAnchorRecord, "anchorDigest">,
): RecoveryAnchorRecord {
  return Object.freeze({
    ...draft,
    anchorDigest: digestBytes(encoder.encode(JSON.stringify(identityTuple(draft)))),
  });
}

export function buildAnchorRecord(
  request: RecoveryAnchorRequest,
  slots: { readonly current: RecoveryBindingSlotName; readonly target: RecoveryBindingSlotName },
  state: RecoveryAnchorState,
): RecoveryAnchorRecord {
  const payloadDigests: Record<string, string> = {};
  for (const artifact of request.artifacts) {
    payloadDigests[artifact.logicalPath] = digestBytes(artifact.bytes);
  }
  return sealAnchorRecord({
    anchorCodecVersion: RECOVERY_ANCHOR_CODEC_VERSION,
    currentSlot: slots.current,
    databaseDigest: digestBytes(request.databaseBytes),
    generationDigest: request.generationDigest,
    incarnationRef: request.incarnationRef,
    keyEpochRef: request.keyEpochRef,
    payloadDigests: Object.freeze(payloadDigests),
    preparedAt: request.preparedAt,
    preparedIdentity: computePreparedIdentity(request),
    projectId: request.projectId,
    restoreCommandId: request.restoreCommandId,
    restoredAuthorityRevoked: true,
    restoredLifecycle: "QUIESCED",
    restoredReadiness: "RECOVERY_REQUIRED",
    state,
    targetSlot: slots.target,
  });
}

/**
 * Re-derive the record's identity after a state or slot transition. The stale
 * digest is dropped rather than carried, so a transition can never publish a
 * record whose digest describes the record it used to be.
 */
export function resealAnchorRecord(
  record: RecoveryAnchorRecord,
  changes: Partial<RecoveryAnchorRecord>,
): RecoveryAnchorRecord {
  const { anchorDigest: _stale, ...draft } = record;
  return sealAnchorRecord({ ...draft, ...changes });
}

export function encodeAnchorRecord(record: RecoveryAnchorRecord): Uint8Array {
  return encoder.encode(JSON.stringify(record));
}

/**
 * Decode and re-derive. A stored anchor whose digest does not match its own
 * contents is refused whole rather than reconciled toward either side — the
 * same discipline the install layer applies to a diverged row.
 */
export function decodeAnchorRecord(bytes: Uint8Array): RecoveryAnchorRecord | RecoveryAnchorRefused {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return RECOVERY_ANCHOR_DIGEST_MISMATCH;
  }
  if (parsed === null || typeof parsed !== "object") return RECOVERY_ANCHOR_DIGEST_MISMATCH;
  const candidate = parsed as RecoveryAnchorRecord;
  if (candidate.anchorCodecVersion !== RECOVERY_ANCHOR_CODEC_VERSION) {
    return RECOVERY_ANCHOR_CODEC_VERSION_UNSUPPORTED;
  }
  const { anchorDigest, ...draft } = candidate;
  const resealed = sealAnchorRecord(draft as Omit<RecoveryAnchorRecord, "anchorDigest">);
  if (resealed.anchorDigest !== anchorDigest) return RECOVERY_ANCHOR_DIGEST_MISMATCH;
  return Object.freeze(candidate);
}
