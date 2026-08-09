import { RECOVERY_OUTCOME_KINDS } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  RESTART_RECONCILIATION_SCHEMA_VERSION,
  RESTART_RECORD_CLASSIFICATIONS,
  readReconciliationRecords,
  reconcileOnRestart,
} from "./restart-reconciliation.js";
import type { InFlightAttempt } from "./restart-reconciliation.js";
import { ADVANCED_AUTHORITY, SETTLED, observation, records, situation } from "./recovery-test-fixtures.js";

const PROJECT_ID = "project-recovery";
const open: SqliteEventStore[] = [];

function store(): SqliteEventStore {
  const opened = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  open.push(opened);
  return opened;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function sweep(attempts: readonly InFlightAttempt[]): ReturnType<typeof reconcileOnRestart> {
  return reconcileOnRestart(store(), {
    attempts,
    correlationId: "corr-restart",
    decidedAt: "2026-08-09T00:00:00.000Z",
    principalId: "daemon-1",
    projectId: PROJECT_ID,
  });
}

/**
 * One seed per outcome kind design 1099 names, each labelled with the kind it is
 * SUPPOSED to produce. The set equality below would still pass if two seeds
 * swapped answers, so every seed is also pinned individually — a partial mapping
 * that collapsed two kinds into one has to redden by name, not merely by count.
 */
const SEEDS: readonly { readonly attempt: InFlightAttempt; readonly expected: string }[] = [
  {
    attempt: {
      attemptRef: "attempt-adopted",
      situation: situation({ claimedAuthority: ADVANCED_AUTHORITY }),
    },
    expected: "ADOPTED",
  },
  {
    attempt: {
      attemptRef: "attempt-absent",
      situation: situation({
        observation: observation({
          effectStatus: "PROVEN_ABSENT",
          processExit: { kind: "EXITED", code: 0 },
        }),
        records: records(SETTLED),
      }),
    },
    expected: "ABSENT",
  },
  {
    attempt: {
      attemptRef: "attempt-suspect",
      situation: situation({ records: records({ lockState: "UNKNOWN" }) }),
    },
    expected: "SUSPECT",
  },
  {
    attempt: {
      attemptRef: "attempt-quarantined",
      situation: situation({
        observation: observation({ effectStatus: "PROVEN_ABSENT" }),
        records: records({ ...SETTLED, resourceFact: "ACTIVE" }),
      }),
    },
    expected: "QUARANTINED",
  },
  {
    attempt: {
      attemptRef: "attempt-reconciliation",
      situation: situation({
        observation: observation({ effectStatus: "PROVEN_ABSENT" }),
        records: records(SETTLED),
      }),
    },
    expected: "RECONCILIATION_COMMAND",
  },
];

const ALL: readonly InFlightAttempt[] = SEEDS.map((seed) => seed.attempt);

describe("restart reconciliation vocabulary", () => {
  it("derives its record classifications from the runner's exported outcome kinds", () => {
    for (const kind of RECOVERY_OUTCOME_KINDS) {
      expect(RESTART_RECORD_CLASSIFICATIONS).toContain(kind);
    }
    expect(RESTART_RECORD_CLASSIFICATIONS).toHaveLength(RECOVERY_OUTCOME_KINDS.length + 1);
    // The one addition is the runner's own refusal arm, never a resume: an
    // outcome the vocabulary cannot express is one no new branch can return.
    expect(RESTART_RECORD_CLASSIFICATIONS).toContain("REFUSED");
    expect(RESTART_RECORD_CLASSIFICATIONS).not.toContain("RESUMED");
  });
});

describe("restart reconciliation classifies every in-flight attempt", () => {
  it("produces exactly the runner's outcome kinds over a non-empty seeded sweep", () => {
    // A sweep that classified nothing would satisfy every assertion below by
    // vacuity, so the seed count is asserted before the classifications are.
    expect(SEEDS.length).toBeGreaterThan(0);
    expect(SEEDS).toHaveLength(RECOVERY_OUTCOME_KINDS.length);

    const outcome = sweep(ALL);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.records).toHaveLength(SEEDS.length);
    const produced = new Set(outcome.records.map((record) => record.classification));
    expect(produced).toEqual(new Set<string>(RECOVERY_OUTCOME_KINDS));

    for (const seed of SEEDS) {
      const record = outcome.records.filter((entry) => entry.attemptRef === seed.attempt.attemptRef);
      expect(record).toHaveLength(1);
      expect(record[0]?.classification).toBe(seed.expected);
      expect(record[0]?.schemaVersion).toBe(RESTART_RECONCILIATION_SCHEMA_VERSION);
    }
  });

  it("persists one durable record per attempt, each carrying its truth chip", () => {
    const opened = store();
    const outcome = reconcileOnRestart(opened, {
      attempts: ALL,
      correlationId: "corr-restart",
      decidedAt: "2026-08-09T00:00:00.000Z",
      principalId: "daemon-1",
      projectId: PROJECT_ID,
    });
    expect(outcome.ok).toBe(true);

    const persisted = readReconciliationRecords(opened, PROJECT_ID);
    expect(persisted.size).toBe(SEEDS.length);
    for (const seed of SEEDS) {
      const record = persisted.get(seed.attempt.attemptRef);
      expect(record?.classification).toBe(seed.expected);
      // The truth chip is present on every record, and only a proven arm may
      // claim verification; anything else stays UNKNOWN under epic rail 4.
      expect(typeof record?.truthClass).toBe("string");
      if (seed.expected === "SUSPECT" || seed.expected === "RECONCILIATION_COMMAND") {
        expect(record?.truthClass).toBe("UNKNOWN");
      }
    }
  });
});

describe("uncertainty stays suspect", () => {
  it("classifies an attempt whose lock state cannot be established as SUSPECT, never adopted", () => {
    // Everything else about this seed says adoptable — full identification AND a
    // proven fence advance — so an optimistic implementation lands on ADOPTED.
    const outcome = sweep([
      {
        attemptRef: "attempt-unknown-lock",
        situation: situation({
          claimedAuthority: ADVANCED_AUTHORITY,
          records: records({ lockState: "UNKNOWN" }),
        }),
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records[0]?.classification).toBe("SUSPECT");
    expect(outcome.records[0]?.classification).not.toBe("ADOPTED");
  });

  it("classifies an unestablished effect as SUSPECT even under a proven fence advance", () => {
    const outcome = sweep([
      {
        attemptRef: "attempt-unestablished",
        situation: situation({
          claimedAuthority: ADVANCED_AUTHORITY,
          observation: observation({ effectStatus: "UNESTABLISHED" }),
        }),
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records[0]?.classification).toBe("SUSPECT");
    expect(outcome.records[0]?.truthClass).toBe("UNKNOWN");
  });
});

describe("classification refusals keep the runner's own code and layer", () => {
  it("surfaces RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN from the CLASSIFICATION layer", () => {
    const outcome = sweep([{ attemptRef: "attempt-unproven", situation: situation() }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = outcome.records[0];
    expect(record?.classification).toBe("REFUSED");
    expect(record?.code).toBe("RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN");
    expect(record?.layer).toBe("CLASSIFICATION");
    expect(record?.truthClass).toBe("UNKNOWN");
  });

  it("surfaces RECOVERY_OBSERVATION_MALFORMED for a situation the runner cannot parse", () => {
    const outcome = sweep([{ attemptRef: "attempt-malformed", situation: { records: null } }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.records[0]?.classification).toBe("REFUSED");
    expect(outcome.records[0]?.code).toBe("RECOVERY_OBSERVATION_MALFORMED");
    expect(outcome.records[0]?.layer).toBe("CLASSIFICATION");
  });

  it("still lands a durable record for a refused attempt, so nothing is left unclassified", () => {
    const opened = store();
    const outcome = reconcileOnRestart(opened, {
      attempts: [{ attemptRef: "attempt-unproven", situation: situation() }],
      correlationId: "corr-restart",
      decidedAt: "2026-08-09T00:00:00.000Z",
      principalId: "daemon-1",
      projectId: PROJECT_ID,
    });
    expect(outcome.ok).toBe(true);
    const persisted = readReconciliationRecords(opened, PROJECT_ID);
    expect(persisted.size).toBe(1);
    expect(persisted.get("attempt-unproven")?.classification).toBe("REFUSED");
  });
});
