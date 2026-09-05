import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import { SQLITE_SCHEMA_MANIFEST_VERSION } from "@moe/store";
import type { StoredEvent } from "@moe/store";

import { V2_SURFACE_MANIFEST_SHA256 } from "./v2-surface-manifest.js";

export const V2_READINESS_MANIFEST_SCHEMA_VERSION = "moe-v2-readiness-manifest/1" as const;
export const V2_READINESS_MANIFEST_EVENT_TYPE = "V2ReadinessManifestWritten" as const;
export const V2_READINESS_MANIFEST_LAYER = "DAEMON_V2_READINESS_MANIFEST" as const;

export const V2_READINESS_MANIFEST_CODES = Object.freeze([
  "V2_READINESS_MANIFEST_ABSENT",
  "V2_READINESS_MANIFEST_INVALID",
  "V2_READINESS_MANIFEST_NONCANONICAL",
  "V2_READINESS_MANIFEST_STATIC_PIN_MISMATCH",
  "V2_READINESS_MANIFEST_UNREADABLE",
] as const);
export type V2ReadinessManifestCode = (typeof V2_READINESS_MANIFEST_CODES)[number];

export const V2_READINESS_MANIFEST_KEYS = Object.freeze([
  "acceptanceEvidenceSha256",
  "backupEvidenceSha256",
  "backupGenerationDigest",
  "contractSchemaSha256",
  "deliveryProfileQualificationEvidenceSha256",
  "distributionManifestSha256",
  "importGenerationSha256",
  "quiesceRecordSha256",
  "restoreDrillSha256",
  "schemaVersion",
  "securityEvidenceSha256",
  "sourceCommit",
  "storeMigrationEvidenceSha256",
  "storeSchemaVersion",
  "surfaceManifestSha256",
  "windowsPackagingEvidenceSha256",
] as const);

export interface V2ReadinessManifest {
  readonly acceptanceEvidenceSha256: string;
  readonly backupEvidenceSha256: string;
  readonly backupGenerationDigest: string;
  readonly contractSchemaSha256: string;
  readonly deliveryProfileQualificationEvidenceSha256: string;
  readonly distributionManifestSha256: string;
  readonly importGenerationSha256: string;
  readonly quiesceRecordSha256: string;
  readonly restoreDrillSha256: string;
  readonly schemaVersion: typeof V2_READINESS_MANIFEST_SCHEMA_VERSION;
  readonly securityEvidenceSha256: string;
  readonly sourceCommit: string;
  readonly storeMigrationEvidenceSha256: string;
  /** The store schema the evidence was written for — the running build's under CURRENT pins. */
  readonly storeSchemaVersion: string;
  readonly surfaceManifestSha256: string;
  readonly windowsPackagingEvidenceSha256: string;
}

export interface V2ReadinessManifestRefused {
  readonly code: V2ReadinessManifestCode;
  readonly layer: typeof V2_READINESS_MANIFEST_LAYER;
  readonly ok: false;
}

export interface V2ReadinessManifestPresent {
  readonly digest: string;
  readonly manifest: V2ReadinessManifest;
  readonly ok: true;
  /** Whether the recorded static pins are the running build's. Always true under CURRENT pins. */
  readonly pinsMatch: boolean;
  /** The exact aggregate version observed with these bytes and fenced by cutover.activate. */
  readonly version: number;
}

export type V2ReadinessManifestDecodeResult =
  | { readonly manifest: V2ReadinessManifest; readonly ok: true; readonly pinsMatch: boolean }
  | V2ReadinessManifestRefused;
export type V2ReadinessManifestReadResult =
  | V2ReadinessManifestPresent
  | V2ReadinessManifestRefused;

export interface V2ReadinessManifestStore {
  readEvents(aggregateId: string): readonly StoredEvent[];
}

function refuse(code: V2ReadinessManifestCode): V2ReadinessManifestRefused {
  return Object.freeze({ code, layer: V2_READINESS_MANIFEST_LAYER, ok: false as const });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

const HEX64 = /^[0-9a-f]{64}$/u;
const COMMIT40 = /^[0-9a-f]{40}$/u;
const DIGEST_KEYS = V2_READINESS_MANIFEST_KEYS.filter((key) => key.endsWith("Sha256")
  || key === "backupGenerationDigest");

/** Fixed field order: the digest always names this exact release-evidence tuple. */
export function encodeV2ReadinessManifest(manifest: V2ReadinessManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    acceptanceEvidenceSha256: manifest.acceptanceEvidenceSha256,
    backupEvidenceSha256: manifest.backupEvidenceSha256,
    backupGenerationDigest: manifest.backupGenerationDigest,
    contractSchemaSha256: manifest.contractSchemaSha256,
    deliveryProfileQualificationEvidenceSha256: manifest.deliveryProfileQualificationEvidenceSha256,
    distributionManifestSha256: manifest.distributionManifestSha256,
    importGenerationSha256: manifest.importGenerationSha256,
    quiesceRecordSha256: manifest.quiesceRecordSha256,
    restoreDrillSha256: manifest.restoreDrillSha256,
    schemaVersion: manifest.schemaVersion,
    securityEvidenceSha256: manifest.securityEvidenceSha256,
    sourceCommit: manifest.sourceCommit,
    storeMigrationEvidenceSha256: manifest.storeMigrationEvidenceSha256,
    storeSchemaVersion: manifest.storeSchemaVersion,
    surfaceManifestSha256: manifest.surfaceManifestSha256,
    windowsPackagingEvidenceSha256: manifest.windowsPackagingEvidenceSha256,
  }));
}

export function digestV2ReadinessManifest(manifest: V2ReadinessManifest): string {
  return createHash("sha256").update(encodeV2ReadinessManifest(manifest)).digest("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * Which static pins a decode holds the bytes to.
 *
 * `CURRENT` (the default) requires the running build's store schema and v2 surface: the
 * writer and cutover.activate must never bind a marker to evidence for another build.
 * `RECORDED` accepts the pins the manifest was written with and reports whether they match the
 * running build. It exists for ONE reader, the post-activation marker binding: after a build
 * pin bump every readiness read used to refuse STATIC_PIN_MISMATCH, the marker no longer bound,
 * v2 answered "not active" and v1 answered "status unknown" — an activated project locked out
 * of both authority planes with no in-band re-cutover. The marker still binds the manifest's
 * digest, source commit and four generations, so what it proves is unchanged.
 */
export type V2ReadinessPinPolicy = "CURRENT" | "RECORDED";

export function decodeV2ReadinessManifest(
  bytes: unknown, pins: V2ReadinessPinPolicy = "CURRENT",
): V2ReadinessManifestDecodeResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !exactKeys(decoded.value, V2_READINESS_MANIFEST_KEYS)) {
    return refuse("V2_READINESS_MANIFEST_INVALID");
  }
  const value = decoded.value;
  if (value["schemaVersion"] !== V2_READINESS_MANIFEST_SCHEMA_VERSION
    || typeof value["sourceCommit"] !== "string" || !COMMIT40.test(value["sourceCommit"])
    || typeof value["storeSchemaVersion"] !== "string" || value["storeSchemaVersion"] === ""
    || !DIGEST_KEYS.every((key) => typeof value[key] === "string" && HEX64.test(value[key]))) {
    return refuse("V2_READINESS_MANIFEST_INVALID");
  }
  const pinsMatch = value["storeSchemaVersion"] === SQLITE_SCHEMA_MANIFEST_VERSION
    && value["surfaceManifestSha256"] === V2_SURFACE_MANIFEST_SHA256;
  if (pins === "CURRENT" && !pinsMatch) {
    return refuse("V2_READINESS_MANIFEST_STATIC_PIN_MISMATCH");
  }
  const manifest: V2ReadinessManifest = Object.freeze({
    acceptanceEvidenceSha256: value["acceptanceEvidenceSha256"] as string,
    backupEvidenceSha256: value["backupEvidenceSha256"] as string,
    backupGenerationDigest: value["backupGenerationDigest"] as string,
    contractSchemaSha256: value["contractSchemaSha256"] as string,
    deliveryProfileQualificationEvidenceSha256:
      value["deliveryProfileQualificationEvidenceSha256"] as string,
    distributionManifestSha256: value["distributionManifestSha256"] as string,
    importGenerationSha256: value["importGenerationSha256"] as string,
    quiesceRecordSha256: value["quiesceRecordSha256"] as string,
    restoreDrillSha256: value["restoreDrillSha256"] as string,
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
    securityEvidenceSha256: value["securityEvidenceSha256"] as string,
    sourceCommit: value["sourceCommit"],
    storeMigrationEvidenceSha256: value["storeMigrationEvidenceSha256"] as string,
    // The RECORDED pins: under CURRENT they equal the running build's (checked above), so the
    // canonical-bytes comparison below still holds the bytes to exactly what was written.
    storeSchemaVersion: value["storeSchemaVersion"],
    surfaceManifestSha256: value["surfaceManifestSha256"] as string,
    windowsPackagingEvidenceSha256: value["windowsPackagingEvidenceSha256"] as string,
  });
  if (!(bytes instanceof Uint8Array) || !sameBytes(bytes, encodeV2ReadinessManifest(manifest))) {
    return refuse("V2_READINESS_MANIFEST_NONCANONICAL");
  }
  return Object.freeze({ manifest, ok: true as const, pinsMatch });
}

const READINESS_AGGREGATE_NAMESPACE = "v2-readiness-manifest.v1|aggregate|";
const MAX_STORE_IDENTIFIER_UTF8_BYTES = 512;

/** Project-derived only: neither an activation request nor a readiness payload nominates it. */
export function deriveV2ReadinessManifestAggregateId(projectId: string): string {
  const direct = `${READINESS_AGGREGATE_NAMESPACE}${projectId.length}:${projectId}`;
  if (Buffer.byteLength(direct, "utf8") <= MAX_STORE_IDENTIFIER_UTF8_BYTES) return direct;
  const digest = createHash("sha256").update(direct, "utf8").digest("hex");
  return `${READINESS_AGGREGATE_NAMESPACE}sha256:${digest}`;
}

/**
 * Reads exactly one immutable readiness event. There is intentionally no sibling writer in the
 * request plane: until release tooling persists real evidence, the authoritative path is inert.
 */
export function readV2ReadinessManifest(
  store: V2ReadinessManifestStore,
  input: Readonly<{ projectId: string; pins?: V2ReadinessPinPolicy }>,
): V2ReadinessManifestReadResult {
  let events: readonly StoredEvent[];
  try {
    events = store.readEvents(deriveV2ReadinessManifestAggregateId(input.projectId));
  } catch {
    return refuse("V2_READINESS_MANIFEST_UNREADABLE");
  }
  if (events.length === 0) return refuse("V2_READINESS_MANIFEST_ABSENT");
  if (events.length !== 1) return refuse("V2_READINESS_MANIFEST_INVALID");
  const event = events[0];
  if (event === undefined || event.eventType !== V2_READINESS_MANIFEST_EVENT_TYPE
    || event.aggregateSequence !== 1) return refuse("V2_READINESS_MANIFEST_INVALID");
  const decoded = decodeV2ReadinessManifest(event.payload, input.pins ?? "CURRENT");
  if (!decoded.ok) return decoded;
  return Object.freeze({
    digest: digestV2ReadinessManifest(decoded.manifest),
    manifest: decoded.manifest,
    ok: true as const,
    pinsMatch: decoded.pinsMatch,
    version: event.aggregateSequence,
  });
}
