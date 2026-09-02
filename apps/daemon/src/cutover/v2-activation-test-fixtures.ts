import { SQLITE_SCHEMA_MANIFEST_VERSION } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";

import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId, encodeCutoverActivationMarker,
} from "./cutover-activation-marker.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId, digestV2ReadinessManifest, encodeV2ReadinessManifest,
} from "./v2-readiness-manifest.js";
import type { V2ReadinessManifest } from "./v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "./v2-surface-manifest.js";

/**
 * "After the marker commits", as a DIRECT store fact for arms whose subject is what a
 * running process does once `/2` is authoritative: the exact-current readiness manifest
 * and the activation marker that binds it, committed through the production codecs on
 * the production aggregate ids. This is the same recipe
 * `daemon-store-command-authority-plane.test.ts` drills the `/bootstrap` plane with.
 * The path THROUGH `cutover.activate` is proven separately, over the shipped
 * composition, in `daemon-store-cutover-activation.test.ts`.
 */

const hex = (digit: string): string => digit.repeat(64);

export const FIXTURE_SOURCE_COMMIT = "a".repeat(40);

export const FIXTURE_GENERATIONS = Object.freeze({
  backupGenerationDigest: hex("1"),
  distributionManifestSha256: hex("2"),
  importGenerationSha256: hex("3"),
  quiesceRecordSha256: hex("4"),
});

function readiness(): V2ReadinessManifest {
  return {
    acceptanceEvidenceSha256: hex("5"),
    backupEvidenceSha256: hex("6"),
    ...FIXTURE_GENERATIONS,
    contractSchemaSha256: hex("7"),
    deliveryProfileQualificationEvidenceSha256: hex("8"),
    restoreDrillSha256: hex("9"),
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
    securityEvidenceSha256: hex("a"),
    sourceCommit: FIXTURE_SOURCE_COMMIT,
    storeMigrationEvidenceSha256: hex("b"),
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: hex("c"),
  };
}

function commitFirstEvent(
  store: SqliteEventStore, aggregateId: string, commandId: string, eventType: string,
  schemaVersion: string, payload: Uint8Array,
): void {
  store.commit({
    aggregateId, commandBytes: payload, commandId, committedAt: "2026-09-02T12:00:00.000Z",
    events: [{ domainSchemaVersion: schemaVersion, eventId: `${commandId}-event`, eventType, payload }],
    expectedVersion: 0,
  });
}

/** Commits the activation marker naming `readinessManifestSha256`; a foreign digest is NOT V2. */
export function commitCutoverMarker(
  store: SqliteEventStore, projectId: string, readinessManifestSha256: string,
): void {
  const composed = composeCutoverActivationMarker({
    activatedAtEpochMs: 1, generations: FIXTURE_GENERATIONS, readinessManifestSha256,
    readinessManifestVersion: 1, sourceCommit: FIXTURE_SOURCE_COMMIT,
    sourceState: "ACTIVATE_APPROVED",
  });
  if (!composed.ok) throw new Error("activation marker fixture refused");
  commitFirstEvent(store, deriveCutoverActivationMarkerAggregateId(projectId), "activation-v2",
    CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composed.marker.schemaVersion,
    encodeCutoverActivationMarker(composed.marker));
}

/** Readiness manifest + the marker that binds it: `admitV2ActiveInstallation` admits after this. */
export function activateV2Directly(store: SqliteEventStore, projectId: string): void {
  const manifest = readiness();
  commitFirstEvent(store, deriveV2ReadinessManifestAggregateId(projectId), "readiness-v2",
    V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
    encodeV2ReadinessManifest(manifest));
  commitCutoverMarker(store, projectId, digestV2ReadinessManifest(manifest));
}
