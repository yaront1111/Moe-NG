import { types } from "node:util";

import { MAX_IDENTIFIER_UTF8_BYTES, stringIsWellFormed } from "./store-internals.js";

export const LEGACY_RECOVERY_SLOT_MANIFEST_VERSION = "moe-recovery-slot/1" as const;
export const RECOVERY_SLOT_MANIFEST_VERSION = "moe-recovery-slot/2" as const;
export const MAX_RECOVERY_SLOT_MANIFEST_BYTES = 65_536;

const LAYER = "RECOVERY_SLOT_MANIFEST" as const;
const SHA256 = /^[0-9a-f]{64}$/u;
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
const V2_INPUT_KEYS = Object.freeze(V2_KEYS.slice(0, -1));
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;

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

function isPlainRecord(value: unknown): value is object {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string")) return null;
  if (expectedKeys.some((key) => !keys.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_UTF8_BYTES &&
    Reflect.apply(stringIsWellFormed, value, []) &&
    !value.includes("\0") &&
    textEncoder.encode(value).byteLength <= MAX_IDENTIFIER_UTF8_BYTES
  );
}

function safePayloadPath(value: string): boolean {
  if (!boundedIdentifier(value) || value.startsWith("/") || value.includes("\\")) return false;
  if (/^[a-zA-Z]:\//u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function readPayloadDigests(value: unknown, requireNonempty: boolean): Readonly<Record<string, string>> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (requireNonempty && keys.length === 0) return null;
  if (keys.some((key) => typeof key !== "string" || !safePayloadPath(key))) return null;
  const copy: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of [...keys].sort() as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    if (typeof descriptor.value !== "string" || !SHA256.test(descriptor.value)) return null;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
}

function readCommon(
  source: Readonly<Record<string, unknown>>,
  requirePayload: boolean,
): Readonly<Omit<LegacyRecoverySlotManifest, "slotManifestVersion">> | null {
  const generationDigest = source["generationDigest"];
  const incarnationRef = source["incarnationRef"];
  const keyEpochRef = source["keyEpochRef"];
  const payloadDigests = readPayloadDigests(source["payloadDigests"], requirePayload);
  if (!boundedIdentifier(generationDigest) || !boundedIdentifier(incarnationRef) ||
      !boundedIdentifier(keyEpochRef) || incarnationRef === keyEpochRef || payloadDigests === null) return null;
  return { generationDigest, incarnationRef, keyEpochRef, payloadDigests };
}

function readLegacy(value: unknown): LegacyRecoverySlotManifest | null {
  const source = exactDataRecord(value, V1_KEYS);
  if (source === null || source["slotManifestVersion"] !== LEGACY_RECOVERY_SLOT_MANIFEST_VERSION) return null;
  const common = readCommon(source, true);
  return common === null ? null : Object.freeze({ ...common, slotManifestVersion: LEGACY_RECOVERY_SLOT_MANIFEST_VERSION });
}

function readDigestBound(value: unknown): DigestBoundRecoverySlotManifest | null {
  const source = exactDataRecord(value, V2_KEYS);
  if (source === null || source["slotManifestVersion"] !== RECOVERY_SLOT_MANIFEST_VERSION) return null;
  const common = readCommon(source, false);
  const databaseDigest = source["databaseDigest"];
  if (common === null || typeof databaseDigest !== "string" || !SHA256.test(databaseDigest)) return null;
  return Object.freeze({ databaseDigest, ...common, slotManifestVersion: RECOVERY_SLOT_MANIFEST_VERSION });
}

function readV2Input(value: unknown): DigestBoundRecoverySlotManifest | null {
  const source = exactDataRecord(value, V2_INPUT_KEYS);
  if (source === null) return null;
  return readDigestBound({ ...source, slotManifestVersion: RECOVERY_SLOT_MANIFEST_VERSION });
}

function snapshotBytes(value: unknown): Uint8Array | null {
  if (value === null || typeof value !== "object" || types.isProxy(value) || !types.isUint8Array(value)) return null;
  if (bufferGetter === undefined || byteLengthGetter === undefined || byteOffsetGetter === undefined) return null;
  const buffer = Reflect.apply(bufferGetter, value, []) as ArrayBufferLike;
  if (!types.isAnyArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) return null;
  const byteLength = Reflect.apply(byteLengthGetter, value, []) as number;
  const byteOffset = Reflect.apply(byteOffsetGetter, value, []) as number;
  if (byteLength === 0 || byteLength > MAX_RECOVERY_SLOT_MANIFEST_BYTES) return null;
  const snapshot = new Uint8Array(byteLength);
  snapshot.set(new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength));
  return snapshot;
}

function parseManifest(text: string): LegacyRecoverySlotManifest | DigestBoundRecoverySlotManifest | null {
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
    return manifest.slotManifestVersion === LEGACY_RECOVERY_SLOT_MANIFEST_VERSION
      ? Object.freeze({ ok: true, kind: "LEGACY_V1", manifest })
      : Object.freeze({ ok: true, kind: "DIGEST_BOUND_V2", manifest });
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
