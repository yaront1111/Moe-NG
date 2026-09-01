import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { scanGlobalEvents } from "../goals/goal-closure-test-fixtures.js";
import { seedReadyProject } from "../recovery/restore-test-harness.js";
import {
  FOUNDATION_ARTIFACT_EVENT_TYPE, deriveFoundationArtifactAggregateId,
  readFoundationArtifactForAttempt, readFoundationArtifactManifest,
  sealFoundationArtifactRoster,
} from "./foundation-artifact-ledger.js";
import {
  canonicalArtifactRoster, deriveFoundationArtifactDigest, sealFoundationArtifactManifest,
} from "./foundation-artifact-manifest.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";

import type { FoundationArtifactLedgerOutcome } from "./foundation-artifact-ledger.js";

/**
 * THE FOUNDATION ARTIFACT-ROSTER SEAL on the store PRODUCTION CAN ACTUALLY REACH.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT STOPPED. Every store-backed arm began with
 * `seedProvenAttempt`, which drove `runEffectActivateCommand` to commit an activation. Production
 * cannot commit one from a test world any more, so those arms asserted against a state nothing
 * can build. Governor ruling comment-937524c83a1945a5afae3ed8ac2405b9 clause 3 is applied here:
 * the world is not rebuilt below the admission path, the SUBJECT is narrowed to what this store
 * can honestly hold — a REAL, file-backed, bootstrapped project carrying NO attempt and NO
 * activation.
 *
 * WHAT THAT WORLD STILL PROVES, and it is the direction the human OPTION-A ruling
 * (task-4a318d03, comment-a662f748) cared most about: condition 2, that a caller-supplied
 * NONEMPTY roster is REFUSED on this lane, and that it is refused BEFORE the attempt is even
 * read. Plus the strict reader's whole refusal vocabulary — ABSENT, DRIFT, PROJECT_MISMATCH,
 * ATTEMPT_MISMATCH — reached by planting rows directly on the artifact aggregate.
 *
 * A PLANTED ROW IS A READER FIXTURE AND NEVER EVIDENCE THAT THE LANE SEALED. Nothing below
 * claims the production writer succeeded; the writer is exercised only on its REFUSING paths.
 * Condition 1's positive half — a sealed empty roster being provably different from
 * never-enumerated — needed a proven attempt and is retired, with the never-enumerated half
 * surviving as the ABSENT arm.
 *
 * EVERY DURABLE ASSERTION READS THE STORE, not the writer's return value. A writer that answered
 * correctly and wrote a row anyway would sail through a return-value-only arm.
 */

const LEDGER_LAYER = "DAEMON_FOUNDATION_ARTIFACT_LEDGER";
const HEX64 = /^[0-9a-f]{64}$/u;
const PRINCIPAL_ID = "principal-1";
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
/** A dispatch aggregate this file never writes an attempt event to: the artifact lane keys its
 *  own aggregate off it, and `durableInstant` reads it to stamp a seal. */
const ATTEMPT_AGGREGATE = "foundation-dispatch:unattempted";
const ATTEMPT_REF = "attempt-unattempted-1";
const INPUT_SHA = "c".repeat(64);
const RESULT_SHA = "d".repeat(64);
const scratch: string[] = [];

afterAll(() => {
  while (scratch.length > 0) {
    rmSync(scratch.pop() as string, { force: true, maxRetries: 5, recursive: true });
  }
});

/**
 * FILE-BACKED, per DoD 4 — `openEphemeralForProjectTest` is `:memory:` and would
 * not exercise the durability path the consumer reads through. The project is
 * driven to READY through the REAL bootstrap chain (`seedReadyProject`), not
 * written by hand: a fresh file-backed store has no bootstrap ledger, and the
 * lane's own commits refuse without it. `seedReadyProject` seeds a graph and a
 * funded budget root; it commits NO activation ledger row, which the store-wide
 * arm below measures rather than assumes.
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

function artifactRows(store: SqliteEventStore): number {
  return store.readEvents(deriveFoundationArtifactAggregateId(ATTEMPT_AGGREGATE))
    .filter((event) => event.eventType === FOUNDATION_ARTIFACT_EVENT_TYPE).length;
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

const QUERY = Object.freeze({ attemptAggregateId: ATTEMPT_AGGREGATE, projectId: PROJECT_ID });

/** The seal request a direct caller composes. Non-authoritative by construction: the identities
 *  are this file's own literals, not anything a durable record handed back. */
function sealRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<typeof sealFoundationArtifactRoster>[1] {
  return {
    attemptAggregateId: ATTEMPT_AGGREGATE, attemptRef: ATTEMPT_REF,
    commandId: "cmd-artifact-direct", correlationId: "corr-artifact-direct",
    declaredArtifactRefs: [], inputManifestSha256: INPUT_SHA, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, resultManifestSha256: RESULT_SHA,
    ...overrides,
  };
}

/**
 * A canonical manifest row planted straight onto the artifact aggregate.
 *
 * READER FIXTURE ONLY. The body comes from the production sealer
 * (`sealFoundationArtifactManifest`), so the reader meets the exact shape it would meet in the
 * field; `mutate` then drifts one field for the arms whose guard is unreachable from a
 * well-formed row. Committing it says nothing about whether the LANE would have sealed it — this
 * world holds no attempt, and the lane refuses on that.
 */
function plantManifest(
  store: SqliteEventStore, label: string,
  parts: Readonly<{ attemptRef?: string; projectId?: string }> = {},
  mutate: (body: Record<string, unknown>) => Record<string, unknown> = (body) => body,
): void {
  const sealed = sealFoundationArtifactManifest({
    attemptRef: parts.attemptRef ?? ATTEMPT_REF, declaredArtifactRefs: [],
    inputManifestSha256: INPUT_SHA, projectId: parts.projectId ?? PROJECT_ID,
    resultManifestSha256: RESULT_SHA,
  });
  if (!sealed.ok) throw new Error(`manifest fixture refused: ${sealed.code}`);
  const encoded = encodeFoundationPayload(
    mutate({ ...sealed.manifest as unknown as Record<string, unknown> }));
  if (!encoded.ok) throw new Error(`manifest fixture is not encodable: ${encoded.code}`);
  const aggregateId = deriveFoundationArtifactAggregateId(ATTEMPT_AGGREGATE);
  const committed = store.commitExpectedVersionDecision({
    commandKind: "test.plant_foundation_artifact", committedResultBytes: encoded.bytes,
    correlationId: `corr-plant-${label}`, decidedAt: DECIDED_AT,
    events: [{
      eventId: `plant-${label}`, eventType: FOUNDATION_ARTIFACT_EVENT_TYPE, payload: encoded.bytes,
    }],
    expectedVersion: store.readEvents(aggregateId).length,
    key: { commandId: `cmd-plant-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: encoded.bytes, targetAggregateId: aggregateId,
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
}

describe("foundation artifact seal — the world production can reach holds no attempt", () => {
  it("carries no committed activation anywhere, measured store-wide", () => {
    withStore("unactivated", (store) => {
      const scan = scanGlobalEvents(store);

      // POSITIVE CONTROL: the bootstrap really ran, so a zero activation count is a measurement
      // and not an empty store answering for one.
      expect(scan.total).toBeGreaterThan(0);
      expect(scan.exhausted).toBe(true);
      expect(scan.activationRows).toBe(0);
      expect(artifactRows(store)).toBe(0);
    });
  });

  it("refuses to seal even an AUTHORIZED empty roster while the attempt holds no event", () => {
    withStore("no-durable-instant", (store) => {
      // The empty roster clears the nonempty fence, so the refusal below is the NEXT one:
      // `durableInstant` finds no event on the attempt aggregate and has no honest stamp to
      // commit under. A wall-clock fallback here is exactly what the module refuses to do.
      const outcome = sealFoundationArtifactRoster(store, sealRequest());

      expectRefusal(outcome, "FOUNDATION_ARTIFACT_LEDGER_UNREADABLE", LEDGER_LAYER);
      expect(artifactRows(store)).toBe(0);
    });
  });

  it("answers ABSENT at its own layer with ZERO rows when nothing ever enumerated", () => {
    withStore("not-enumerated", (store) => {
      const read = readFoundationArtifactManifest(store, QUERY);

      expectRefusal(read, "FOUNDATION_ARTIFACT_LEDGER_ABSENT", LEDGER_LAYER);
      expect(artifactRows(store)).toBe(0);
    });
  });
});

describe("foundation artifact seal — CONDITION 2: the lane REFUSES caller-handed refs", () => {
  it("refuses a nonempty roster BEFORE it reads the attempt, and writes no row", () => {
    withStore("unauthorized", (store) => {
      const offered = sealFoundationArtifactRoster(
        store, sealRequest({ declaredArtifactRefs: [REF_A] }));

      expectRefusal(offered, "FOUNDATION_ARTIFACT_LEDGER_ROSTER_UNAUTHORIZED", LEDGER_LAYER);
      expect(artifactRows(store)).toBe(0);
      // THE ORDERING, made falsifiable rather than asserted in prose. The SAME world with an
      // EMPTY roster refuses under a DIFFERENT code, so the nonempty fence provably answered
      // first: if it ran after the attempt read, both calls would say UNREADABLE.
      expectRefusal(sealFoundationArtifactRoster(store, sealRequest()),
        "FOUNDATION_ARTIFACT_LEDGER_UNREADABLE", LEDGER_LAYER);
      expect(artifactRows(store)).toBe(0);
    });
  });
});

describe("foundation artifact reader — the strict refusal vocabulary", () => {
  it("refuses a durable row whose artifactDigest does not seal its own roster", () => {
    withStore("forged-digest", (store) => {
      // A FORGED ROW, canonical in every other respect: re-encoding it reproduces its own bytes,
      // so the byte-compare alone would pass it. Only re-deriving the digest FROM THE ROSTER
      // catches a digest that belongs to nothing.
      plantManifest(store, "forged", {}, (body) => ({ ...body, artifactDigest: "e".repeat(64) }));
      expect(artifactRows(store)).toBe(1);

      const read = readFoundationArtifactManifest(store, QUERY);

      expectRefusal(read, "FOUNDATION_ARTIFACT_LEDGER_DRIFT", LEDGER_LAYER);
      expect(artifactRows(store)).toBe(1);
    });
  });

  it("refuses a row belonging to another project, and one bound to another attempt", () => {
    withStore("bindings", (store) => {
      plantManifest(store, "foreign-project", { projectId: "project-foreign" });
      expect(artifactRows(store)).toBe(1);

      expectRefusal(readFoundationArtifactManifest(store, QUERY),
        "FOUNDATION_ARTIFACT_LEDGER_PROJECT_MISMATCH", LEDGER_LAYER);
      // The SAME row read under its OWN project decodes and answers, so the refusal above is the
      // project binding rather than a row that was never readable.
      const own = readFoundationArtifactManifest(
        store, { ...QUERY, projectId: "project-foreign" });
      expect(own.ok).toBe(true);
      if (!own.ok) return;
      expect(own.manifest.attemptRef).toBe(ATTEMPT_REF);
      expect(own.manifest.artifactRefCount).toBe(0);
      expect(own.manifest.artifactDigest).toMatch(HEX64);
      expectRefusal(
        readFoundationArtifactForAttempt(
          store, { ...QUERY, projectId: "project-foreign" }, "attempt-foreign"),
        "FOUNDATION_ARTIFACT_LEDGER_ATTEMPT_MISMATCH", LEDGER_LAYER);
      // ...and the attempt binding answers for the attempt it really names.
      expect(readFoundationArtifactForAttempt(
        store, { ...QUERY, projectId: "project-foreign" }, ATTEMPT_REF).ok).toBe(true);
      expect(artifactRows(store)).toBe(1);
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
