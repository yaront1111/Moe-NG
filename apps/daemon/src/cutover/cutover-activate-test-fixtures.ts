import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  
  GA_ACTIVATION_WORK_REF,
  GO_ACTIVATE_GATE_ID,
} from "@moe/benchmark";
import { reduceCutover } from "@moe/core";
import type { CutoverCommand, LiveQuiesceEvidence } from "@moe/core";
import { SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "@moe/store";

import { DIGEST, recordOf, seedImport } from "../projections/import-shadow-test-fixtures.js";

import {
  
  
  
  deriveCutoverActivationMarkerAggregateId,
  
  
} from "./cutover-activation-marker.js";
import type {
  CutoverActivateResult,
  CutoverActivateStore,
} from "./cutover-activate-contracts.js";
import { activateCutover } from "./cutover-activate-service.js";
import { admitCutoverActivateApproval } from "./cutover-attempt-commit.js";
import {
  CUTOVER_ATTEMPT_EVENT_TYPE,
  deriveCutoverAttemptAggregateId,
  encodeCutoverAttemptEvent,
} from "./cutover-attempt-contracts.js";
import {
  
  LIVE_QUIESCE_EVIDENCE_FILENAME,
  readCutoverGenerationSnapshot,
} from "./cutover-generation-snapshot.js";
import type { CutoverGenerationPorts, CutoverGenerations } from "./cutover-generation-snapshot.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE,
  V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId,
  
  encodeV2ReadinessManifest,
} from "./v2-readiness-manifest.js";
import type { V2ReadinessManifest } from "./v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "./v2-surface-manifest.js";


/**
 * The `cutover.activate` world, shared by the activation service's own arms and by the
 * readiness-manifest WRITER's proof: a REAL file-backed store seeded through the
 * production reducer to ACTIVATE_APPROVED, the live-quiesce evidence file the generation
 * snapshot reads, and the production approval writer. Nothing here is a double; the
 * one seeded readiness manifest (`seedReadiness`) is the fixture the writer replaces.
 */
export const PROJECT_ID = "project-cutover-activate";
export const DISTRIBUTION_MANIFEST_HASH = "d1".repeat(32);
export const BACKUP_GENERATION_HASH = "b2".repeat(32);
export const SOURCE_COMMIT = "e".repeat(40);
export const ACTIVATED_AT = 1_780_000_000_000;
export const DECIDED_AT = "2026-08-30T00:00:00.000Z";

export const EVIDENCE: LiveQuiesceEvidence = Object.freeze({
  authority: Object.freeze({
    commentId: "comment-cutover-activate",
    moment: "2026-08-29T12:00:00.000Z",
    principal: "operator/live",
  }),
  citationKey: "cutover-activate-service",
  citedBy: "task-b2548479",
  hostFingerprint: "host-cutover-1",
  inventory: Object.freeze({
    hostFingerprint: "host-cutover-1",
    itemCount: 0,
    items: Object.freeze([]),
    runMode: "LIVE" as const,
    undiscoverableKinds: Object.freeze([]),
  }),
  manifestComparison: Object.freeze({
    comparedEntryCount: 0,
    differences: Object.freeze([]),
    matched: true,
    ok: true as const,
  }),
  outcome: "EMPTY" as const,
  resolvedCount: 0,
  results: Object.freeze([]),
  runMode: "LIVE" as const,
  stoppedAt: Object.freeze([]),
});

export interface Harness {
  readonly ports: CutoverGenerationPorts;
  /** CLOSES the handle and reopens the same database file, so a durability claim survives it. */
  reopen(): void;
  readonly store: SqliteEventStore;
}

export interface Counts {
  readonly attempt: number;
  readonly decisions: number;
  readonly marker: number;
  readonly readiness: number;
}

export function commitEvent(store: SqliteEventStore, eventId: string, eventType: string, payload: unknown): void {
  store.commit({
    aggregateId: PROJECT_ID,
    commandBytes: new TextEncoder().encode(eventId),
    commandId: `cmd-${eventId}`,
    committedAt: "2026-08-29T12:00:00.000Z",
    events: [{ eventId, eventType, payload: new TextEncoder().encode(JSON.stringify(payload)) }],
    expectedVersion: store.getAggregateVersion(PROJECT_ID),
  });
}

/** A REAL file-backed store: an in-memory double cannot express the one-transaction property. */
export function withHarness(
  run: (harness: Harness) => void,
  withEvidence = true,
  withReadiness = true,
): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-cutover-activate-"));
  const storeRoot = join(directory, "root");
  mkdirSync(storeRoot, { recursive: true });
  const databasePath = join(directory, "store.sqlite");
  let store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  try {
    commitEvent(store, "project-activated", "ProjectActivated", {
      witness: {
        artifactPathRef: "artifact/ref", backupPathRef: "backup/ref", credentialRef: "credential/ref",
        distributionManifestHash: DISTRIBUTION_MANIFEST_HASH, policyRevisionHash: "p3".repeat(32),
        providerMinimumProfileRef: "profile/ref", signingKeyRef: "signing/ref",
        storeDriverRef: "driver/ref", truthClass: "DAEMON_VERIFIED",
      },
    });
    commitEvent(store, "project-quiesced", "ProjectQuiesced", {
      witness: {
        backupGenerationHash: BACKUP_GENERATION_HASH,
        recoveryIncarnationRef: "incarnation/ref", truthClass: "DAEMON_VERIFIED",
      },
    });
    seedImport(store, DIGEST, [recordOf()]);
    if (withEvidence) {
      writeFileSync(
        join(storeRoot, LIVE_QUIESCE_EVIDENCE_FILENAME), `${JSON.stringify(EVIDENCE, null, 2)}\n`, "utf8",
      );
    }
    // Getters, not captured values: after `reopen()` every reference must see the NEW handle,
    // or an "it survived the reopen" arm would silently keep reading the pre-close object.
    const harness: Harness = {
      ports: {
        config: { storeRoot },
        readFileText: (path: string) => readFileSync(path, "utf8"),
        get store() { return store; },
      } as CutoverGenerationPorts,
      reopen() {
        store.close();
        store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      },
      get store() { return store; },
    };
    if (withReadiness) {
      const generations = withEvidence ? liveGenerations(harness) : {
        backupGenerationDigest: BACKUP_GENERATION_HASH,
        distributionManifestSha256: DISTRIBUTION_MANIFEST_HASH,
        importGenerationSha256: "c".repeat(64),
        quiesceRecordSha256: "d".repeat(64),
      };
      seedReadiness(store, generations);
    }
    run(harness);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

export function liveGenerations(harness: Harness): CutoverGenerations {
  const snapshot = readCutoverGenerationSnapshot(harness.ports, { projectId: PROJECT_ID });
  if (!snapshot.ok) throw new Error(`fixture snapshot refused ${snapshot.code}`);
  return snapshot.generations;
}

export function readinessOf(
  generations: CutoverGenerations,
  overrides: Partial<V2ReadinessManifest> = {},
): V2ReadinessManifest {
  return {
    acceptanceEvidenceSha256: "a1".repeat(32),
    backupEvidenceSha256: "b1".repeat(32),
    backupGenerationDigest: generations.backupGenerationDigest,
    contractSchemaSha256: "c3".repeat(32),
    deliveryProfileQualificationEvidenceSha256: "d3".repeat(32),
    distributionManifestSha256: generations.distributionManifestSha256,
    importGenerationSha256: generations.importGenerationSha256,
    quiesceRecordSha256: generations.quiesceRecordSha256,
    restoreDrillSha256: "39".repeat(32),
    schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
    securityEvidenceSha256: "4a".repeat(32),
    sourceCommit: SOURCE_COMMIT,
    storeMigrationEvidenceSha256: "5a".repeat(32),
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION,
    surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: "f6".repeat(32),
    ...overrides,
  };
}

export function seedReadiness(
  store: SqliteEventStore,
  generations: CutoverGenerations,
  overrides: Partial<V2ReadinessManifest> = {},
): V2ReadinessManifest {
  const record = readinessOf(generations, overrides);
  const aggregateId = deriveV2ReadinessManifestAggregateId(PROJECT_ID);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const payload = encodeV2ReadinessManifest(record);
  store.commit({
    aggregateId,
    commandBytes: payload,
    commandId: `seed-v2-readiness-${String(expectedVersion + 1)}`,
    committedAt: DECIDED_AT,
    events: [{
      eventId: `v2-readiness-${String(expectedVersion + 1)}`,
      eventType: V2_READINESS_MANIFEST_EVENT_TYPE,
      payload,
    }],
    expectedVersion,
  });
  return record;
}

export function bindingOf(
  generations: CutoverGenerations,
  overrides: Readonly<{ decision?: string; principalKind?: string }> = {},
): unknown {
  return {
    authority: {
      gateId: GO_ACTIVATE_GATE_ID,
      grant: {
        gateId: GO_ACTIVATE_GATE_ID,
        grantedAtEpochMs: 1_777_777_777_777,
        principalId: "human:yaron",
        principalKind: overrides.principalKind ?? "HUMAN",
        workRef: GA_ACTIVATION_WORK_REF,
      },
      workRef: GA_ACTIVATION_WORK_REF,
    },
    decision: overrides.decision ?? GO_ACTIVATE_GATE_ID,
    generations: { ...generations },
    sourceCommit: SOURCE_COMMIT,
  };
}

/** Seeds the attempt aggregate PREVIEWED -> IMPORT_VERIFIED through the production reducer. */
export function seedToImportVerified(store: SqliteEventStore): void {
  const commands: readonly CutoverCommand[] = [
    { attemptId: "attempt-1", commandId: "preview-1", expectedVersion: 0, kind: "cutover.preview",
      sourceManifestRef: "manifest-1",
      witness: { inventoryRef: "inventory-1", truthClass: "DAEMON_VERIFIED" } },
    { commandId: "quiesce-approval-1", expectedVersion: 1, kind: "cutover.admit_quiesce_approval",
      witness: { approvalRef: "quiesce-approval", truthClass: "HUMAN_APPROVED" } },
    { commandId: "begin-quiesce-1", expectedVersion: 2, kind: "cutover.begin_quiesce" },
    { commandId: "complete-quiesce-1", expectedVersion: 3, kind: "cutover.complete_quiesce",
      witness: {
        identicalManifestRef: "manifest-1", truthClass: "DAEMON_VERIFIED", writeLockRef: "lock-1",
      } },
    { commandId: "verify-import-1", expectedVersion: 4, kind: "cutover.verify_import",
      witness: {
        importHeadRef: "import-1", restoreDrillRef: "restore-1", truthClass: "DAEMON_VERIFIED",
      } },
  ];
  let state: import("@moe/core").CutoverAttemptState | undefined;
  const aggregateId = deriveCutoverAttemptAggregateId(PROJECT_ID);
  for (const [index, command] of commands.entries()) {
    const reduced = reduceCutover(state, command);
    if (!reduced.ok) throw new Error(`seed refused ${reduced.error.code}`);
    const payload = encodeCutoverAttemptEvent({ admitted: null, command });
    store.commit({
      aggregateId,
      commandBytes: payload,
      commandId: command.commandId,
      committedAt: "2026-08-29T00:00:00.000Z",
      events: [{ eventId: `seed-${index + 1}`, eventType: CUTOVER_ATTEMPT_EVENT_TYPE, payload }],
      expectedVersion: index,
    });
    state = reduced.state;
  }
  if (state?.lifecycle !== "IMPORT_VERIFIED") throw new Error("seed did not reach IMPORT_VERIFIED");
}

/** Drives the PRODUCTION approval writer, so the durable admitted record is not a fixture. */
export function seedToActivateApproved(store: SqliteEventStore, record: unknown): void {
  seedToImportVerified(store);
  const admitted = admitCutoverActivateApproval(store, {
    correlationId: "correlation-approval", decidedAt: DECIDED_AT, projectId: PROJECT_ID, record,
  });
  if (!admitted.ok) {
    throw new Error(`approval seed refused ${String((admitted as { code?: string }).code ?? "?")}`);
  }
  if (admitted.state.lifecycle !== "ACTIVATE_APPROVED") throw new Error("seed is not ACTIVATE_APPROVED");
}

export function counts(store: SqliteEventStore): Counts {
  return Object.freeze({
    attempt: store.readEvents(deriveCutoverAttemptAggregateId(PROJECT_ID)).length,
    decisions: store.readCommandDecisionsAfter(0n, 100).items.length,
    marker: store.readEvents(deriveCutoverActivationMarkerAggregateId(PROJECT_ID)).length,
    readiness: store.readEvents(deriveV2ReadinessManifestAggregateId(PROJECT_ID)).length,
  });
}

export function refusalOf(result: CutoverActivateResult): Readonly<Record<string, unknown>> {
  if (result.ok) throw new Error("expected a refusal, got an accepted activation");
  return result as unknown as Readonly<Record<string, unknown>>;
}

export function activate(harness: Harness, record: unknown, correlationId = "correlation-activate"): CutoverActivateResult {
  return activateCutover(harness.store as unknown as CutoverActivateStore, harness.ports, {
    activatedAtEpochMs: ACTIVATED_AT, correlationId, decidedAt: DECIDED_AT,
    projectId: PROJECT_ID, record,
  });
}
