import {
  MAX_RECOVERY_SLOT_MANIFEST_BYTES,
  RECOVERY_SLOT_SHA256,
  boundedIdentifier,
  exactDataRecord,
  isPlainRecord,
  readPayloadDigests,
  snapshotBytes,
} from "./recovery-slot-manifest-fields.js";

export { MAX_RECOVERY_SLOT_MANIFEST_BYTES } from "./recovery-slot-manifest-fields.js";

export const LEGACY_RECOVERY_SLOT_MANIFEST_VERSION = "moe-recovery-slot/1" as const;
export const RECOVERY_SLOT_MANIFEST_VERSION = "moe-recovery-slot/2" as const;

const LAYER = "RECOVERY_SLOT_MANIFEST" as const;
const V1_KEYS = Object.freeze([
  "generationDigest",
  "incarnationRef",
  "keyEpochRef",
  "payloadDigests",
  "slotManifestVersion",
] as const);
const V2_KEYS = Object.freeze([
  "databaseDigest",
  "generationDigest",
  "incarnationRef",
  "keyEpochRef",
  "payloadDigests",
  "slotManifestVersion",
] as const);
const V1_DIGEST_KEYS = Object.freeze([...V2_KEYS]);
const V2_INPUT_KEYS = Object.freeze(V2_KEYS.slice(0, -1));
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export interface LegacyRecoverySlotManifest {
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payloadDigests: Readonly<Record<string, string>>;
  readonly slotManifestVersion: typeof LEGACY_RECOVERY_SLOT_MANIFEST_VERSION;
}

export interface DigestBoundRecoverySlotManifest {
  readonly databaseDigest: string;
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payloadDigests: Readonly<Record<string, string>>;
  readonly slotManifestVersion: typeof RECOVERY_SLOT_MANIFEST_VERSION;
}

export interface DigestBearingLegacyRecoverySlotManifest {
  readonly databaseDigest: string;
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payloadDigests: Readonly<Record<string, string>>;
  readonly slotManifestVersion: typeof LEGACY_RECOVERY_SLOT_MANIFEST_VERSION;
}

export interface RecoverySlotManifestV2Input {
  readonly databaseDigest: string;
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payloadDigests: Readonly<Record<string, string>>;
}

export interface RecoverySlotManifestRefused {
  readonly code: "RECOVERY_SLOT_MANIFEST_INVALID";
  readonly layer: typeof LAYER;
  readonly ok: false;
  readonly outcome: "REFUSED";
}

export type RecoverySlotManifestDecoded =
  | Readonly<{ ok: true; kind: "LEGACY_V1"; manifest: LegacyRecoverySlotManifest }>
  | Readonly<{
      ok: true;
      kind: "LEGACY_V1_DIGEST";
      manifest: DigestBearingLegacyRecoverySlotManifest;
    }>
  | Readonly<{ ok: true; kind: "DIGEST_BOUND_V2"; manifest: DigestBoundRecoverySlotManifest }>;
export type RecoverySlotManifestDecodeResult =
  | RecoverySlotManifestDecoded
  | RecoverySlotManifestRefused;
export type RecoverySlotManifestEncodeResult =
  | Readonly<{ ok: true; bytes: Uint8Array; manifest: DigestBoundRecoverySlotManifest }>
  | RecoverySlotManifestRefused;

const REFUSED: RecoverySlotManifestRefused = Object.freeze({
  code: "RECOVERY_SLOT_MANIFEST_INVALID",
  layer: LAYER,
  ok: false,
  outcome: "REFUSED",
});

function readCommon(
  source: Readonly<Record<string, unknown>>,
  requirePayload: boolean,
  sortPayloadPaths: boolean,
): Readonly<Omit<LegacyRecoverySlotManifest, "slotManifestVersion">> | null {
  const generationDigest = source["generationDigest"];
  const incarnationRef = source["incarnationRef"];
  const keyEpochRef = source["keyEpochRef"];
  const payloadDigests = readPayloadDigests(
    source["payloadDigests"],
    requirePayload,
    sortPayloadPaths,
  );
  if (!boundedIdentifier(generationDigest) || !boundedIdentifier(incarnationRef) ||
      !boundedIdentifier(keyEpochRef) || incarnationRef === keyEpochRef || payloadDigests === null) return null;
  return { generationDigest, incarnationRef, keyEpochRef, payloadDigests };
}

function readLegacy(
  value: unknown,
): LegacyRecoverySlotManifest | DigestBearingLegacyRecoverySlotManifest | null {
  const legacy = exactDataRecord(value, V1_KEYS);
  if (legacy !== null) {
    if (legacy["slotManifestVersion"] !== LEGACY_RECOVERY_SLOT_MANIFEST_VERSION) return null;
    // Historical five-key /1 wrote artifact keys in caller insertion order.
    const common = readCommon(legacy, true, false);
    return common === null
      ? null
      : Object.freeze({ ...common, slotManifestVersion: LEGACY_RECOVERY_SLOT_MANIFEST_VERSION });
  }

  const digestBearing = exactDataRecord(value, V1_DIGEST_KEYS);
  if (
    digestBearing === null ||
    digestBearing["slotManifestVersion"] !== LEGACY_RECOVERY_SLOT_MANIFEST_VERSION
  ) {
    return null;
  }
  const common = readCommon(digestBearing, false, false);
  const databaseDigest = digestBearing["databaseDigest"];
  if (
    common === null ||
    typeof databaseDigest !== "string" ||
    !RECOVERY_SLOT_SHA256.test(databaseDigest)
  ) {
    return null;
  }
  return Object.freeze({
    databaseDigest,
    ...common,
    slotManifestVersion: LEGACY_RECOVERY_SLOT_MANIFEST_VERSION,
  });
}

function readDigestBound(value: unknown): DigestBoundRecoverySlotManifest | null {
  const source = exactDataRecord(value, V2_KEYS);
  if (source === null || source["slotManifestVersion"] !== RECOVERY_SLOT_MANIFEST_VERSION) return null;
  const common = readCommon(source, false, true);
  const databaseDigest = source["databaseDigest"];
  if (
    common === null ||
    typeof databaseDigest !== "string" ||
    !RECOVERY_SLOT_SHA256.test(databaseDigest)
  ) {
    return null;
  }
  return Object.freeze({ databaseDigest, ...common, slotManifestVersion: RECOVERY_SLOT_MANIFEST_VERSION });
}

function readV2Input(value: unknown): DigestBoundRecoverySlotManifest | null {
  const source = exactDataRecord(value, V2_INPUT_KEYS);
  if (source === null) return null;
  return readDigestBound({ ...source, slotManifestVersion: RECOVERY_SLOT_MANIFEST_VERSION });
}

function parseManifest(
  text: string,
): LegacyRecoverySlotManifest | DigestBearingLegacyRecoverySlotManifest | DigestBoundRecoverySlotManifest | null {
  const parsed: unknown = JSON.parse(text);
  const versionRecord = exactDataRecordWithVersion(parsed);
  if (versionRecord === null) return null;
  if (versionRecord.version === LEGACY_RECOVERY_SLOT_MANIFEST_VERSION) return readLegacy(parsed);
  if (versionRecord.version === RECOVERY_SLOT_MANIFEST_VERSION) return readDigestBound(parsed);
  return null;
}

function exactDataRecordWithVersion(value: unknown): { readonly version: unknown } | null {
  if (!isPlainRecord(value)) return null;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, "slotManifestVersion");
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
    ? { version: descriptor.value }
    : null;
}

export function decodeRecoverySlotManifest(input: unknown): RecoverySlotManifestDecodeResult {
  try {
    const snapshot = snapshotBytes(input);
    if (snapshot === null) return REFUSED;
    const text = textDecoder.decode(snapshot);
    const manifest = parseManifest(text);
    if (manifest === null || JSON.stringify(manifest) !== text) return REFUSED;
    if (manifest.slotManifestVersion === LEGACY_RECOVERY_SLOT_MANIFEST_VERSION) {
      return "databaseDigest" in manifest
        ? Object.freeze({ ok: true, kind: "LEGACY_V1_DIGEST", manifest })
        : Object.freeze({ ok: true, kind: "LEGACY_V1", manifest });
    }
    return Object.freeze({ ok: true, kind: "DIGEST_BOUND_V2", manifest });
  } catch {
    return REFUSED;
  }
}

export function encodeRecoverySlotManifestV2(input: unknown): RecoverySlotManifestEncodeResult {
  try {
    const manifest = readV2Input(input);
    if (manifest === null) return REFUSED;
    const bytes = textEncoder.encode(JSON.stringify(manifest));
    if (bytes.byteLength > MAX_RECOVERY_SLOT_MANIFEST_BYTES) return REFUSED;
    return Object.freeze({ ok: true, bytes, manifest });
  } catch {
    return REFUSED;
  }
}
