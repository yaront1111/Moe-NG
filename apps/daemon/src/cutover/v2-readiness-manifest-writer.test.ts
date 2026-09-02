import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROJECT_ID, SOURCE_COMMIT, activate, bindingOf, counts, liveGenerations, readinessOf,
  seedToActivateApproved, withHarness,
} from "./cutover-activate-test-fixtures.js";
import type { Harness } from "./cutover-activate-test-fixtures.js";
import { CUTOVER_GENERATION_SNAPSHOT_LAYER } from "./cutover-generation-snapshot.js";
import {
  admitV1AuthoritativeCommand, admitV2ActiveInstallation, cutoverMarkerBindsReadiness,
  readCutoverActivationMarker,
} from "./cutover-v2-authority.js";
import {
  V2_READINESS_MANIFEST_LAYER, deriveV2ReadinessManifestAggregateId, digestV2ReadinessManifest,
  readV2ReadinessManifest,
} from "./v2-readiness-manifest.js";
import {
  V2_READINESS_EVIDENCE_FILENAMES, V2_READINESS_EVIDENCE_KINDS, V2_READINESS_WRITER_CODES,
  writeV2ReadinessManifest,
} from "./v2-readiness-manifest-writer.js";
import type {
  V2ReadinessEvidenceBytes, V2ReadinessEvidenceKind, V2ReadinessWriterPorts,
} from "./v2-readiness-manifest-writer.js";

/**
 * The readiness-manifest writer is graded by the READER and by the ACTIVATION it
 * exists to enable: a manifest this tool writes must be the one
 * `readV2ReadinessManifest` answers back, byte for byte, and must carry
 * `cutover.activate` from ACTIVATE_APPROVED to ACTIVE with a marker that binds it.
 * Every refusal arm asserts ZERO readiness events, since a writer that refused
 * after committing would still satisfy "it refused".
 */

const encoder = new TextEncoder();
const CLOCK = "2026-09-02T18:00:00.000Z";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function evidenceBytes(overrides: Partial<Record<V2ReadinessEvidenceKind, Uint8Array>> = {}): V2ReadinessEvidenceBytes {
  const bytes: Partial<Record<V2ReadinessEvidenceKind, Uint8Array>> = {};
  for (const kind of V2_READINESS_EVIDENCE_KINDS) {
    bytes[kind] = overrides[kind] ?? encoder.encode(`${JSON.stringify({ evidence: kind, release: "e2e" })}\n`);
  }
  return bytes as V2ReadinessEvidenceBytes;
}

function portsOf(harness: Harness): V2ReadinessWriterPorts {
  return { clock: () => CLOCK, generation: harness.ports, store: harness.store };
}

function readinessEvents(harness: Harness): number {
  return harness.store.readEvents(deriveV2ReadinessManifestAggregateId(PROJECT_ID)).length;
}

describe("the v2 readiness manifest writer", () => {
  it("pins its own code roster as exact, nonzero and frozen", () => {
    expect(V2_READINESS_WRITER_CODES).toHaveLength(7);
    expect(new Set(V2_READINESS_WRITER_CODES).size).toBe(7);
    expect(Object.isFrozen(V2_READINESS_WRITER_CODES)).toBe(true);
    expect(V2_READINESS_EVIDENCE_KINDS).toHaveLength(8);
    expect(Object.keys(V2_READINESS_EVIDENCE_FILENAMES).toSorted()).toEqual([...V2_READINESS_EVIDENCE_KINDS]);
  });

  it("refuses a source commit that is not a full 40-hex id, writing nothing", () => {
    withHarness((harness) => {
      for (const bad of ["", "abc", "E".repeat(40), "a".repeat(39), "a".repeat(64)]) {
        const result = writeV2ReadinessManifest(portsOf(harness), {
          evidence: evidenceBytes(), projectId: PROJECT_ID, sourceCommit: bad,
        });
        expect(result).toMatchObject({
          code: "V2_READINESS_WRITER_SOURCE_COMMIT_INVALID", layer: V2_READINESS_MANIFEST_LAYER, ok: false,
        });
      }
      expect(readinessEvents(harness)).toBe(0);
    }, true, false);
  });

  it("refuses an empty evidence file by its kind, writing nothing", () => {
    withHarness((harness) => {
      for (const kind of V2_READINESS_EVIDENCE_KINDS) {
        const result = writeV2ReadinessManifest(portsOf(harness), {
          evidence: evidenceBytes({ [kind]: new Uint8Array() }), projectId: PROJECT_ID,
          sourceCommit: SOURCE_COMMIT,
        });
        expect(result).toMatchObject({
          code: "V2_READINESS_WRITER_EVIDENCE_EMPTY", detail: kind, ok: false,
        });
      }
      expect(readinessEvents(harness)).toBe(0);
    }, true, false);
  });

  it("refuses when a readiness manifest already exists, naming the standing digest", () => {
    withHarness((harness) => {
      const standing = digestV2ReadinessManifest(readinessOf(liveGenerations(harness)));
      const result = writeV2ReadinessManifest(portsOf(harness), {
        evidence: evidenceBytes(), projectId: PROJECT_ID, sourceCommit: SOURCE_COMMIT,
      });
      expect(result).toMatchObject({
        code: "V2_READINESS_WRITER_ALREADY_WRITTEN", detail: standing, ok: false,
      });
      expect(readinessEvents(harness)).toBe(1);
    });
  });

  it("forwards the generation snapshot's own refusal when the quiesce evidence is absent", () => {
    withHarness((harness) => {
      const result = writeV2ReadinessManifest(portsOf(harness), {
        evidence: evidenceBytes(), projectId: PROJECT_ID, sourceCommit: SOURCE_COMMIT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("V2_READINESS_WRITER_GENERATION_REFUSED");
      expect(result.upstream?.layer).toBe(CUTOVER_GENERATION_SNAPSHOT_LAYER);
      expect(readinessEvents(harness)).toBe(0);
    }, false, false);
  });

  it("writes exactly one canonical manifest that the production reader answers back", () => {
    withHarness((harness) => {
      const evidence = evidenceBytes();
      const result = writeV2ReadinessManifest(portsOf(harness), {
        evidence, projectId: PROJECT_ID, sourceCommit: SOURCE_COMMIT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(1);
      expect(result.generations).toEqual(liveGenerations(harness));
      for (const kind of V2_READINESS_EVIDENCE_KINDS) {
        expect(result.evidenceDigests[kind]).toBe(sha256(evidence[kind]));
      }
      expect(result.manifest.sourceCommit).toBe(SOURCE_COMMIT);
      expect(result.manifest.acceptanceEvidenceSha256).toBe(sha256(evidence.acceptanceEvidence));
      expect(result.manifest.restoreDrillSha256).toBe(sha256(evidence.restoreDrill));

      expect(readinessEvents(harness)).toBe(1);
      harness.reopen();
      const read = readV2ReadinessManifest(harness.store, { projectId: PROJECT_ID });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.digest).toBe(result.digest);
      expect(read.version).toBe(1);
      expect(read.manifest).toEqual(result.manifest);

      // A second write is refused and names the manifest that stands.
      const again = writeV2ReadinessManifest(portsOf(harness), {
        evidence, projectId: PROJECT_ID, sourceCommit: SOURCE_COMMIT,
      });
      expect(again).toMatchObject({ code: "V2_READINESS_WRITER_ALREADY_WRITTEN", detail: result.digest, ok: false });
      expect(readinessEvents(harness)).toBe(1);
    }, true, false);
  });

  it("END TO END: the written manifest carries cutover.activate to ACTIVE and turns v2 authority on", () => {
    withHarness((harness) => {
      // Before: no manifest, so the activation refuses on the reader's absent verdict and
      // the v1 plane is the one in force.
      expect(admitV1AuthoritativeCommand(harness.store, { projectId: PROJECT_ID }).ok).toBe(true);
      expect(admitV2ActiveInstallation(harness.store, { projectId: PROJECT_ID }).ok).toBe(false);

      const written = writeV2ReadinessManifest(portsOf(harness), {
        evidence: evidenceBytes(), projectId: PROJECT_ID, sourceCommit: SOURCE_COMMIT,
      });
      expect(written.ok).toBe(true);
      if (!written.ok) return;

      const live = liveGenerations(harness);
      const record = bindingOf(live);
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const result = activate(harness, record);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state.lifecycle).toBe("ACTIVE");
      expect(result.marker.readinessManifestSha256).toBe(written.digest);
      expect(result.marker.readinessManifestVersion).toBe(1);
      expect(result.marker.generations).toEqual(written.generations);
      const after = counts(harness.store);
      expect(after.marker).toBe(before.marker + 1);
      expect(after.readiness).toBe(before.readiness);

      // The durable marker binds the manifest the writer wrote, and the authority flips:
      // this is what `/bootstrap` states as V2 and what retires `/command`.
      const marker = readCutoverActivationMarker(harness.store, { projectId: PROJECT_ID });
      const readiness = readV2ReadinessManifest(harness.store, { projectId: PROJECT_ID });
      expect(marker).not.toBeNull();
      expect(readiness.ok).toBe(true);
      if (marker === null || !readiness.ok) return;
      expect(cutoverMarkerBindsReadiness(marker, readiness)).toBe(true);
      expect(admitV2ActiveInstallation(harness.store, { projectId: PROJECT_ID }).ok).toBe(true);
      expect(admitV1AuthoritativeCommand(harness.store, { projectId: PROJECT_ID }))
        .toMatchObject({ code: "V1_AUTHORITY_RETIRED", ok: false });
    }, true, false);
  });

  it("the CLI writes the same manifest from evidence files and refuses a second run", () => {
    withHarness((harness) => {
      const storeRoot = harness.ports.config.storeRoot;
      const databasePath = join(dirname(storeRoot), "store.sqlite");
      const evidenceRoot = join(dirname(storeRoot), "evidence");
      mkdirSync(evidenceRoot, { recursive: true });
      const evidence = evidenceBytes();
      for (const kind of V2_READINESS_EVIDENCE_KINDS) {
        writeFileSync(join(evidenceRoot, V2_READINESS_EVIDENCE_FILENAMES[kind]), evidence[kind]);
      }
      const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");
      const main = resolve(import.meta.dirname, "v2-readiness-manifest-writer-main.ts");
      const args = [
        "--experimental-transform-types", main,
        `--store-path=${databasePath}`, `--project-id=${PROJECT_ID}`, `--store-root=${storeRoot}`,
        `--source-commit=${SOURCE_COMMIT}`, `--evidence-root=${evidenceRoot}`,
      ];
      const run = (): { readonly body: Record<string, unknown>; readonly status: number | null } => {
        const child = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
        if (child.status !== 0 && child.status !== 1) {
          throw new Error(`writer exited ${String(child.status)}:\n${child.stderr.slice(-800)}`);
        }
        return { body: JSON.parse(child.stdout) as Record<string, unknown>, status: child.status };
      };

      const first = run();
      expect(first.status).toBe(0);
      expect(first.body["ok"]).toBe(true);
      for (const kind of V2_READINESS_EVIDENCE_KINDS) {
        expect((first.body["evidenceDigests"] as Record<string, string>)[kind]).toBe(sha256(evidence[kind]));
      }
      harness.reopen();
      const read = readV2ReadinessManifest(harness.store, { projectId: PROJECT_ID });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.digest).toBe(first.body["digest"]);
      expect(read.manifest.sourceCommit).toBe(SOURCE_COMMIT);

      const second = run();
      expect(second.status).toBe(1);
      expect(second.body).toMatchObject({
        code: "V2_READINESS_WRITER_ALREADY_WRITTEN", detail: first.body["digest"], ok: false,
      });
      harness.reopen();
      expect(readinessEvents(harness)).toBe(1);
    }, true, false);
  }, 60_000);
});
