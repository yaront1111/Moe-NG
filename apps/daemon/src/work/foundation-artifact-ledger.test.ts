import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  cleanupGoalClosureFixtures, seedProvenAttempt,
} from "../goals/goal-closure-test-fixtures.js";
import type { SeedProvenAttemptOptions, SeededAttempt } from "../goals/goal-closure-test-fixtures.js";
import { seedReadyProject } from "../recovery/restore-test-harness.js";
import {
  FOUNDATION_ARTIFACT_EVENT_TYPE, deriveFoundationArtifactAggregateId,
  readFoundationArtifactForAttempt, readFoundationArtifactManifest,
  sealFoundationArtifactRoster,
} from "./foundation-artifact-ledger.js";
import {
  canonicalArtifactRoster, deriveFoundationArtifactDigest,
} from "./foundation-artifact-manifest.js";
import {
  decodeFoundationPayload, encodeFoundationPayload,
} from "./foundation-attempt-codec.js";
import { readFoundationAttemptRecord } from "./foundation-attempt-store.js";

import type { FoundationArtifactLedgerOutcome } from "./foundation-artifact-ledger.js";

/**
 * THE FOUNDATION ARTIFACT-ROSTER SEAL, graded against the human OPTION-A ruling
 * (task-4a318d03, comment-a662f748). The ruling authorizes sealing the closed-M1
 * EMPTY roster as observed truth and attaches two conditions, and those two
 * conditions are what most of this file tests:
 *
 *   1. A sealed empty must be provably DIFFERENT from never-enumerated.
 *   2. A caller-supplied NONEMPTY roster must still be REFUSED on this lane.
 *
 * EVERY DURABLE ASSERTION READS THE STORE, not the writer's return value. A
 * writer that answered correctly and wrote nothing — or wrote twice — would sail
 * through a return-value-only arm, and the rows are the fact the consumer
 * (task-a20e8ef6) will actually read.
 *
 * THE SEAL IS NEVER CALLED DIRECTLY TO PROVE THE LANE. Arms A, B and C reach it
 * only through `recordProvenFoundationAttempt` via the production seed, so they
 * prove the LANE refuses or seals rather than that a predicate returns false.
 * `sealFoundationArtifactRoster` is called directly ONLY in arm D, where the
 * subject is replay identity rather than lane policy.
 */

const LEDGER_LAYER = "DAEMON_FOUNDATION_ARTIFACT_LEDGER";
const HEX64 = /^[0-9a-f]{64}$/u;
const scratch: string[] = [];

afterAll(() => {
  cleanupGoalClosureFixtures();
  while (scratch.length > 0) {
    rmSync(scratch.pop() as string, { force: true, maxRetries: 5, recursive: true });
  }
});

/**
 * FILE-BACKED, per DoD 4 — `openEphemeralForProjectTest` is `:memory:` and would
 * not exercise the durability path the consumer reads through. The project is
 * driven to READY through the REAL bootstrap chain (`seedReadyProject`), not
 * written by hand: a fresh file-backed store has no bootstrap ledger, and
 * `goal.create` refuses `BOOTSTRAP_PREREQUISITE_MISSING` without it.
 *
 * Opened inside a case and closed in `finally`: a held sqlite handle kills the
 * vitest worker on Windows.
 */
function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-artifact-${name}-`));
  scratch.push(directory);
  const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
  try {
    seedReadyProject(store);
    return run(store);
  } finally { store.close(); }
}

function artifactRows(store: SqliteEventStore, dispatchAggregateId: string): number {
  const aggregate = deriveFoundationArtifactAggregateId(dispatchAggregateId);
  return store.readEvents(aggregate)
    .filter((event) => event.eventType === FOUNDATION_ARTIFACT_EVENT_TYPE).length;
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (typeof found !== "object" || found === null) throw new TypeError(`${key} is not a record`);
  return found as Record<string, unknown>;
}

/** The durable result manifest of the seeded attempt, read back out of the store. */
function resultManifestSha(store: SqliteEventStore, seeded: SeededAttempt): string {
  const stored = readFoundationAttemptRecord(store, seeded.attemptAggregateId);
  if (!stored.ok) throw new Error(`attempt record unreadable: ${stored.code}`);
  return nested(stored.record, "resultManifest")["sha256"] as string;
}

function attemptReason(store: SqliteEventStore, seeded: SeededAttempt): Record<string, unknown> {
  const stored = readFoundationAttemptRecord(store, seeded.attemptAggregateId);
  if (!stored.ok) throw new Error(`attempt record unreadable: ${stored.code}`);
  return stored.record;
}

function seed(
  store: SqliteEventStore, label: string, options: SeedProvenAttemptOptions = {},
): SeededAttempt {
  return seedProvenAttempt(store, "node-1", label, options);
}

function expectRefusal(
  outcome: FoundationArtifactLedgerOutcome, code: string, layer: string,
): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.code).toBe(code);
  expect(outcome.layer).toBe(layer);
}

const REF_A = Object.freeze({ byteLength: 11, sha256: "a".repeat(64) });
const REF_B = Object.freeze({ byteLength: 22, sha256: "b".repeat(64) });

describe("foundation artifact seal — the AUTHORIZED EMPTY roster is durable truth", () => {
  it("seals a 64-hex digest, a STATED zero count and the enumeration binding", () => {
    withStore("empty", (store) => {
      const seeded = seed(store, "artifact-empty");
      // ASSERTED FIRST, so a refused seal reports ITS OWN CODE here rather than
      // surfacing as a null result manifest three assertions later.
      const settled = attemptReason(store, seeded);
      expect(settled["reasonCode"]).toBeNull();
      expect(settled["truthClass"]).toBe("PROVEN");
      const manifestSha = resultManifestSha(store, seeded);

      const read = readFoundationArtifactManifest(
        store, { attemptAggregateId: seeded.dispatchAggregateId, projectId: PROJECT_ID });

      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const { manifest } = read;
      expect(manifest.artifactDigest).toMatch(HEX64);
      // STATED, not inferred: the count is the observation half of the denominator.
      expect(manifest.artifactRefCount).toBe(0);
      expect(manifest.artifactRefs).toStrictEqual([]);
      // THE BINDING half — present only because the capture answered and the
      // result manifest built. This is what a never-enumerated roster cannot have.
      expect(manifest.resultManifestSha256).toBe(manifestSha);
      expect(manifest.attemptRef).toBe(seeded.attemptRef);
      expect(manifest.projectId).toBe(PROJECT_ID);
      expect(manifest.manifestVersion).toBe("moe-foundation-artifact-manifest/1");
      // RAW COUNT OUT OF THE STORE: exactly one row, and it is the seal's own type.
      expect(artifactRows(store, seeded.dispatchAggregateId)).toBe(1);
      const events = store.readEvents(
        deriveFoundationArtifactAggregateId(seeded.dispatchAggregateId));
      expect(events.map((event) => event.eventType)).toStrictEqual([
        FOUNDATION_ARTIFACT_EVENT_TYPE,
      ]);
      // AND THE ATTEMPT SETTLED PROVEN — a seal that refused would have forced
      // the advisory UNKNOWN branch instead, so this pins the ordering too.
      expect(attemptReason(store, seeded)["truthClass"]).toBe("PROVEN");
    });
  });

  it("derives a digest that is NOT the result-manifest sha256 of the same attempt", () => {
    withStore("digest-discipline", (store) => {
      const seeded = seed(store, "artifact-discipline");
      const manifestSha = resultManifestSha(store, seeded);

      const read = readFoundationArtifactManifest(
        store, { attemptAggregateId: seeded.dispatchAggregateId, projectId: PROJECT_ID });

      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // RAIL 1 AS A TEST RATHER THAN A COMMENT. `resultTreeSha256` IS
      // `resultManifest.sha256` on this lane (`evidence-receipt.ts:202`), so
      // returning it here would be the exact substitution rail 1 names.
      expect(manifestSha).toMatch(HEX64);
      expect(read.manifest.artifactDigest).not.toBe(manifestSha);
      expect(read.manifest.resultManifestSha256).toBe(manifestSha);
    });
  });
});

describe("foundation artifact seal — CONDITION 1: sealed-empty and never-enumerated differ", () => {
  it("answers ABSENT at its own layer with ZERO rows when the capture never answered", () => {
    withStore("not-enumerated", (store) => {
      // NOT-ENUMERATED REACHED HONESTLY: the same production chain, with a capture
      // answer the store's own `exactKeys` fence refuses at :215-217 — before any
      // seal is attempted. Nothing here reaches around the writer.
      const seeded = seed(store, "artifact-unanswered", { answer: { authoredPaths: [] } });
      const durable = attemptReason(store, seeded);
      expect(durable["reasonCode"]).toBe("FOUNDATION_ATTEMPT_CAPTURE_UNKNOWN");
      expect(durable["truthClass"]).toBe("UNKNOWN");
      expect(durable["resultManifest"]).toBeNull();

      const read = readFoundationArtifactManifest(
        store, { attemptAggregateId: seeded.dispatchAggregateId, projectId: PROJECT_ID });

      expectRefusal(read, "FOUNDATION_ARTIFACT_LEDGER_ABSENT", LEDGER_LAYER);
      expect(artifactRows(store, seeded.dispatchAggregateId)).toBe(0);
    });
  });

  it("gives the two cases DIFFERENT durable outcomes in one store", () => {
    withStore("condition-one", (store) => {
      // BOTH SIDES SIDE BY SIDE. Separately each arm could pass while the seal was
      // a no-op or the reader always refused; together they cannot.
      const sealedAttempt = seed(store, "artifact-both-sealed");
      const unanswered = seed(
        store, "artifact-both-unanswered", { answer: { authoredPaths: [] } });

      const observedEmpty = readFoundationArtifactManifest(
        store, { attemptAggregateId: sealedAttempt.dispatchAggregateId, projectId: PROJECT_ID });
      const neverEnumerated = readFoundationArtifactManifest(
        store, { attemptAggregateId: unanswered.dispatchAggregateId, projectId: PROJECT_ID });

      expect(observedEmpty.ok).toBe(true);
      expectRefusal(neverEnumerated, "FOUNDATION_ARTIFACT_LEDGER_ABSENT", LEDGER_LAYER);
      // The empty roster is IDENTICAL in both worlds; only the enumeration proof
      // differs. That is the whole point of the condition.
      expect(observedEmpty.ok && observedEmpty.manifest.artifactRefCount).toBe(0);
      expect(artifactRows(store, sealedAttempt.dispatchAggregateId)).toBe(1);
      expect(artifactRows(store, unanswered.dispatchAggregateId)).toBe(0);
    });
  });
});

describe("foundation artifact seal — CONDITION 2: the lane REFUSES caller-handed refs", () => {
  it("refuses a nonempty roster offered through the production writer, writing no row", () => {
    withStore("unauthorized", (store) => {
      // REACHED THROUGH THE PRODUCTION SEAM. Everything except the roster is the
      // real capture answer, so the attempt is valid up to the fence and this arm
      // proves the LANE refuses rather than that a predicate returns false.
      const seeded = seed(
        store, "artifact-unauthorized", { declaredArtifactRefs: [REF_A] });

      const durable = attemptReason(store, seeded);
      expect(durable["reasonCode"]).toBe("FOUNDATION_ARTIFACT_LEDGER_ROSTER_UNAUTHORIZED");
      expect(durable["reasonLayer"]).toBe(LEDGER_LAYER);
      // A REFUSED SEAL MUST NOT SETTLE PROVEN.
      expect(durable["truthClass"]).toBe("UNKNOWN");
      expect(artifactRows(store, seeded.dispatchAggregateId)).toBe(0);

      const read = readFoundationArtifactManifest(
        store, { attemptAggregateId: seeded.dispatchAggregateId, projectId: PROJECT_ID });
      expectRefusal(read, "FOUNDATION_ARTIFACT_LEDGER_ABSENT", LEDGER_LAYER);
    });
  });
});

describe("foundation artifact seal — identity, replay and bindings", () => {
  it("is idempotent on identical bytes and fences a differing body", () => {
    withStore("replay", (store) => {
      const seeded = seed(store, "artifact-replay");
      const manifestSha = resultManifestSha(store, seeded);
      const request = {
        attemptAggregateId: seeded.dispatchAggregateId, attemptRef: seeded.attemptRef,
        commandId: seeded.bound.commandId, correlationId: seeded.bound.correlationId,
        declaredArtifactRefs: [], inputManifestSha256: "c".repeat(64),
        principalId: seeded.bound.principalId, projectId: PROJECT_ID,
        resultManifestSha256: manifestSha,
      };

      // The production seal already ran; re-deriving the SAME body adopts the row.
      const replay = sealFoundationArtifactRoster(store, {
        ...request,
        inputManifestSha256: readInputManifestSha(store, seeded),
      });
      expect(replay.ok).toBe(true);
      expect(artifactRows(store, seeded.dispatchAggregateId)).toBe(1);

      // A DIFFERING body is a real conflict, not a second truth.
      const conflicting = sealFoundationArtifactRoster(store, {
        ...request, resultManifestSha256: "d".repeat(64),
      });
      expectRefusal(conflicting, "FOUNDATION_ARTIFACT_LEDGER_CONFLICT", LEDGER_LAYER);
      expect(artifactRows(store, seeded.dispatchAggregateId)).toBe(1);
    });
  });

  it("refuses a durable row whose artifactDigest does not seal its own roster", () => {
    withStore("forged-digest", (store) => {
      const seeded = seed(store, "artifact-forged");
      const aggregate = deriveFoundationArtifactAggregateId(seeded.dispatchAggregateId);
      const sealedRow = store.readEvents(aggregate)[0];
      expect(sealedRow).toBeDefined();
      if (sealedRow === undefined) return;
      const decoded = decodeFoundationPayload(sealedRow.payload);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      // A FORGED ROW, canonical in every other respect: re-encoding it reproduces
      // its own bytes, so the byte-compare alone would pass it. Only re-deriving
      // the digest FROM THE ROSTER catches a digest that belongs to nothing.
      const forged = encodeFoundationPayload({
        ...decoded.value, artifactDigest: "e".repeat(64),
      });
      expect(forged.ok).toBe(true);
      if (!forged.ok) return;
      store.commitExpectedVersionDecision({
        commandKind: "foundation.artifact.seal", committedResultBytes: forged.bytes,
        correlationId: "corr-forged", decidedAt: sealedRow.committedAt,
        events: [{
          eventId: `${forged.digest}:ARTIFACT`,
          eventType: FOUNDATION_ARTIFACT_EVENT_TYPE, payload: forged.bytes,
        }],
        expectedVersion: store.readEvents(aggregate).length,
        key: { commandId: "cmd-forged", principalId: "principal-1", projectId: PROJECT_ID },
        requestBytes: forged.bytes, targetAggregateId: aggregate,
      });
      // LATEST WINS, so the forged row is the one the reader now decodes.
      expect(artifactRows(store, seeded.dispatchAggregateId)).toBe(2);

      const read = readFoundationArtifactManifest(
        store, { attemptAggregateId: seeded.dispatchAggregateId, projectId: PROJECT_ID });

      expectRefusal(read, "FOUNDATION_ARTIFACT_LEDGER_DRIFT", LEDGER_LAYER);
    });
  });

  it("refuses a foreign project and a foreign attempt under distinct codes", () => {
    withStore("bindings", (store) => {
      const seeded = seed(store, "artifact-bindings");
      const query = {
        attemptAggregateId: seeded.dispatchAggregateId, projectId: PROJECT_ID,
      };

      expectRefusal(
        readFoundationArtifactManifest(store, { ...query, projectId: "project-foreign" }),
        "FOUNDATION_ARTIFACT_LEDGER_PROJECT_MISMATCH", LEDGER_LAYER);
      expectRefusal(
        readFoundationArtifactForAttempt(store, query, "attempt-foreign"),
        "FOUNDATION_ARTIFACT_LEDGER_ATTEMPT_MISMATCH", LEDGER_LAYER);
      // The same read with the RIGHT attempt still answers, so the two arms above
      // are refusing on the binding rather than on a row that was never readable.
      expect(readFoundationArtifactForAttempt(store, query, seeded.attemptRef).ok).toBe(true);
    });
  });
});

describe("foundation artifact manifest — the canonical roster", () => {
  it("digests a shuffled roster identically and a different roster differently", () => {
    // ORDER-INDEPENDENCE IS A PROPERTY OF THE PRODUCTION SURFACE, asserted here
    // against a NONEMPTY roster — which the Foundation lane may not seal, and
    // which is exactly why this arm calls the canonical module rather than the
    // lane. A roster that hashed in caller order would make the digest
    // unreproducible for two callers holding the same set.
    const forward = canonicalArtifactRoster([REF_A, REF_B]);
    const reversed = canonicalArtifactRoster([REF_B, REF_A]);
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(reversed.refs).toStrictEqual(forward.refs);

    const one = deriveFoundationArtifactDigest(forward.refs);
    const two = deriveFoundationArtifactDigest(reversed.refs);
    const alone = deriveFoundationArtifactDigest([REF_A]);
    expect(one.ok && two.ok && alone.ok).toBe(true);
    if (!one.ok || !two.ok || !alone.ok) return;
    expect(two.digest).toBe(one.digest);
    // NEGATIVE CONTROL: a digest equal for every input would pass the line above.
    expect(alone.digest).not.toBe(one.digest);
    expect(one.digest).toMatch(HEX64);
  });

  it("refuses a duplicate ref rather than silently deduping it", () => {
    const duplicated = canonicalArtifactRoster([REF_A, { ...REF_A }]);
    expect(duplicated.ok).toBe(false);
    if (duplicated.ok) return;
    expect(duplicated.code).toBe("FOUNDATION_ARTIFACT_ROSTER_MALFORMED");
    expect(duplicated.layer).toBe("DAEMON_FOUNDATION_ARTIFACT");
  });
});

/** The seeded attempt's own input-manifest sha, read back out of the durable record. */
function readInputManifestSha(store: SqliteEventStore, seeded: SeededAttempt): string {
  const stored = readFoundationAttemptRecord(store, seeded.attemptAggregateId);
  if (!stored.ok) throw new Error(`attempt record unreadable: ${stored.code}`);
  return nested(stored.record, "inputManifest")["sha256"] as string;
}
