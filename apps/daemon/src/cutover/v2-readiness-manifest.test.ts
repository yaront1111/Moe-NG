import { SQLITE_SCHEMA_MANIFEST_VERSION } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  deriveCutoverActivationMarkerAggregateId,
  deriveLegacyCutoverActivationMarkerAggregateId,
} from "./cutover-activation-marker.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE,
  V2_READINESS_MANIFEST_KEYS,
  V2_READINESS_MANIFEST_SCHEMA_VERSION,
  decodeV2ReadinessManifest,
  deriveV2ReadinessManifestAggregateId,
  digestV2ReadinessManifest,
  encodeV2ReadinessManifest,
  readV2ReadinessManifest,
} from "./v2-readiness-manifest.js";
import type { V2ReadinessManifest } from "./v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "./v2-surface-manifest.js";

const HEX = (seed: string): string => seed.repeat(64).slice(0, 64);
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function manifest(overrides: Partial<V2ReadinessManifest> = {}): V2ReadinessManifest {
  return {
    acceptanceEvidenceSha256: HEX("a1"),
    backupEvidenceSha256: HEX("b1"),
    backupGenerationDigest: HEX("b2"),
    contractSchemaSha256: HEX("c3"),
    deliveryProfileQualificationEvidenceSha256: HEX("d3"),
    distributionManifestSha256: HEX("d4"),
    importGenerationSha256: HEX("e5"),
    quiesceRecordSha256: HEX("28"),
    restoreDrillSha256: HEX("39"),
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
    securityEvidenceSha256: HEX("4a"),
    sourceCommit: SOURCE_COMMIT,
    storeMigrationEvidenceSha256: HEX("5a"),
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: HEX("f6"),
    ...overrides,
  };
}

const asEvent = (payload: Uint8Array, overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  aggregateId: deriveV2ReadinessManifestAggregateId("project-1"),
  aggregateSequence: 1,
  commandId: "readiness-1",
  committedAt: "2026-08-31T00:00:00.000Z",
  domainSchemaVersion: "moe-domain-schema/0",
  eventId: "readiness-event-1",
  eventType: V2_READINESS_MANIFEST_EVENT_TYPE,
  globalPosition: 1n,
  metadata: new Uint8Array(),
  payload,
  payloadCodecVersion: "moe-opaque-bytes/1",
  recordVersion: "moe-event-record/1",
  requestSha256: HEX("5b"),
  ...overrides,
});

describe("v2 readiness manifest bytes", () => {
  it("publishes an exact frozen key roster covering every release pin", () => {
    expect(V2_READINESS_MANIFEST_KEYS).toEqual([
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
    ]);
    expect(V2_READINESS_MANIFEST_KEYS).toHaveLength(16);
    expect(Object.isFrozen(V2_READINESS_MANIFEST_KEYS)).toBe(true);
  });

  it("round-trips canonical bytes and derives their digest", () => {
    const expected = manifest();
    const encoded = encodeV2ReadinessManifest(expected);
    const decoded = decodeV2ReadinessManifest(encoded);

    expect(new TextDecoder().decode(encoded)).toBe(JSON.stringify(expected));
    expect(decoded).toEqual({ manifest: expected, ok: true, pinsMatch: true });
    if (!decoded.ok) return;
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.manifest)).toBe(true);
    expect(digestV2ReadinessManifest(decoded.manifest)).toMatch(/^[0-9a-f]{64}$/u);

    expect(decodeV2ReadinessManifest(new TextEncoder().encode(JSON.stringify(expected, null, 2))))
      .toEqual({
        code: "V2_READINESS_MANIFEST_NONCANONICAL",
        layer: "DAEMON_V2_READINESS_MANIFEST",
        ok: false,
      });
  });

  it("refuses missing, extra and malformed readiness bytes by exact code and layer", () => {
    const missing = { ...manifest() } as Record<string, unknown>;
    delete missing["securityEvidenceSha256"];
    const extra = { ...manifest(), inheritedAuthority: true };
    const malformed = { ...manifest(), sourceCommit: "HEAD" };

    for (const candidate of [missing, extra, malformed]) {
      expect(decodeV2ReadinessManifest(new TextEncoder().encode(JSON.stringify(candidate))))
        .toEqual({
          code: "V2_READINESS_MANIFEST_INVALID",
          layer: "DAEMON_V2_READINESS_MANIFEST",
          ok: false,
        });
    }
  });

  it("requires the running schema and exact static v2 surface", () => {
    for (const candidate of [
      manifest({ storeSchemaVersion: "moe-sqlite-schema/6" }),
      manifest({ surfaceManifestSha256: HEX("ff") }),
    ]) {
      expect(decodeV2ReadinessManifest(encodeV2ReadinessManifest(candidate))).toEqual({
        code: "V2_READINESS_MANIFEST_STATIC_PIN_MISMATCH",
        layer: "DAEMON_V2_READINESS_MANIFEST",
        ok: false,
      });
      expect(decodeV2ReadinessManifest(encodeV2ReadinessManifest(candidate), "CURRENT").ok).toBe(false);
    }
  });

  it("reads a manifest written under another build's pins as recorded, and says they differ", () => {
    // The post-activation marker binding reads this way: after a build pin bump the manifest
    // still decodes to exactly the bytes that were written (digest unchanged), and the caller is
    // told the pins are not the running build's instead of being locked out of both planes.
    const foreign = manifest({ storeSchemaVersion: "moe-sqlite-schema/6", surfaceManifestSha256: HEX("ff") });
    const bytes = encodeV2ReadinessManifest(foreign);
    const decoded = decodeV2ReadinessManifest(bytes, "RECORDED");
    expect(decoded).toEqual({ manifest: foreign, ok: true, pinsMatch: false });
    if (!decoded.ok) return;
    expect(encodeV2ReadinessManifest(decoded.manifest)).toEqual(bytes);
    expect(decodeV2ReadinessManifest(encodeV2ReadinessManifest(manifest()), "RECORDED"))
      .toEqual({ manifest: manifest(), ok: true, pinsMatch: true });
    // Shape and canonical-bytes refusals are unchanged by the policy.
    expect(decodeV2ReadinessManifest(encodeV2ReadinessManifest(manifest({ storeSchemaVersion: "" })), "RECORDED").ok).toBe(false);
  });

  it("binds every canonical release, migration, backup, qualification and gate pin", () => {
    const original = manifest();
    const originalDigest = digestV2ReadinessManifest(original);
    const mutations: readonly (readonly [string, string])[] = [
      ["acceptanceEvidenceSha256", HEX("09")],
      ["backupEvidenceSha256", HEX("10")],
      ["backupGenerationDigest", HEX("05")],
      ["contractSchemaSha256", HEX("02")],
      ["deliveryProfileQualificationEvidenceSha256", HEX("07")],
      ["distributionManifestSha256", HEX("01")],
      ["importGenerationSha256", HEX("04")],
      ["quiesceRecordSha256", HEX("0b")],
      ["restoreDrillSha256", HEX("06")],
      ["schemaVersion", "moe-v2-readiness-manifest/review-mutation"],
      ["securityEvidenceSha256", HEX("08")],
      ["sourceCommit", "f".repeat(40)],
      ["storeMigrationEvidenceSha256", HEX("11")],
      ["storeSchemaVersion", "moe-sqlite-schema/review-mutation"],
      ["surfaceManifestSha256", HEX("03")],
      ["windowsPackagingEvidenceSha256", HEX("0a")],
    ];

    expect(mutations).toHaveLength(V2_READINESS_MANIFEST_KEYS.length);
    for (const [field, value] of mutations) {
      const mutated = { ...original, [field]: value } as V2ReadinessManifest;
      expect(digestV2ReadinessManifest(mutated)).not.toBe(originalDigest);
    }
  });
});

describe("v2 readiness manifest durable reader", () => {
  it("uses a server-derived namespace distinct from both marker generations", () => {
    const readiness = deriveV2ReadinessManifestAggregateId("project-1");
    expect(deriveV2ReadinessManifestAggregateId("project-1")).toBe(readiness);
    expect(deriveV2ReadinessManifestAggregateId("project-2")).not.toBe(readiness);
    expect(readiness).not.toBe(deriveCutoverActivationMarkerAggregateId("project-1"));
    expect(readiness).not.toBe(deriveLegacyCutoverActivationMarkerAggregateId("project-1"));
    expect(deriveV2ReadinessManifestAggregateId("p".repeat(4096)).length).toBeLessThanOrEqual(512);
  });

  it("returns the canonical digest and exact durable version from the only event", () => {
    const expected = manifest();
    const event = asEvent(encodeV2ReadinessManifest(expected));
    const store = { readEvents: () => [event] };

    const read = readV2ReadinessManifest(store, { projectId: "project-1" });

    expect(read).toEqual({
      digest: digestV2ReadinessManifest(expected),
      manifest: expected,
      ok: true,
      pinsMatch: true,
      version: 1,
    });
    if (!read.ok) return;
    expect(Object.isFrozen(read)).toBe(true);
  });

  it("reads a foreign-pinned durable manifest under RECORDED pins and refuses it under CURRENT", () => {
    const foreign = manifest({ storeSchemaVersion: "moe-sqlite-schema/6" });
    const store = { readEvents: () => [asEvent(encodeV2ReadinessManifest(foreign))] };
    expect(readV2ReadinessManifest(store, { projectId: "project-1" })).toEqual({
      code: "V2_READINESS_MANIFEST_STATIC_PIN_MISMATCH", layer: "DAEMON_V2_READINESS_MANIFEST", ok: false,
    });
    // The marker-binding read: the same digest the marker bound, the pins reported not the build's.
    expect(readV2ReadinessManifest(store, { pins: "RECORDED", projectId: "project-1" })).toEqual({
      digest: digestV2ReadinessManifest(foreign), manifest: foreign, ok: true, pinsMatch: false, version: 1,
    });
  });

  it("distinguishes absent, unreadable, malformed and noncanonical durable evidence", () => {
    const valid = manifest();
    const cases = [
      ["V2_READINESS_MANIFEST_ABSENT", { readEvents: () => [] }],
      ["V2_READINESS_MANIFEST_UNREADABLE", { readEvents: () => { throw new Error("closed"); } }],
      ["V2_READINESS_MANIFEST_INVALID", { readEvents: () => [asEvent(new Uint8Array([0xff]))] }],
      ["V2_READINESS_MANIFEST_NONCANONICAL", {
        readEvents: () => [asEvent(new TextEncoder().encode(JSON.stringify(valid, null, 2)))],
      }],
      ["V2_READINESS_MANIFEST_INVALID", {
        readEvents: () => [asEvent(encodeV2ReadinessManifest(valid)), asEvent(encodeV2ReadinessManifest(valid), {
          aggregateSequence: 2, eventId: "readiness-event-2",
        })],
      }],
    ] as const;

    for (const [code, store] of cases) {
      expect(readV2ReadinessManifest(store, { projectId: "project-1" })).toEqual({
        code,
        layer: "DAEMON_V2_READINESS_MANIFEST",
        ok: false,
      });
    }
  });
});
