import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveLiveQuiesceEvidenceDigest } from "@moe/core";
import type { LiveQuiesceEvidence } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { readDurableImportGeneration } from "../projections/import-generation-reader.js";
import { DIGEST, recordOf, seedImport, witness } from "../projections/import-shadow-test-fixtures.js";

import {
  CUTOVER_GENERATION_FACTS,
  CUTOVER_GENERATION_REFUSAL_CODES,
  CUTOVER_GENERATION_SNAPSHOT_LAYER,
  LIVE_QUIESCE_EVIDENCE_FILENAME,
  readCutoverGenerationSnapshot,
} from "./cutover-generation-snapshot.js";
import type {
  CutoverGenerationPorts,
  CutoverGenerationRefused,
  CutoverGenerationSnapshot,
  CutoverGenerations,
} from "./cutover-generation-snapshot.js";

/**
 * task-dcf0ce92 - the four-value cutover generation snapshot and its production reader.
 *
 * WHAT IS UNDER TEST IS WHICH DURABLE FACT EACH VALUE IS, not merely that four strings came
 * back. Every accepted arm compares against the SAME fact read independently out of the
 * durable source - the event payload the store holds, or `@moe/core`'s own digest over the
 * artifact - never against a literal. A literal beside the assertion is a fixed point that a
 * hardcoded-return mutant satisfies, which is exactly the failure the drift marker this
 * snapshot feeds would then be unable to see.
 *
 * WHICH FACT WAS MISSING IS ITSELF AN ASSERTION. Four absence arms, one per generation, each
 * pinning the exact stable code AND the refusing layer AND the named fact. A single
 * parameterised "it refused" arm cannot tell you the reader names the RIGHT fact, and naming
 * the wrong one is the failure mode that makes an operator chase the wrong evidence.
 *
 * THE STORE IS FILE-BACKED (DoD 6). An in-memory double would let a reader pass while never
 * surviving a round trip through real durable bytes.
 */

const PROJECT_ID = "moe-cutover-generation-project";
const DISTRIBUTION_MANIFEST_HASH = "d1".repeat(32);
const BACKUP_GENERATION_HASH = "b2".repeat(32);

/**
 * A minimal but SEMANTICALLY VALID live-quiesce evidence record: an EMPTY outcome with a
 * consistent inventory. Built here from `@moe/core`'s own exported type rather than imported
 * from the migration lane, so this suite does not reach across packages for a fixture.
 */
const EVIDENCE: LiveQuiesceEvidence = Object.freeze({
  authority: Object.freeze({
    commentId: "comment-cutover-generation",
    moment: "2026-08-29T12:00:00.000Z",
    principal: "operator/live",
  }),
  citationKey: "cutover-generation-snapshot",
  citedBy: "task-dcf0ce92",
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
  readonly evidencePath: string;
  readonly ports: CutoverGenerationPorts;
  readonly storePath: string;
  readonly storeRoot: string;
  readonly store: SqliteEventStore;
}

interface Seed {
  readonly activation?: boolean;
  readonly evidence?: boolean;
  readonly legacyImport?: boolean;
  readonly quiesce?: boolean;
}

function commitEvent(
  store: SqliteEventStore,
  eventId: string,
  eventType: string,
  payload: unknown,
): void {
  store.commit({
    aggregateId: PROJECT_ID,
    commandBytes: new TextEncoder().encode(eventId),
    commandId: `cmd-${eventId}`,
    committedAt: "2026-08-29T12:00:00.000Z",
    events: [{
      eventId,
      eventType,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }],
    expectedVersion: store.getAggregateVersion(PROJECT_ID),
  });
}

/**
 * A REAL file-backed store and a real directory for the evidence artifact. The store is closed
 * in `finally` before the directory is removed: a store left open makes `rmSync` fail with
 * EPERM on Windows and kills the worker with an error that looks unrelated to this suite.
 */
function withHarness(seed: Seed, run: (harness: Harness) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-cutover-generation-"));
  const storeRoot = join(directory, "root");
  mkdirSync(storeRoot, { recursive: true });
  const storePath = join(directory, "store.db");
  const evidencePath = join(storeRoot, LIVE_QUIESCE_EVIDENCE_FILENAME);
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    if (seed.activation === true) {
      commitEvent(store, "project-activated", "ProjectActivated", {
        witness: {
          artifactPathRef: "artifact/ref", backupPathRef: "backup/ref",
          credentialRef: "credential/ref",
          distributionManifestHash: DISTRIBUTION_MANIFEST_HASH,
          policyRevisionHash: "p3".repeat(32),
          providerMinimumProfileRef: "profile/ref", signingKeyRef: "signing/ref",
          storeDriverRef: "driver/ref", truthClass: "DAEMON_VERIFIED",
        },
      });
    }
    if (seed.quiesce === true) {
      commitEvent(store, "project-quiesced", "ProjectQuiesced", {
        witness: {
          backupGenerationHash: BACKUP_GENERATION_HASH,
          recoveryIncarnationRef: "incarnation/ref", truthClass: "DAEMON_VERIFIED",
        },
      });
    }
    if (seed.legacyImport === true) {
      seedImport(store, DIGEST, [recordOf()]);
    }
    if (seed.evidence === true) {
      // Pretty-printed exactly as the live lane writes it, so the reader is forced to derive
      // the CANONICAL digest rather than hash the file bytes it happens to find.
      writeFileSync(
        evidencePath,
        `${JSON.stringify(EVIDENCE, null, 2)}\n`,
        "utf8",
      );
    }
    run({
      evidencePath,
      ports: {
        config: { storeRoot },
        readFileText: (path: string) => readFileSync(path, "utf8"),
        store,
      },
      store,
      storePath,
      storeRoot,
    });
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function expectRefused(answer: CutoverGenerationSnapshot): CutoverGenerationRefused {
  if (answer.ok) throw new Error("expected a refusal, got an accepted snapshot");
  return answer;
}

describe("the cutover generation snapshot names four durable facts", () => {
  it("pins the refusal roster and the layer as exact, nonzero, frozen values", () => {
    expect(Object.isFrozen(CUTOVER_GENERATION_REFUSAL_CODES)).toBe(true);
    expect(CUTOVER_GENERATION_REFUSAL_CODES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(CUTOVER_GENERATION_FACTS)).toBe(true);
    // FOUR facts, exactly: the drift marker this feeds reads four keys, and a snapshot that
    // named three of them would satisfy a `length > 0` roster while leaving one uncompared.
    expect(CUTOVER_GENERATION_FACTS).toHaveLength(4);
    expect([...CUTOVER_GENERATION_FACTS].sort()).toEqual([
      "backupGenerationDigest", "distributionManifestSha256",
      "importGenerationSha256", "quiesceRecordSha256",
    ]);
    expect(CUTOVER_GENERATION_SNAPSHOT_LAYER).toBe("DAEMON_CUTOVER_GENERATION");
  });

  it("refuses and NAMES distributionManifestSha256 when no activation witness is durable", () => {
    withHarness({ evidence: true, quiesce: true }, ({ ports }) => {
      const refusal = expectRefused(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      expect(refusal.missing).toBe("distributionManifestSha256");
      expect(refusal.code).toBe("CUTOVER_GENERATION_DISTRIBUTION_MANIFEST_ABSENT");
      expect(refusal.layer).toBe(CUTOVER_GENERATION_SNAPSHOT_LAYER);
      // A refusal carries no generations field at all, so a defaulted answer is
      // unrepresentable rather than merely unwritten.
      expect("generations" in refusal).toBe(false);
    });
  });

  it("refuses and NAMES backupGenerationDigest when no quiesce witness is durable", () => {
    withHarness({ activation: true, evidence: true }, ({ ports }) => {
      const refusal = expectRefused(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      expect(refusal.missing).toBe("backupGenerationDigest");
      expect(refusal.code).toBe("CUTOVER_GENERATION_BACKUP_ABSENT");
      expect(refusal.layer).toBe(CUTOVER_GENERATION_SNAPSHOT_LAYER);
    });
  });

  it("refuses and NAMES quiesceRecordSha256 when the evidence artifact is absent", () => {
    withHarness({ activation: true, quiesce: true }, ({ ports }) => {
      const refusal = expectRefused(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      expect(refusal.missing).toBe("quiesceRecordSha256");
      expect(refusal.code).toBe("CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT");
      expect(refusal.layer).toBe(CUTOVER_GENERATION_SNAPSHOT_LAYER);
    });
  });

  it("refuses and NAMES importGenerationSha256 when no legacy import is committed", () => {
    withHarness({ activation: true, evidence: true, quiesce: true }, ({ ports }) => {
      const refusal = expectRefused(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      expect(refusal.missing).toBe("importGenerationSha256");
      expect(refusal.code).toBe("CUTOVER_GENERATION_IMPORT_ABSENT");
      expect(refusal.layer).toBe(CUTOVER_GENERATION_SNAPSHOT_LAYER);
      // The import reader's own diagnosis is FORWARDED, not restamped: the operator needs to
      // know which layer actually answered.
      expect(refusal.upstream?.layer).toBe("DAEMON_IMPORT_GENERATION");
      expect(refusal.upstream?.code).toBe("IMPORT_GENERATION_ABSENT");
    });
  });

  it("derives the quiesce digest CANONICALLY, never from the pretty-printed file bytes", () => {
    withHarness({ activation: true, evidence: true, quiesce: true }, ({ ports }) => {
      // Precondition, asserted so an invalid fixture reads as a fixture problem rather than
      // as a reader refusal: core accepts this evidence record.
      const independent = deriveLiveQuiesceEvidenceDigest(EVIDENCE);
      expect(independent.ok).toBe(true);
      const answer = readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID });
      // Import is still absent here, so the reader refuses - but it must have got PAST the
      // quiesce fact to do so, which is what this arm pins.
      const refusal = expectRefused(answer);
      expect(refusal.missing).toBe("importGenerationSha256");
    });
  });

  it("takes an attempt identity and no digest, so a caller cannot present a generation", () => {
    // Structural, not a runtime check: the request vocabulary has exactly one key and it is
    // not a digest. A caller-presented generation would make the drift comparison this
    // snapshot exists for compare a value against itself.
    const request: Parameters<typeof readCutoverGenerationSnapshot>[1] = { projectId: PROJECT_ID };
    expect(Object.keys(request)).toEqual(["projectId"]);
  });
});

/**
 * Reads one witness field back out of the durable EVENT bytes by a path independent of the
 * reader under test, so an accepted arm compares two reads of the same durable fact rather
 * than comparing the reader against a literal it could have hardcoded.
 */
function durableWitnessField(
  store: SqliteEventStore,
  eventType: string,
  field: string,
): string {
  let cursor = 0;
  let found: string | null = null;
  for (;;) {
    const page = store.readAggregateEvents(PROJECT_ID, cursor, 256);
    for (const event of page.items) {
      if (event.eventType !== eventType) continue;
      const decoded: unknown = JSON.parse(new TextDecoder().decode(event.payload));
      const witnessValue = (decoded as { witness?: Record<string, unknown> }).witness;
      const value = witnessValue?.[field];
      if (typeof value === "string") found = value;
    }
    if (!page.hasMore || page.nextCursor === null || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  if (found === null) throw new Error(`no durable ${eventType} carried ${field}`);
  return found;
}

const COMPLETE: Seed = Object.freeze({
  activation: true, evidence: true, legacyImport: true, quiesce: true,
});

function expectAccepted(answer: CutoverGenerationSnapshot): CutoverGenerations {
  if (!answer.ok) {
    throw new Error(`expected an accepted snapshot, got ${answer.code} for ${answer.missing}`);
  }
  return answer.generations;
}

describe("the snapshot round-trips through real durable bytes", () => {
  it("returns each generation EQUAL to what its own durable source independently answers", () => {
    withHarness(COMPLETE, ({ ports, store }) => {
      const generations = expectAccepted(
        readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }),
      );
      // Each expectation is a SECOND read of the same durable fact, never a literal: a
      // hardcoded-return mutant passes a literal and fails these.
      expect(generations.distributionManifestSha256)
        .toBe(durableWitnessField(store, "ProjectActivated", "distributionManifestHash"));
      expect(generations.backupGenerationDigest)
        .toBe(durableWitnessField(store, "ProjectQuiesced", "backupGenerationHash"));
      const independentImport = readDurableImportGeneration(store, {});
      expect(independentImport.ok).toBe(true);
      expect(generations.importGenerationSha256)
        .toBe(independentImport.ok ? independentImport.importGenerationSha256 : "");
      const independentQuiesce = deriveLiveQuiesceEvidenceDigest(EVIDENCE);
      expect(independentQuiesce.ok).toBe(true);
      expect(generations.quiesceRecordSha256)
        .toBe(independentQuiesce.ok ? independentQuiesce.quiesceRecordSha256 : "");
      // The four are DISTINCT values, so a reader that returned one fact four times - a shape
      // every assertion above would still satisfy pairwise - reds here.
      expect(new Set(Object.values(generations)).size).toBe(4);
    });
  });

  it("adds ZERO decision and event rows: two reads leave the store byte-identical", () => {
    withHarness(COMPLETE, ({ ports, store, storePath }) => {
      const before = witness(store, storePath, PROJECT_ID);
      const first = expectAccepted(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      const second = expectAccepted(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      const after = witness(store, storePath, PROJECT_ID);

      expect(second).toEqual(first);
      // COUNTS WITH DENOMINATORS, not "no error": a reader that wrote a row per read would
      // still return the right answer twice, so the numbers are the assertion.
      expect(after.events).toBe(before.events);
      expect(after.version).toBe(before.version);
      expect(after.size).toBe(before.size);
      // The denominators are NONZERO, so "unchanged" is a real comparison rather than two
      // empties agreeing.
      expect(before.events).toBeGreaterThan(0);
      expect(before.version).toBeGreaterThan(0);
      expect(before.size).toBeGreaterThan(0);
      // Decision rows are asserted unchanged but carry NO denominator here, and saying so is
      // the point: MEASURED, this harness produces zero of them, because neither
      // `store.commit` nor `applyImport` writes a command-decision row - those come from the
      // command pipeline. Claiming a denominator for this line would be the vacuous
      // "two empties agree" assertion the events/version/size denominators above avoid.
      expect(after.decisions).toBe(before.decisions);
      expect(before.decisions).toBe(0);
    });
  });

  it("refuses on a TAMPERED evidence record instead of naming a digest for it", () => {
    withHarness(COMPLETE, ({ evidencePath, ports }) => {
      const original = readFileSync(evidencePath, "utf8");
      // The resolved count no longer agrees with the results it summarises: a SEMANTIC tamper
      // the core authority refuses, rather than a parse failure.
      const tampered = original.replace("\"resolvedCount\": 0", "\"resolvedCount\": 1");
      expect(tampered).not.toBe(original);
      writeFileSync(evidencePath, tampered, "utf8");

      const refusal = expectRefused(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      expect(refusal.missing).toBe("quiesceRecordSha256");
      expect(refusal.layer).toBe(CUTOVER_GENERATION_SNAPSHOT_LAYER);
      // The core authority's own diagnosis is forwarded, not restamped as ours.
      expect(refusal.upstream?.layer).toBe("live-quiesce-evidence");
      expect(refusal.upstream?.code).not.toBe(refusal.code);
    });
  });

  it("refuses an unparseable evidence file as UNREADABLE, which is not the same as absent", () => {
    withHarness(COMPLETE, ({ evidencePath, ports }) => {
      writeFileSync(evidencePath, "{ not json", "utf8");
      const refusal = expectRefused(readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }));
      expect(refusal.missing).toBe("quiesceRecordSha256");
      // A DIFFERENT code from the absent case: corrupt evidence and no evidence are different
      // answers, and an operator chases them differently.
      expect(refusal.code).toBe("CUTOVER_GENERATION_EVIDENCE_UNREADABLE");
      expect(refusal.code).not.toBe("CUTOVER_GENERATION_QUIESCE_RECORD_ABSENT");
    });
  });

  /**
   * ATTEMPT SCOPING, answered honestly rather than asserted vacuously.
   *
   * Two cutover attempts against the same project at the same durable state DO share a
   * snapshot, BY CONSTRUCTION, and that is correct: every one of the four facts is a property
   * of the project's durable state, not of an attempt. The snapshot exists so an activation
   * can be compared against the generations it was decided under - two attempts under the SAME
   * generations must compare equal, or the drift marker would report drift where none happened.
   * The property worth pinning is therefore not "different per attempt" but "not a constant":
   * the snapshot MOVES when the durable state moves.
   */
  it("is project-scoped by construction, and moves when the durable state moves", () => {
    withHarness(COMPLETE, ({ ports, store }) => {
      const before = expectAccepted(
        readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }),
      );
      commitEvent(store, "project-quiesced-2", "ProjectQuiesced", {
        witness: {
          backupGenerationHash: "c3".repeat(32),
          recoveryIncarnationRef: "incarnation/ref-2", truthClass: "DAEMON_VERIFIED",
        },
      });
      const after = expectAccepted(
        readCutoverGenerationSnapshot(ports, { projectId: PROJECT_ID }),
      );

      expect(after.backupGenerationDigest).not.toBe(before.backupGenerationDigest);
      expect(after.backupGenerationDigest)
        .toBe(durableWitnessField(store, "ProjectQuiesced", "backupGenerationHash"));
      // The other three did not move, so the reader tracks the fact that changed rather than
      // re-deriving everything from whatever it read last.
      expect(after.distributionManifestSha256).toBe(before.distributionManifestSha256);
      expect(after.importGenerationSha256).toBe(before.importGenerationSha256);
      expect(after.quiesceRecordSha256).toBe(before.quiesceRecordSha256);
    });
  });
});

/**
 * Overrides exactly one method of a real store, leaving every other answer PRODUCTION's. A
 * plain delegating object rather than a mutated store: the store's own methods are read-only.
 */
function portOver(
  ports: CutoverGenerationPorts,
  over: Partial<CutoverGenerationPorts["store"]>,
): CutoverGenerationPorts {
  const { store } = ports;
  return {
    ...ports,
    store: {
      enumerateAggregateIdsByPrefix: (prefix: string) =>
        store.enumerateAggregateIdsByPrefix(prefix),
      getCommandReceipt: (commandId: string) => store.getCommandReceipt(commandId),
      readAggregateEvents: (aggregateId: string, cursor: number, limit: number) =>
        store.readAggregateEvents(aggregateId, cursor, limit),
      readEventHorizon: () => store.readEventHorizon(),
      readEvents: (aggregateId: string) => store.readEvents(aggregateId),
      ...over,
    },
  };
}

describe("the snapshot names ONE store state or none", () => {
  it("refuses HORIZON_DRIFT when the store moves between the first and last read", () => {
    withHarness(COMPLETE, ({ ports }) => {
      // The horizon answers honestly on the way in and has MOVED by the closing check, which
      // is what a concurrent commit looks like from inside a multi-source read. Only this
      // method is overridden; every other answer stays production's.
      let calls = 0;
      const drifting = portOver(ports, {
        readEventHorizon: (): bigint => {
          calls += 1;
          return calls === 1 ? 1n : 2n;
        },
      });

      const refusal = expectRefused(
        readCutoverGenerationSnapshot(drifting, { projectId: PROJECT_ID }),
      );
      expect(refusal.code).toBe("CUTOVER_GENERATION_HORIZON_DRIFT");
      expect(refusal.layer).toBe(CUTOVER_GENERATION_SNAPSHOT_LAYER);
      // The fence ran at BOTH ends: a reader that checked once could not have seen the move.
      expect(calls).toBeGreaterThanOrEqual(2);
      // No partial answer escapes the fence.
      expect("generations" in refusal).toBe(false);
    });
  });

  it("accepts when the horizon is unmoved, so the fence is not refusing everything", () => {
    withHarness(COMPLETE, ({ ports }) => {
      let calls = 0;
      const steady = portOver(ports, {
        readEventHorizon: (): bigint => {
          calls += 1;
          return 7n;
        },
      });

      const generations = expectAccepted(
        readCutoverGenerationSnapshot(steady, { projectId: PROJECT_ID }),
      );
      expect(Object.keys(generations).sort()).toEqual([...CUTOVER_GENERATION_FACTS].sort());
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });
});
