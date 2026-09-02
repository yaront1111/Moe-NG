import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "@moe/store";
import { afterAll, expect, it } from "vitest";

import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId, encodeCutoverActivationMarker,
} from "./cutover/cutover-activation-marker.js";
import { admitV1AuthoritativeCommand } from "./cutover/cutover-v2-authority.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId, digestV2ReadinessManifest,
  encodeV2ReadinessManifest,
} from "./cutover/v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "./cutover/v2-surface-manifest.js";
import { createStoreDependencies } from "./daemon-store-foundation-composition.js";

/**
 * The plane `/bootstrap` states is the SHIPPED composition's answer over the real
 * store, not a fixture port's. Before any cutover marker it is V1, which is what
 * `/command` serves; the moment the exact current marker is committed it is V2,
 * read fresh on every call with nothing cached across the flip. A marker that
 * does not bind the current readiness manifest is NOT V2: it answers V1, the
 * plane whose gate then names the fault (V1_AUTHORITY_STATUS_UNKNOWN).
 */
interface World {
  readonly project: string;
  readonly provider: ReturnType<typeof createStoreDependencies>;
  readonly store: SqliteEventStore;
  close(): void;
}
const worlds: World[] = [];

function world(label: string): World {
  const project = `proj-command-plane-${label}`;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `moe-store-command-plane-${label}-`)));
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({
    clock: () => "2026-09-02T12:00:00.000Z",
    credential: "test-operator-credential",
    principalId: "operator-local",
    projectId: project,
    storePath,
  });
  const store = SqliteEventStore.openForProject(storePath, project);
  const opened: World = {
    close: () => {
      store.close();
      provider.close();
      rmSync(directory, { force: true, recursive: true });
    },
    project, provider, store,
  };
  worlds.push(opened);
  return opened;
}

afterAll(() => { for (const opened of worlds) opened.close(); });

const hex = (digit: string): string => digit.repeat(64);

function commitEvent(opened: World, aggregateId: string, commandId: string, eventType: string,
schemaVersion: string, payload: Uint8Array): void {
  opened.store.commit({ aggregateId, commandBytes: payload, commandId,
    committedAt: "2026-09-02T12:00:00.000Z", events: [{ domainSchemaVersion: schemaVersion,
      eventId: `${commandId}-event`, eventType, payload }], expectedVersion: 0 });
}

const SOURCE_COMMIT = "a".repeat(40);
const GENERATIONS = Object.freeze({ backupGenerationDigest: hex("1"),
  distributionManifestSha256: hex("2"), importGenerationSha256: hex("3"),
  quiesceRecordSha256: hex("4") });

function readiness() {
  return { acceptanceEvidenceSha256: hex("5"), backupEvidenceSha256: hex("6"),
    ...GENERATIONS, contractSchemaSha256: hex("7"),
    deliveryProfileQualificationEvidenceSha256: hex("8"), restoreDrillSha256: hex("9"),
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION, securityEvidenceSha256: hex("a"),
    sourceCommit: SOURCE_COMMIT, storeMigrationEvidenceSha256: hex("b"),
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: hex("c") };
}

function commitMarker(opened: World, readinessManifestSha256: string): void {
  const composed = composeCutoverActivationMarker({ activatedAtEpochMs: 1,
    generations: GENERATIONS, readinessManifestSha256, readinessManifestVersion: 1,
    sourceCommit: SOURCE_COMMIT, sourceState: "ACTIVATE_APPROVED" });
  if (!composed.ok) throw new Error("activation marker fixture refused");
  commitEvent(opened, deriveCutoverActivationMarkerAggregateId(opened.project), "activation-v2",
    CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composed.marker.schemaVersion,
    encodeCutoverActivationMarker(composed.marker));
}

/** The same exact-current marker the `/2` read ports are drilled with. */
function activateV2(opened: World): void {
  const manifest = readiness();
  commitEvent(opened, deriveV2ReadinessManifestAggregateId(opened.project), "readiness-v2",
    V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
    encodeV2ReadinessManifest(manifest));
  commitMarker(opened, digestV2ReadinessManifest(manifest));
}

it("answers V1 over a store with no cutover marker, then V2 the moment the marker commits", () => {
  const opened = world("flip");
  const plane = opened.provider.commandAuthorityPlane?.();
  expect(plane).toBeDefined();
  if (plane === undefined) return;
  expect(plane.boundProjectId).toBe(opened.project);
  expect(plane.readPlane()).toBe("V1");
  expect(admitV1AuthoritativeCommand(opened.store, { projectId: opened.project }).ok).toBe(true);
  activateV2(opened);
  // The SAME port instance flips: nothing is memoised at construction.
  expect(plane.readPlane()).toBe("V2");
  expect(opened.provider.commandAuthorityPlane?.().readPlane()).toBe("V2");
  expect(admitV1AuthoritativeCommand(opened.store, { projectId: opened.project }))
    .toMatchObject({ code: "V1_AUTHORITY_RETIRED", ok: false });
});

it("keeps V1 for a marker that binds no current readiness manifest, and the V1 gate names it", () => {
  const opened = world("divergent");
  const plane = opened.provider.commandAuthorityPlane?.();
  if (plane === undefined) throw new Error("plane reader not composed");
  // A marker whose readiness digest names a manifest that was never committed:
  // present, decodable, and bound to nothing. Not V2.
  commitMarker(opened, hex("f"));
  expect(plane.readPlane()).toBe("V1");
  expect(admitV1AuthoritativeCommand(opened.store, { projectId: opened.project }))
    .toMatchObject({ code: "V1_AUTHORITY_STATUS_UNKNOWN", ok: false });
});
