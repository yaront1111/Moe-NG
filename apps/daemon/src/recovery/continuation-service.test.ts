import { RECOVERY_ERROR_CODES, RECOVERY_OUTCOME_KINDS } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTINUATION_COMMAND_KINDS,
  CONTINUATION_SCHEMA_VERSION,
} from "./continuation-contracts.js";
import {
  evaluateContinuationCommandBytes,
  readContinuationBindings,
} from "./continuation-service.js";
import {
  PROJECT_ID,
  closeOpenStores,
  decisions,
  run as legacyAuthorityRequest,
  seed,
  snapshot,
  store,
} from "./continuation-test-harness.js";
import { ADVANCED_AUTHORITY, SETTLED, observation, records, situation } from "./recovery-test-fixtures.js";
import {
  RESTART_RECONCILIATION_COMMAND_KIND,
  readReconciliationRecords,
  reconciliationAggregateId,
} from "./restart-reconciliation.js";

afterEach(closeOpenStores);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HANDOFF = "handoff-stored-1";

/**
 * A continuation request carrying NO release or handoff assertion.
 *
 * The harness builder is deliberately not used for the positive path: it still
 * mints the pre-migration shape, which is now precisely the hostile input. It is
 * imported once, under its real name, as the legacy fixture.
 */
function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    attemptRef: "attempt-absent",
    correlationId: "corr-continuation",
    decidedAt: "2026-08-09T00:00:00.000Z",
    kind: "work.resume",
    principalId: "daemon-1",
    projectId: PROJECT_ID,
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    successorRef: "successor-1",
    ...overrides,
  };
}

function evaluate(
  opened: SqliteEventStore,
  overrides: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof evaluateContinuationCommandBytes> {
  return evaluateContinuationCommandBytes(opened, encoder.encode(JSON.stringify(request(overrides))));
}

/** The durable reconciliation row as it actually sits on disk, not as an API returns it. */
function storedRecordBytes(opened: SqliteEventStore, attemptRef: string): Record<string, unknown> {
  const rows = decisions(opened)
    .filter((entry) => entry.commandKind === RESTART_RECONCILIATION_COMMAND_KIND)
    .map((entry) => JSON.parse(decoder.decode(entry.resultBytes)) as Record<string, unknown>)
    .filter((entry) => entry["attemptRef"] === attemptRef);
  expect(rows).toHaveLength(1);
  return rows[0] as Record<string, unknown>;
}

const absentSeed = (overrides: Readonly<Record<string, unknown>>): unknown =>
  situation({
    observation: observation({ effectStatus: "PROVEN_ABSENT", processExit: { kind: "EXITED", code: 0 } }),
    records: records({ ...SETTLED, ...overrides }),
  });

/** ABSENT, released, and carrying the handoff the predecessor actually committed. */
const ABSENT_WITH_HANDOFF = absentSeed({ safeHandoff: HANDOFF });
/** The same crash with no committed handoff: released, but nothing safe to resume from. */
const ABSENT_NO_HANDOFF = absentSeed({});

/**
 * The four non-resumable kinds. `masked` names the refusal each seed's STORED
 * release/handoff would produce if the classification gate were absent — asserting
 * `not.toBe(masked)` is what makes these tests fail when the gate is deleted, which
 * a code-only assertion cannot do.
 */
const NOT_RESUMABLE = [
  {
    attemptRef: "attempt-adopted",
    expected: "ADOPTED",
    masked: "RECOVERY_PREDECESSOR_ACTIVE",
    situation: situation({ claimedAuthority: ADVANCED_AUTHORITY }),
  },
  {
    attemptRef: "attempt-suspect",
    expected: "SUSPECT",
    masked: "RECOVERY_PREDECESSOR_ACTIVE",
    situation: situation({ records: records({ lockState: "UNKNOWN" }) }),
  },
  {
    attemptRef: "attempt-quarantined",
    expected: "QUARANTINED",
    masked: "RECOVERY_PREDECESSOR_ACTIVE",
    situation: situation({
      observation: observation({ effectStatus: "PROVEN_ABSENT" }),
      records: records({ ...SETTLED, resourceFact: "ACTIVE", safeHandoff: HANDOFF }),
    }),
  },
  {
    attemptRef: "attempt-command",
    expected: "RECONCILIATION_COMMAND",
    masked: "RECOVERY_RESUME_BOUNDARY_UNPROVEN",
    situation: situation({
      observation: observation({ effectStatus: "PROVEN_ABSENT" }),
      records: records(SETTLED),
    }),
  },
] as const;

describe("continuation reads its boundary facts from the durable record", () => {
  it("persists the runner-derived release and handoff into the reconciliation record", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT_WITH_HANDOFF)).toBe(true);

    // The decoded record and the bytes it was decoded FROM, because a record
    // assembled at read time would satisfy the first assertion alone.
    const record = readReconciliationRecords(opened, PROJECT_ID).get("attempt-absent");
    expect(record?.predecessorRelease).toBe("PROVEN_RELEASED");
    expect(record?.safeHandoff).toBe(HANDOFF);

    const stored = storedRecordBytes(opened, "attempt-absent");
    expect(stored["predecessorRelease"]).toBe("PROVEN_RELEASED");
    expect(stored["safeHandoff"]).toBe(HANDOFF);
  });

  it("stores the honest UNKNOWN/null pair when the crash proves no release", () => {
    const opened = store();
    expect(seed(opened, "attempt-suspect", NOT_RESUMABLE[1].situation)).toBe(true);

    const stored = storedRecordBytes(opened, "attempt-suspect");
    // Epic rail 4: an unverifiable fact stays where it is and never upgrades.
    expect(stored["predecessorRelease"]).toBe("ACTIVE");
    expect(stored["predecessorRelease"]).not.toBe("PROVEN_RELEASED");
    expect(stored["safeHandoff"]).toBe(null);
  });

  it("moves a reconciled attempt forward on a SINGLE command using only stored facts", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT_WITH_HANDOFF)).toBe(true);
    const before = decisions(opened).length;

    const outcome = evaluate(opened);

    expect(CONTINUATION_COMMAND_KINDS).toHaveLength(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcome).toBe("BOUND");
    expect(decisions(opened).length - before).toBe(1);

    const bindings = readContinuationBindings(opened, PROJECT_ID);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.attemptRef).toBe("attempt-absent");
    expect(bindings[0]?.successorRef).toBe("successor-1");
    // The handoff came off the durable record; the request never carried one.
    expect(bindings[0]?.safeHandoff).toBe(HANDOFF);
  });
});

describe("a resume across an unproven boundary refuses and commits nothing", () => {
  it("cannot reach a resumable classification while a resource is still held", () => {
    const opened = store();
    // The SAME crash as the binding case except the resource is still held. Once
    // the release is derived rather than asserted, a held resource cannot present
    // as ABSENT: quarantine is decided before absence. That coupling is what makes
    // RECOVERY_PREDECESSOR_ACTIVE unreachable through continuation, so this test
    // pins the coupling instead of staging a lattice refusal that cannot occur.
    expect(seed(opened, "attempt-absent", absentSeed({ resourceFact: "ACTIVE", safeHandoff: HANDOFF }))).toBe(true);
    const record = readReconciliationRecords(opened, PROJECT_ID).get("attempt-absent");
    expect(record?.classification).toBe("QUARANTINED");
    expect(record?.classification).not.toBe("ABSENT");
    expect(record?.predecessorRelease).toBe("ACTIVE");
    const before = snapshot(opened);

    const outcome = evaluate(opened);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("REFUSED");
    expect(outcome.code).toBe("RECOVERY_CLASSIFICATION_NOT_RESUMABLE");
    expect(outcome.layer).toBe("SAFE_BOUNDARY");
    expect(RECOVERY_ERROR_CODES).toContain(outcome.code);
    expect(snapshot(opened)).toBe(before);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(0);
  });

  it("stores PROVEN_RELEASED on every ABSENT record, which is why the lattice is unreachable", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT_WITH_HANDOFF)).toBe(true);
    expect(seed(opened, "attempt-bare", ABSENT_NO_HANDOFF)).toBe(true);

    // Both ABSENT records, handoff or not, carry the proven release. A future
    // change that let ABSENT co-exist with ACTIVE or UNKNOWN would silently make
    // the release refusals reachable again and this assertion is the tripwire.
    for (const attemptRef of ["attempt-absent", "attempt-bare"]) {
      const record = readReconciliationRecords(opened, PROJECT_ID).get(attemptRef);
      expect(record?.classification).toBe("ABSENT");
      expect(record?.predecessorRelease).toBe("PROVEN_RELEASED");
    }
  });

  it("refuses a proven release carrying no stored handoff, so admitResume is load-bearing", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT_NO_HANDOFF)).toBe(true);
    const before = snapshot(opened);

    // The overlap admission ADMITS this case; only admitResume refuses it, so a
    // composition that called the first helper and skipped the second is red here.
    const outcome = evaluate(opened);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("RECOVERY_RESUME_BOUNDARY_UNPROVEN");
    expect(outcome.layer).toBe("SAFE_BOUNDARY");
    expect(snapshot(opened)).toBe(before);
  });
});

describe("only the closed resumable classification may continue", () => {
  it("refuses every non-resumable kind under one code, ahead of the release lattice", () => {
    // A sweep that produced nothing would satisfy every assertion below by
    // vacuity, so the case count is pinned before the cases are.
    expect(NOT_RESUMABLE.length).toBeGreaterThan(0);
    expect(NOT_RESUMABLE).toHaveLength(RECOVERY_OUTCOME_KINDS.length - 1);
    const produced = new Set<string>();

    for (const entry of NOT_RESUMABLE) {
      const opened = store();
      expect(seed(opened, entry.attemptRef, entry.situation)).toBe(true);

      const record = readReconciliationRecords(opened, PROJECT_ID).get(entry.attemptRef);
      expect(record?.classification).toBe(entry.expected);
      produced.add(entry.expected);
      const before = snapshot(opened);

      const outcome = evaluate(opened, { attemptRef: entry.attemptRef });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("RECOVERY_CLASSIFICATION_NOT_RESUMABLE");
      expect(outcome.layer).toBe("SAFE_BOUNDARY");
      // Guard ORDER: with the classification gate removed, this seed's stored
      // release/handoff answers under `masked` and a code-only test stays green.
      expect(outcome.code).not.toBe(entry.masked);
      expect(snapshot(opened)).toBe(before);
      expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(0);
    }

    produced.add("ABSENT");
    expect(produced).toEqual(new Set<string>(RECOVERY_OUTCOME_KINDS));
  });
});

describe("a record that predates the derived evidence carries no authority", () => {
  /** Writes a raw reconciliation row exactly as a caller's bytes, bypassing recordOf. */
  function writeRawRecord(opened: SqliteEventStore, attemptRef: string, row: unknown): void {
    const bytes = encoder.encode(JSON.stringify(row));
    const response = opened.commitExpectedVersionDecision({
      commandKind: RESTART_RECONCILIATION_COMMAND_KIND,
      committedResultBytes: bytes,
      correlationId: "corr-legacy",
      decidedAt: "2026-08-09T00:00:00.000Z",
      events: [{ eventId: `${attemptRef}:legacy`, eventType: "RestartReconciliationRecorded", payload: bytes }],
      expectedVersion: 0,
      key: { commandId: `legacy:${attemptRef}`, principalId: "daemon-1", projectId: PROJECT_ID },
      requestBytes: bytes,
      targetAggregateId: reconciliationAggregateId(attemptRef),
    });
    expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
  }

  const legacyRow = (attemptRef: string, overrides: Readonly<Record<string, unknown>>) => ({
    attemptRef,
    classification: "ABSENT",
    code: null,
    command: null,
    detail: null,
    effectRef: "intent-1",
    held: [],
    layer: null,
    message: null,
    postState: null,
    truthClass: "VERIFIED",
    ...overrides,
  });

  it("does not upgrade a pre-migration row, and refuses to continue from it", () => {
    const opened = store();
    // A committed /1 row: ABSENT, but from before the release was ever derived.
    writeRawRecord(
      opened,
      "attempt-legacy",
      legacyRow("attempt-legacy", { schemaVersion: "moe-restart-reconciliation/1" }),
    );

    // Absent, not defaulted. An implementation that filled in PROVEN_RELEASED for
    // a row that never proved one would read as a successful continuation.
    expect(readReconciliationRecords(opened, PROJECT_ID).get("attempt-legacy")).toBeUndefined();

    const outcome = evaluate(opened, { attemptRef: "attempt-legacy" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CONTINUATION_ATTEMPT_UNRECONCILED");
    expect(outcome.layer).toBe("CONTINUATION");
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(0);
  });

  it("rejects a current-version row whose derived evidence is missing or off-lattice", () => {
    const opened = store();
    const version = { schemaVersion: "moe-restart-reconciliation/2" };
    // Right version, no evidence at all.
    writeRawRecord(opened, "attempt-bare", legacyRow("attempt-bare", version));
    // Right version, a release outside the runner's three-valued lattice.
    writeRawRecord(
      opened,
      "attempt-offlattice",
      legacyRow("attempt-offlattice", {
        ...version,
        predecessorRelease: "PROBABLY_RELEASED",
        safeHandoff: HANDOFF,
      }),
    );

    const records = readReconciliationRecords(opened, PROJECT_ID);
    expect(records.get("attempt-bare")).toBeUndefined();
    expect(records.get("attempt-offlattice")).toBeUndefined();
    for (const attemptRef of ["attempt-bare", "attempt-offlattice"]) {
      const outcome = evaluate(opened, { attemptRef });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("CONTINUATION_ATTEMPT_UNRECONCILED");
    }
  });
});

describe("nothing continues without a classified record", () => {
  it("refuses an attempt restart reconciliation never saw", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT_WITH_HANDOFF)).toBe(true);
    const before = snapshot(opened);

    const outcome = evaluate(opened, { attemptRef: "attempt-never-reconciled" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("UNRECONCILED");
    expect(outcome.code).toBe("CONTINUATION_ATTEMPT_UNRECONCILED");
    // The daemon's own gate answered here, not the runner's boundary.
    expect(outcome.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
  });

  it("refuses an attempt whose classification the runner itself refused", () => {
    const opened = store();
    expect(seed(opened, "attempt-unclassified", situation())).toBe(true);
    const before = snapshot(opened);

    const outcome = evaluate(opened, { attemptRef: "attempt-unclassified" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("UNCLASSIFIED");
    expect(outcome.code).toBe("CONTINUATION_ATTEMPT_UNCLASSIFIED");
    expect(outcome.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
  });
});

describe("continuation ingress refuses under its own layer", () => {
  it("rejects input the bounded decoder will not accept", () => {
    const opened = store();
    const outcome = evaluateContinuationCommandBytes(opened, "not bytes");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("INPUT_REJECTED");
    expect(outcome.layer).toBe("BOUNDED_JSON");
    expect(outcome.code).toBe("JSON_INPUT_TYPE_INVALID");
  });

  it("rejects a hostile request asserting its own predecessor release", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT_NO_HANDOFF)).toBe(true);
    const before = snapshot(opened);

    // The stored record says PROVEN_RELEASED with NO handoff, which refuses. A
    // caller supplying both would bind if the field were merely ignored-if-present,
    // so this asserts rejection rather than "the stored value won".
    const outcome = evaluate(opened, { predecessorRelease: "PROVEN_RELEASED", safeHandoff: HANDOFF });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("REQUEST_INVALID");
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
    expect(outcome.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(0);
  });

  it("rejects the pre-migration request shape whole", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT_WITH_HANDOFF)).toBe(true);
    const before = snapshot(opened);

    // The harness still mints the authority-bearing envelope this migration
    // removed. It must not be a second, quietly-accepted way in.
    const outcome = legacyAuthorityRequest(opened);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
    expect(outcome.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
  });

  it("refuses a request pinned to a schema version this surface does not speak", () => {
    const opened = store();
    const outcome = evaluate(opened, { schemaVersion: "moe-recovery-continuation-request/1" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
  });

  it("refuses an envelope carrying an undeclared key", () => {
    const opened = store();
    const outcome = evaluate(opened, { unexpected: "value" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.outcome).toBe("REQUEST_INVALID");
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
  });

  it("refuses a command kind outside the one-action vocabulary", () => {
    const opened = store();
    const outcome = evaluate(opened, { kind: "work.claim" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("CONTINUATION_REQUEST_SHAPE_INVALID");
  });
});
