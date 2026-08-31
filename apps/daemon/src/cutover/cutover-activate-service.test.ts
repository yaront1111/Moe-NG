import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTIVATION_GENERATION_KEYS,
  GA_ACTIVATION_WORK_REF,
  GO_ACTIVATE_GATE_ID,
} from "@moe/benchmark";
import { reduceCutover } from "@moe/core";
import type { CutoverCommand, LiveQuiesceEvidence } from "@moe/core";
import { SQLITE_SCHEMA_MANIFEST_VERSION, SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { DIGEST, recordOf, seedImport } from "../projections/import-shadow-test-fixtures.js";

import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
  LEGACY_CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
  decodeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId,
  deriveLegacyCutoverActivationMarkerAggregateId,
  encodeLegacyCutoverActivationMarker,
} from "./cutover-activation-marker.js";
import {
  CUTOVER_ACTIVATE_CODES,
  CUTOVER_ACTIVATE_LAYER,
} from "./cutover-activate-contracts.js";
import type {
  CutoverActivateResult,
  CutoverActivateStore,
} from "./cutover-activate-contracts.js";
import { activateCutover } from "./cutover-activate-service.js";
import {
  CUTOVER_V2_AUTHORITY_CODES,
  admitV2AuthoritativeCommand,
  readCutoverActivationMarker,
} from "./cutover-v2-authority.js";
import { admitCutoverActivateApproval } from "./cutover-attempt-commit.js";
import {
  CUTOVER_ATTEMPT_EVENT_TYPE,
  deriveCutoverAttemptAggregateId,
  encodeCutoverAttemptEvent,
} from "./cutover-attempt-contracts.js";
import {
  CUTOVER_GENERATION_FACTS,
  LIVE_QUIESCE_EVIDENCE_FILENAME,
  readCutoverGenerationSnapshot,
} from "./cutover-generation-snapshot.js";
import type { CutoverGenerationPorts, CutoverGenerations } from "./cutover-generation-snapshot.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE,
  V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId,
  digestV2ReadinessManifest,
  encodeV2ReadinessManifest,
} from "./v2-readiness-manifest.js";
import type { V2ReadinessManifest } from "./v2-readiness-manifest.js";
import { V2_MUTATION_COMMAND_KINDS, V2_SURFACE_MANIFEST_SHA256 } from "./v2-surface-manifest.js";

/**
 * task-b2548479 step 3 - the `cutover.activate` handler.
 *
 * WHAT IS UNDER TEST IS WHICH LAYER REFUSED, not that something refused. Five different layers
 * can answer here (the GO_ACTIVATE admission, core's human-authority gate, the attempt fold,
 * the CutoverAttempt reducer and this handler), and several of them can answer with the same
 * shape. Every refusal arm therefore pins the exact stable code AND the layer, and every
 * refusal arm asserts ZERO new attempt events, ZERO marker events and ZERO decisions - a
 * handler that refused but had already written the marker would satisfy "it refused".
 */

const PROJECT_ID = "project-cutover-activate";
const DISTRIBUTION_MANIFEST_HASH = "d1".repeat(32);
const BACKUP_GENERATION_HASH = "b2".repeat(32);
const SOURCE_COMMIT = "e".repeat(40);
const ACTIVATED_AT = 1_780_000_000_000;
const DECIDED_AT = "2026-08-30T00:00:00.000Z";

const EVIDENCE: LiveQuiesceEvidence = Object.freeze({
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

interface Harness {
  readonly ports: CutoverGenerationPorts;
  /** CLOSES the handle and reopens the same database file, so a durability claim survives it. */
  reopen(): void;
  readonly store: SqliteEventStore;
}

interface Counts {
  readonly attempt: number;
  readonly decisions: number;
  readonly marker: number;
  readonly readiness: number;
}

function commitEvent(store: SqliteEventStore, eventId: string, eventType: string, payload: unknown): void {
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
function withHarness(
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

function liveGenerations(harness: Harness): CutoverGenerations {
  const snapshot = readCutoverGenerationSnapshot(harness.ports, { projectId: PROJECT_ID });
  if (!snapshot.ok) throw new Error(`fixture snapshot refused ${snapshot.code}`);
  return snapshot.generations;
}

function readinessOf(
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

function seedReadiness(
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

function bindingOf(
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
function seedToImportVerified(store: SqliteEventStore): void {
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
function seedToActivateApproved(store: SqliteEventStore, record: unknown): void {
  seedToImportVerified(store);
  const admitted = admitCutoverActivateApproval(store, {
    correlationId: "correlation-approval", decidedAt: DECIDED_AT, projectId: PROJECT_ID, record,
  });
  if (!admitted.ok) {
    throw new Error(`approval seed refused ${String((admitted as { code?: string }).code ?? "?")}`);
  }
  if (admitted.state.lifecycle !== "ACTIVATE_APPROVED") throw new Error("seed is not ACTIVATE_APPROVED");
}

function counts(store: SqliteEventStore): Counts {
  return Object.freeze({
    attempt: store.readEvents(deriveCutoverAttemptAggregateId(PROJECT_ID)).length,
    decisions: store.readCommandDecisionsAfter(0n, 100).items.length,
    marker: store.readEvents(deriveCutoverActivationMarkerAggregateId(PROJECT_ID)).length,
    readiness: store.readEvents(deriveV2ReadinessManifestAggregateId(PROJECT_ID)).length,
  });
}

function refusalOf(result: CutoverActivateResult): Readonly<Record<string, unknown>> {
  if (result.ok) throw new Error("expected a refusal, got an accepted activation");
  return result as unknown as Readonly<Record<string, unknown>>;
}

function activate(harness: Harness, record: unknown, correlationId = "correlation-activate"): CutoverActivateResult {
  return activateCutover(harness.store as unknown as CutoverActivateStore, harness.ports, {
    activatedAtEpochMs: ACTIVATED_AT, correlationId, decidedAt: DECIDED_AT,
    projectId: PROJECT_ID, record,
  });
}

describe("cutover.activate refusal vocabulary", () => {
  it("pins its own code roster and layer as exact, nonzero, frozen values", () => {
    expect(Object.isFrozen(CUTOVER_ACTIVATE_CODES)).toBe(true);
    expect(CUTOVER_ACTIVATE_CODES.length).toBeGreaterThan(0);
    expect([...CUTOVER_ACTIVATE_CODES].sort()).toEqual([
      "CUTOVER_ACTIVATE_BINDING_DRIFT",
      "CUTOVER_ACTIVATE_EXPECTED_VERSION_CONFLICT",
      "CUTOVER_ACTIVATE_FIELD_INVALID",
      "CUTOVER_ACTIVATE_GENERATION_DRIFT",
      "CUTOVER_ACTIVATE_READINESS_DRIFT",
      "CUTOVER_ACTIVATE_REPLAY_DIVERGED",
      "CUTOVER_ACTIVATE_STORE_UNAVAILABLE",
      "CUTOVER_ACTIVATE_VERSION_DESYNC",
    ]);
    expect(CUTOVER_ACTIVATE_LAYER).toBe("DAEMON_CUTOVER_ACTIVATE");
  });

  it("compares the SAME four generations the binding binds, in both directions", () => {
    // Bidirectional: a key dropped from either roster would leave one generation uncompared
    // while every "it drifted" arm stayed green, because the drift walk iterates a roster.
    expect([...ACTIVATION_GENERATION_KEYS].sort()).toEqual([...CUTOVER_GENERATION_FACTS].sort());
    expect(ACTIVATION_GENERATION_KEYS).toHaveLength(CUTOVER_GENERATION_FACTS.length);
  });

  it("takes the binding only as an opaque record, so no caller can present a generation", () => {
    const input: Parameters<typeof activateCutover>[2] = {
      activatedAtEpochMs: ACTIVATED_AT, correlationId: "c", decidedAt: DECIDED_AT,
      projectId: PROJECT_ID, record: null,
    };
    expect(Object.keys(input).sort()).toEqual([
      "activatedAtEpochMs", "correlationId", "decidedAt", "projectId", "record",
    ]);
  });
});

describe("cutover.activate forwards the admission's verdict verbatim", () => {
  it("refuses an absent binding with the ADMISSION's code and layer, writing nothing", () => {
    withHarness((harness) => {
      seedToActivateApproved(harness.store, bindingOf(liveGenerations(harness)));
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, null));

      expect(refusal["code"]).toBe("ACTIVATION_BINDING_ABSENT");
      expect(refusal["layer"]).toBe("GA_ACTIVATION_BINDING");
      expect(counts(harness.store)).toEqual(before);
    });
  });

  it("refuses a GO_QUIESCE decision on DECISION KIND, at the admission, writing nothing", () => {
    withHarness((harness) => {
      const generations = liveGenerations(harness);
      seedToActivateApproved(harness.store, bindingOf(generations));
      const before = counts(harness.store);

      // A real human grant for a DIFFERENT decision. The standing quiesce authorization is not
      // a binding, and the admission must say so before the gate consults the grant.
      const refusal = refusalOf(activate(harness, bindingOf(generations, { decision: "GO_QUIESCE" })));

      expect(refusal["code"]).toBe("ACTIVATION_BINDING_DECISION_MISMATCH");
      expect(refusal["layer"]).toBe("GA_ACTIVATION_BINDING");
      expect(counts(harness.store)).toEqual(before);
    });
  });

  it("forwards core's GATE refusal with the GATE layer, not the admission's", () => {
    withHarness((harness) => {
      const generations = liveGenerations(harness);
      seedToActivateApproved(harness.store, bindingOf(generations));
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, bindingOf(generations, { principalKind: "AGENT" })));

      // The layer is the whole point: both branches refuse, and only the layer says which one.
      expect(refusal["code"]).toBe("APPROVAL_PRINCIPAL_NOT_HUMAN");
      expect(refusal["layer"]).toBe("HUMAN_AUTHORITY_GATE");
      expect(counts(harness.store)).toEqual(before);
    });
  });
});

describe("cutover.activate refuses on the durable attempt state", () => {
  it("forwards CUTOVER_ATTEMPT_STATE_ABSENT when no attempt was ever previewed", () => {
    withHarness((harness) => {
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, bindingOf(liveGenerations(harness))));

      expect(refusal["code"]).toBe("CUTOVER_ATTEMPT_STATE_ABSENT");
      expect(refusal["layer"]).toBe("DAEMON_CUTOVER_ATTEMPT");
      expect(counts(harness.store)).toEqual(before);
    });
  });

  it("refuses ILLEGAL_TRANSITION at the REDUCER when the attempt is only IMPORT_VERIFIED", () => {
    withHarness((harness) => {
      seedToImportVerified(harness.store);
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, bindingOf(liveGenerations(harness))));

      // Layer CUTOVER, not CUTOVER_ACTIVATION_MARKER: the reducer's edge table is the authority
      // on which states admit `cutover.activate`, and the marker module never gets to answer.
      expect((refusal["error"] as { code: string }).code).toBe("ILLEGAL_TRANSITION");
      expect(refusal["layer"]).toBe("CUTOVER");
      expect((refusal["error"] as { details?: Record<string, unknown> }).details?.["sourceState"])
        .toBe("IMPORT_VERIFIED");
      expect(counts(harness.store)).toEqual(before);
    });
  });

  it("refuses BINDING_DRIFT when a binding other than the admitted one is presented", () => {
    withHarness((harness) => {
      const generations = liveGenerations(harness);
      seedToActivateApproved(harness.store, bindingOf(generations));
      const before = counts(harness.store);

      // Same four generations, a different human: a well-formed binding the attempt never
      // admitted. The caller cannot choose which binding the activation runs on.
      const other = bindingOf(generations) as { authority: { grant: { principalId: string } } };
      other.authority.grant.principalId = "human:someone-else";
      const refusal = refusalOf(activate(harness, other));

      expect(refusal["code"]).toBe("CUTOVER_ACTIVATE_BINDING_DRIFT");
      expect(refusal["layer"]).toBe(CUTOVER_ACTIVATE_LAYER);
      expect(counts(harness.store)).toEqual(before);
    });
  });
});

describe("cutover.activate refuses on generation drift", () => {
  it("names the ONE generation that no longer matches the live snapshot", () => {
    withHarness((harness) => {
      const live = liveGenerations(harness);
      // Bound to an import generation that is not the one the store now holds.
      const record = bindingOf({ ...live, importGenerationSha256: "9".repeat(64) });
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, record));

      expect(refusal["code"]).toBe("CUTOVER_ACTIVATE_GENERATION_DRIFT");
      expect(refusal["layer"]).toBe(CUTOVER_ACTIVATE_LAYER);
      expect(refusal["fact"]).toBe("importGenerationSha256");
      expect(counts(harness.store)).toEqual(before);
    });
  });

  it("forwards the SNAPSHOT reader's own refusal when a generation cannot be read", () => {
    withHarness((harness) => {
      const record = bindingOf({
        backupGenerationDigest: "a".repeat(64), distributionManifestSha256: "b".repeat(64),
        importGenerationSha256: "c".repeat(64), quiesceRecordSha256: "d".repeat(64),
      });
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, record));

      expect(refusal["code"]).toBe("CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT");
      expect(refusal["layer"]).toBe("DAEMON_CUTOVER_GENERATION");
      expect(refusal["missing"]).toBe("quiesceRecordSha256");
      expect(counts(harness.store)).toEqual(before);
    }, false);
  });
});

describe("cutover.activate requires one durable v2 readiness manifest", () => {
  it("forwards the readiness reader's absent verdict and writes nothing", () => {
    withHarness((harness) => {
      const record = bindingOf(liveGenerations(harness));
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, record));

      expect(refusal["code"]).toBe("V2_READINESS_MANIFEST_ABSENT");
      expect(refusal["layer"]).toBe("DAEMON_V2_READINESS_MANIFEST");
      expect(counts(harness.store)).toEqual(before);
    }, true, false);
  });

  it.each([
    ["sourceCommit", "f".repeat(40)],
    ["distributionManifestSha256", "0d".repeat(32)],
  ] as const)("refuses when readiness moved at %s, with zero activation effects", (fact, value) => {
    withHarness((harness) => {
      const generations = liveGenerations(harness);
      seedReadiness(harness.store, generations, { [fact]: value });
      const record = bindingOf(generations);
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const refusal = refusalOf(activate(harness, record));

      expect(refusal["code"]).toBe("CUTOVER_ACTIVATE_READINESS_DRIFT");
      expect(refusal["layer"]).toBe(CUTOVER_ACTIVATE_LAYER);
      expect(refusal["fact"]).toBe(fact);
      expect(counts(harness.store)).toEqual(before);
    }, true, false);
  });
});

describe("cutover.activate commits the transition and the marker together", () => {
  it("moves ACTIVATE_APPROVED -> ACTIVE and writes the marker the human bound", () => {
    withHarness((harness) => {
      const live = liveGenerations(harness);
      const record = bindingOf(live);
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const result = activate(harness, record);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.disposition).toBe("COMMITTED");
      expect(result.state.lifecycle).toBe("ACTIVE");
      expect(result.marker.generations).toEqual(live);
      expect(result.marker.sourceCommit).toBe(SOURCE_COMMIT);
      expect(result.marker.activatedAtEpochMs).toBe(ACTIVATED_AT);
      expect(result.marker.schemaVersion).toBe("moe-cutover-activation-marker/2");
      expect(result.marker.readinessManifestVersion).toBe(1);
      expect(result.marker.readinessManifestSha256).toBe(digestV2ReadinessManifest(readinessOf(live)));
      const after = counts(harness.store);
      expect(after.attempt).toBe(before.attempt + 1);
      expect(after.marker).toBe(before.marker + 1);
      expect(after.readiness).toBe(before.readiness);
      expect(after.decisions).toBe(before.decisions + 1);
    });
  });

  it("writes the marker on its OWN aggregate, readable back through the durable bytes", () => {
    withHarness((harness) => {
      const record = bindingOf(liveGenerations(harness));
      seedToActivateApproved(harness.store, record);

      const result = activate(harness, record);
      expect(result.ok).toBe(true);

      const stored = harness.store.readEvents(deriveCutoverActivationMarkerAggregateId(PROJECT_ID));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.eventType).toBe(CUTOVER_ACTIVATION_MARKER_EVENT_TYPE);
      const decoded = decodeCutoverActivationMarker(stored[0]?.payload);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.marker).toEqual(readCutoverActivationMarker(
        harness.store as unknown as CutoverActivateStore, { projectId: PROJECT_ID },
      ));
      // The attempt aggregate still folds: the marker is NOT an event on it.
      expect(harness.store.readEvents(deriveCutoverAttemptAggregateId(PROJECT_ID))
        .every((event) => event.eventType === CUTOVER_ATTEMPT_EVENT_TYPE)).toBe(true);
    });
  });

  it("reads back NO marker before the activation commits", () => {
    withHarness((harness) => {
      seedToActivateApproved(harness.store, bindingOf(liveGenerations(harness)));
      expect(readCutoverActivationMarker(
        harness.store as unknown as CutoverActivateStore, { projectId: PROJECT_ID },
      )).toBeNull();
    });
  });

  it("never degrades a refusal to UNKNOWN_ERROR", () => {
    withHarness((harness) => {
      seedToImportVerified(harness.store);
      const refusal = refusalOf(activate(harness, bindingOf(liveGenerations(harness))));
      // `createRuntimeError` returns UNKNOWN_ERROR rather than throwing for a code or aggregate
      // the registry does not admit, so a wrong code refuses silently and stays green.
      expect((refusal["error"] as { code: string }).code).not.toBe("UNKNOWN_ERROR");
    });
  });
});

/**
 * Step 4 - ATOMICITY over a file-backed store. DoD-3 says ONE transaction moves the attempt to
 * ACTIVE **and** writes the marker. Two sequential commits would satisfy every arm above and
 * differ only after a crash, which is why every assertion here is made AFTER close-and-reopen
 * and counts BOTH aggregates' raw events, not the call's return value.
 */
describe("cutover.activate is one transaction or none", () => {
  /**
   * Corrupts the SECOND leg's fence and nothing else, so the store refuses mid-transaction with
   * the first leg already appended inside it. Every earlier fence is crossed intact by this
   * fixture - the admission admits, core's gate grants, the fold is PRESENT/ACTIVATE_APPROVED,
   * the reducer accepts the edge, the binding matches and the generations match - so the store
   * is the only layer that can answer. Loosening the injection (leaving the leg untouched)
   * makes the call SUCCEED and reds this arm's unchanged-count assertions, which is what makes
   * it isolating rather than merely red.
   */
  function breakSecondLeg(store: SqliteEventStore): CutoverActivateStore {
    return {
      commitExpectedVersionDecisionLegs: (input) => store.commitExpectedVersionDecisionLegs({
        ...input,
        legs: input.legs.map((leg, index) => (index === 1 ? { ...leg, expectedVersion: 99 } : leg)),
      }),
      getCommandDecision: (key) => store.getCommandDecision(key),
      readEvents: (aggregateId) => store.readEvents(aggregateId),
    };
  }

  /** Moves the already-read readiness aggregate immediately before the decision commits. */
  function driftReadinessBeforeCommit(
    store: SqliteEventStore,
    generations: CutoverGenerations,
  ): CutoverActivateStore {
    return {
      commitExpectedVersionDecisionLegs: (input) => {
        seedReadiness(store, generations, { windowsPackagingEvidenceSha256: "0f".repeat(32) });
        return store.commitExpectedVersionDecisionLegs(input);
      },
      getCommandDecision: (key) => store.getCommandDecision(key),
      readEvents: (aggregateId) => store.readEvents(aggregateId),
    };
  }

  it("carries readiness as exactly one empty-event third leg at the version already read", () => {
    withHarness((harness) => {
      const live = liveGenerations(harness);
      const record = bindingOf(live);
      seedToActivateApproved(harness.store, record);
      let observed: Readonly<{ aggregateId: string; eventCount: number; expectedVersion: number }>
        | undefined;
      const inspecting: CutoverActivateStore = {
        commitExpectedVersionDecisionLegs: (input) => {
          const readinessLeg = input.legs[2];
          if (readinessLeg !== undefined) {
            observed = Object.freeze({
              aggregateId: readinessLeg.aggregateId,
              eventCount: readinessLeg.events.length,
              expectedVersion: readinessLeg.expectedVersion,
            });
          }
          expect(input.legs).toHaveLength(3);
          return harness.store.commitExpectedVersionDecisionLegs(input);
        },
        getCommandDecision: (key) => harness.store.getCommandDecision(key),
        readEvents: (aggregateId) => harness.store.readEvents(aggregateId),
      };

      const result = activateCutover(inspecting, harness.ports, {
        activatedAtEpochMs: ACTIVATED_AT,
        correlationId: "correlation-readiness-leg",
        decidedAt: DECIDED_AT,
        projectId: PROJECT_ID,
        record,
      });

      expect(result.ok).toBe(true);
      expect(observed).toEqual({
        aggregateId: deriveV2ReadinessManifestAggregateId(PROJECT_ID),
        eventCount: 0,
        expectedVersion: 1,
      });
    });
  });

  it("rolls the ATTEMPT leg back when the MARKER leg fails, proven after a reopen", () => {
    withHarness((harness) => {
      const record = bindingOf(liveGenerations(harness));
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const result = activateCutover(breakSecondLeg(harness.store), harness.ports, {
        activatedAtEpochMs: ACTIVATED_AT, correlationId: "correlation-atomic",
        decidedAt: DECIDED_AT, projectId: PROJECT_ID, record,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result as { code?: string }).code).toBe("CUTOVER_ACTIVATE_EXPECTED_VERSION_CONFLICT");
      expect((result as { layer?: string }).layer).toBe(CUTOVER_ACTIVATE_LAYER);
      // The property: NO BUSINESS EFFECT survived. Asserted after close-and-reopen, over raw
      // event cardinalities on BOTH aggregates - an assertion on the return value alone cannot
      // tell a refused commit from a half-written one.
      harness.reopen();
      const after = counts(harness.store);
      expect([after.attempt, after.marker]).toEqual([before.attempt, before.marker]);
      // The ledger DOES grow by one, and that is the store working as designed: a refused
      // expected-version decision is recorded as durable evidence that it was refused. What
      // matters is that it carries NO_BUSINESS_EFFECT, so it can never be replayed as an
      // activation. Asserting the count alone would have hidden which of the two it was.
      expect(after.decisions).toBe(before.decisions + 1);
      const decisions = harness.store.readCommandDecisionsAfter(0n, 100).items;
      expect(decisions.at(-1)?.effectDisposition).toBe("NO_BUSINESS_EFFECT");
      expect(decisions.filter((entry) => entry.commandKind === "cutover.activate")
        .every((entry) => entry.effectDisposition === "NO_BUSINESS_EFFECT")).toBe(true);
      expect(harness.store.getAggregateVersion(deriveCutoverAttemptAggregateId(PROJECT_ID)))
        .toBe(before.attempt);
      expect(harness.store.getAggregateVersion(deriveCutoverActivationMarkerAggregateId(PROJECT_ID)))
        .toBe(0);
      expect(readCutoverActivationMarker(harness.store, { projectId: PROJECT_ID })).toBeNull();
    });
  });

  it("fences the already-read readiness version and rolls both writes back when it moves", () => {
    withHarness((harness) => {
      const live = liveGenerations(harness);
      const record = bindingOf(live);
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const result = activateCutover(driftReadinessBeforeCommit(harness.store, live), harness.ports, {
        activatedAtEpochMs: ACTIVATED_AT,
        correlationId: "correlation-readiness-race",
        decidedAt: DECIDED_AT,
        projectId: PROJECT_ID,
        record,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result as { code?: string }).code).toBe("CUTOVER_ACTIVATE_EXPECTED_VERSION_CONFLICT");
      expect((result as { layer?: string }).layer).toBe(CUTOVER_ACTIVATE_LAYER);
      harness.reopen();
      const after = counts(harness.store);
      expect(after.attempt).toBe(before.attempt);
      expect(after.marker).toBe(before.marker);
      expect(after.readiness).toBe(before.readiness + 1);
      expect(after.decisions).toBe(before.decisions + 1);
      expect(harness.store.readCommandDecisionsAfter(0n, 100).items.at(-1)?.effectDisposition)
        .toBe("NO_BUSINESS_EFFECT");
    });
  });

  it("advances BOTH aggregates exactly once on success, proven after a reopen", () => {
    withHarness((harness) => {
      const live = liveGenerations(harness);
      const record = bindingOf(live);
      seedToActivateApproved(harness.store, record);
      const before = counts(harness.store);

      const result = activate(harness, record);
      expect(result.ok).toBe(true);

      harness.reopen();
      const after = counts(harness.store);
      expect([after.attempt - before.attempt, after.marker - before.marker]).toEqual([1, 1]);
      expect(after.readiness).toBe(before.readiness);
      expect(harness.store.getAggregateVersion(deriveCutoverActivationMarkerAggregateId(PROJECT_ID)))
        .toBe(1);
      const marker = readCutoverActivationMarker(harness.store, { projectId: PROJECT_ID });
      expect(marker?.generations).toEqual(live);
      expect(marker?.sourceCommit).toBe(SOURCE_COMMIT);
    });
  });

  it("replays identical bytes with ZERO new decision and ZERO new event rows", () => {
    withHarness((harness) => {
      const record = bindingOf(liveGenerations(harness));
      seedToActivateApproved(harness.store, record);

      const first = activate(harness, record);
      expect(first.ok).toBe(true);
      const afterFirst = counts(harness.store);

      const second = activate(harness, record);

      expect(second.ok).toBe(true);
      if (!second.ok || !first.ok) return;
      expect(second.disposition).toBe("REPLAYED");
      expect(second.marker).toEqual(first.marker);
      expect(second.commandId).toBe(first.commandId);
      // Counts with denominators, not the disposition: the disposition is what the code SAYS,
      // these are what the database DID.
      const afterSecond = counts(harness.store);
      expect(afterSecond.attempt).toBe(afterFirst.attempt);
      expect(afterSecond.marker).toBe(afterFirst.marker);
      expect(afterSecond.decisions).toBe(afterFirst.decisions);
      harness.reopen();
      expect(counts(harness.store)).toEqual(afterFirst);
    });
  });

  it("refuses replay after even byte-identical readiness is appended at a new durable version", () => {
    withHarness((harness) => {
      const live = liveGenerations(harness);
      const record = bindingOf(live);
      seedToActivateApproved(harness.store, record);
      expect(activate(harness, record).ok).toBe(true);
      seedReadiness(harness.store, live);
      const beforeReplay = counts(harness.store);

      const replay = activate(harness, record);

      expect(replay.ok).toBe(false);
      if (replay.ok) return;
      expect((replay as { code?: string }).code).toBe("CUTOVER_ACTIVATE_REPLAY_DIVERGED");
      expect((replay as { layer?: string }).layer).toBe(CUTOVER_ACTIVATE_LAYER);
      expect(counts(harness.store)).toEqual(beforeReplay);
    });
  });
});

/**
 * The first Product Contract/compiler mutation waits for the `/2` marker. Legacy runtime kinds
 * are deliberately outside this gate: membership in the global tuple is not v2 authority.
 */
describe("the first v2 authoritative command waits for the marker", () => {
  it("refuses product_contract.propose_revision BEFORE the activation and admits it AFTER", () => {
    withHarness((harness) => {
      const record = bindingOf(liveGenerations(harness));
      seedToActivateApproved(harness.store, record);

      const before = admitV2AuthoritativeCommand(harness.store, {
        commandKind: "product_contract.propose_revision", projectId: PROJECT_ID,
      });
      expect(before.ok).toBe(false);
      if (before.ok) return;
      expect(before.code).toBe("CUTOVER_V2_NOT_ACTIVE");
      expect(before.layer).toBe("DAEMON_CUTOVER_V2_AUTHORITY");

      expect(activate(harness, record).ok).toBe(true);
      harness.reopen();

      const after = admitV2AuthoritativeCommand(harness.store, {
        commandKind: "product_contract.propose_revision", projectId: PROJECT_ID,
      });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.commandKind).toBe("product_contract.propose_revision");
      expect(after.marker.schemaVersion).toBe("moe-cutover-activation-marker/2");
    });
  });

  it("admits exactly the five static v2 mutations after activation", () => {
    withHarness((harness) => {
      const record = bindingOf(liveGenerations(harness));
      seedToActivateApproved(harness.store, record);
      expect(activate(harness, record).ok).toBe(true);

      expect(V2_MUTATION_COMMAND_KINDS).toHaveLength(5);
      for (const commandKind of V2_MUTATION_COMMAND_KINDS) {
        expect(admitV2AuthoritativeCommand(harness.store, { commandKind, projectId: PROJECT_ID }))
          .toMatchObject({ commandKind, ok: true });
      }
    });
  });

  it("refuses a known legacy runtime command because the v2 roster is not the global roster", () => {
    withHarness((harness) => {
      const record = bindingOf(liveGenerations(harness));
      seedToActivateApproved(harness.store, record);
      expect(activate(harness, record).ok).toBe(true);

      const refused = admitV2AuthoritativeCommand(harness.store, {
        commandKind: "goal.create", projectId: PROJECT_ID,
      });

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("CUTOVER_V2_COMMAND_UNKNOWN");
    });
  });

  it("never treats a forensic /1 marker as v2 authority", () => {
    withHarness((harness) => {
      const generations = liveGenerations(harness);
      const payload = encodeLegacyCutoverActivationMarker({
        activatedAtEpochMs: ACTIVATED_AT,
        generations,
        schemaVersion: "moe-cutover-activation-marker/1",
        sourceCommit: SOURCE_COMMIT,
      });
      const aggregateId = deriveLegacyCutoverActivationMarkerAggregateId(PROJECT_ID);
      harness.store.commit({
        aggregateId,
        commandBytes: payload,
        commandId: "legacy-marker",
        committedAt: DECIDED_AT,
        events: [{
          eventId: "legacy-marker-event",
          eventType: LEGACY_CUTOVER_ACTIVATION_MARKER_EVENT_TYPE,
          payload,
        }],
        expectedVersion: 0,
      });

      expect(admitV2AuthoritativeCommand(harness.store, {
        commandKind: "product_contract.propose_revision",
        projectId: PROJECT_ID,
      })).toEqual({
        code: "CUTOVER_V2_NOT_ACTIVE",
        layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        ok: false,
      });
    });
  });

  it("withholds v2 authority when readiness no longer matches the marker binding", () => {
    withHarness((harness) => {
      const live = liveGenerations(harness);
      const record = bindingOf(live);
      seedToActivateApproved(harness.store, record);
      expect(activate(harness, record).ok).toBe(true);
      seedReadiness(harness.store, live);

      expect(admitV2AuthoritativeCommand(harness.store, {
        commandKind: "product_contract.propose_revision",
        projectId: PROJECT_ID,
      })).toEqual({
        code: "CUTOVER_V2_NOT_ACTIVE",
        layer: "DAEMON_CUTOVER_V2_AUTHORITY",
        ok: false,
      });
    });
  });

  it("pins the gate's roster as exact, nonzero and frozen", () => {
    expect(Object.isFrozen(CUTOVER_V2_AUTHORITY_CODES)).toBe(true);
    expect([...CUTOVER_V2_AUTHORITY_CODES].sort())
      .toEqual(["CUTOVER_V2_COMMAND_UNKNOWN", "CUTOVER_V2_NOT_ACTIVE"]);
    expect(CUTOVER_V2_AUTHORITY_CODES.length).toBeGreaterThan(0);
  });
});
