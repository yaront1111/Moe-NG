import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DECISION_LEG_ROSTER_VERSION } from "./decision-leg-roster.js";
import { MAX_DECISION_LEGS } from "./decision-legs-contracts.js";
import { SCHEMA_V7_DECISION_LEG_OBJECT_SQL } from "./sqlite-schema-decision-legs.js";
import { SCHEMA_OBJECT_SQL } from "./sqlite-schema-manifest.js";

type Bound = bigint | null | number | string;

const COMMITTED_AT = "2026-08-25T09:00:00.000Z";
const NON_HEX_DIGEST = "g".repeat(64);

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** Opens a scratch database holding only the v7 objects and their FK parents. */
function openHarness(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    ${SCHEMA_OBJECT_SQL.command_receipts};
    ${SCHEMA_OBJECT_SQL.domain_events};
    ${SCHEMA_OBJECT_SQL.command_decisions};
    ${SCHEMA_V7_DECISION_LEG_OBJECT_SQL.command_decision_leg_rosters};
    ${SCHEMA_V7_DECISION_LEG_OBJECT_SQL.command_decision_legs};
  `);
  return database;
}

function readForeignKeysPragma(database: DatabaseSync): unknown {
  return database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
}

function run(database: DatabaseSync, sql: string, ...parameters: readonly Bound[]): void {
  database.prepare(sql).run(...parameters);
}

function insertReceipt(database: DatabaseSync, commandId: string): string {
  run(
    database,
    `INSERT INTO command_receipts (
       command_id, request_identity_version, request_sha256, result_version,
       effect_identity_version, effect_sha256, aggregate_id, expected_version,
       previous_version, current_version, event_count, outbox_count, committed_at
     ) VALUES (?, 'moe-request/1', ?, 'moe-result/1', 'moe-effect/1', ?, ?, 0, 0, 1, 1, 0, ?)`,
    commandId,
    digest(`${commandId}/request`),
    digest(`${commandId}/effect`),
    `aggregate-${commandId}`,
    COMMITTED_AT,
  );
  return commandId;
}

function insertAuditEvent(database: DatabaseSync, eventId: string, commandId: string): string {
  run(
    database,
    `INSERT INTO domain_events (
       event_id, aggregate_id, aggregate_sequence, command_id, command_event_index,
       record_version, payload_codec_version, request_sha256, event_type,
       payload, metadata, committed_at, domain_schema_version
     ) VALUES (?, 'goal-1', 1, ?, 0, 'moe-event/1', 'moe-payload/1', ?, 'decision.rejected',
       x'00', x'00', ?, 'moe-domain-schema/1')`,
    eventId,
    commandId,
    digest(`${eventId}/request`),
    COMMITTED_AT,
  );
  return eventId;
}

/**
 * Inserts the FK parent decision. `auditEventId` null selects the
 * EFFECTS_COMMITTED shape; a non-null id selects NO_BUSINESS_EFFECT.
 */
function insertDecision(
  database: DatabaseSync,
  label: string,
  auditEventId: string | null,
): string {
  const decisionId = digest(`decision/${label}`);
  const committed = auditEventId === null;
  const hex = digest(`decision-digest/${label}`);
  insertReceipt(database, `decision-receipt-${label}`);
  run(
    database,
    `INSERT INTO command_decisions (
       project_id, principal_id, command_id, command_kind, decision_id, record_version,
       coverage, request_identity_version, request_sha256, target_aggregate_id,
       expected_version, observed_version, effect_disposition, result_code, result_version,
       result_bytes, result_sha256, decided_at, correlation_sha256, receipt_command_id,
       audit_event_id, previous_version, current_version, business_event_count, outbox_count,
       effect_identity_version, effect_sha256, decision_identity_version, decision_sha256
     ) VALUES (
       'project-1', 'principal-1', ?, 'goal.create', ?, 'moe-decision/1',
       'FULL', 'moe-request/1', ?, 'goal-1',
       0, ?, ?, ?, 'moe-result/1',
       x'00', ?, ?, ?, ?,
       ?, ?, ?, ?, 0,
       'moe-effect/1', ?, 'moe-decision-identity/1', ?
     )`,
    `command-${label}`,
    decisionId,
    hex,
    committed ? 0 : 1,
    committed ? "EFFECTS_COMMITTED" : "NO_BUSINESS_EFFECT",
    committed ? "EFFECTS_COMMITTED" : "EXPECTED_VERSION_CONFLICT",
    hex,
    COMMITTED_AT,
    hex,
    `decision-receipt-${label}`,
    auditEventId,
    committed ? 0 : null,
    committed ? 1 : null,
    committed ? 1 : 0,
    hex,
    hex,
  );
  return decisionId;
}

function insertRoster(
  database: DatabaseSync,
  decisionId: string,
  legCount: bigint | number,
  rosterSha256: string = digest(`roster/${decisionId}`),
  rosterVersion: string = DECISION_LEG_ROSTER_VERSION,
): void {
  run(
    database,
    `INSERT INTO command_decision_leg_rosters
       (decision_id, roster_version, leg_count, roster_sha256) VALUES (?, ?, ?, ?)`,
    decisionId,
    rosterVersion,
    legCount,
    rosterSha256,
  );
}

interface LegRow {
  readonly aggregateId: string;
  readonly decisionId: string;
  readonly effectSha256?: string | null;
  readonly expectedVersion?: bigint | number;
  readonly index: bigint | number;
  readonly receiptCommandId?: string | null;
  readonly requestSha256?: string | null;
}

function insertLeg(database: DatabaseSync, leg: LegRow): void {
  const receiptCommandId = leg.receiptCommandId ?? null;
  const present = receiptCommandId === null ? null : digest(`${receiptCommandId}/leg`);
  run(
    database,
    `INSERT INTO command_decision_legs (
       decision_id, leg_index, aggregate_id, expected_version,
       receipt_command_id, receipt_request_sha256, receipt_effect_sha256
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    leg.decisionId,
    leg.index,
    leg.aggregateId,
    leg.expectedVersion ?? 0,
    receiptCommandId,
    leg.requestSha256 === undefined ? present : leg.requestSha256,
    leg.effectSha256 === undefined ? present : leg.effectSha256,
  );
}

function refusalMessage(attempt: () => void): string {
  try {
    attempt();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the write to be refused, but it succeeded");
}

function readRoster(database: DatabaseSync, decisionId: string): Record<string, unknown> {
  const row = database
    .prepare("SELECT * FROM command_decision_leg_rosters WHERE decision_id = ?")
    .get(decisionId);
  if (row === undefined) {
    throw new Error(`no roster row for ${decisionId}`);
  }
  return row as Record<string, unknown>;
}

function readLegs(database: DatabaseSync, decisionId: string): readonly Record<string, unknown>[] {
  return database
    .prepare("SELECT * FROM command_decision_legs WHERE decision_id = ? ORDER BY leg_index")
    .all(decisionId) as readonly Record<string, unknown>[];
}

/** Names of harness tables holding a foreign key into `table`, in sqlite_master order. */
function referrersOf(database: DatabaseSync, table: string): readonly string[] {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as readonly Record<string, unknown>[];
  const referrers: string[] = [];
  for (const row of tables) {
    const name = String(row.name);
    const keys = database
      .prepare(`PRAGMA foreign_key_list("${name}")`)
      .all() as readonly Record<string, unknown>[];
    if (keys.some((key) => key.table === table)) {
      referrers.push(name);
    }
  }
  return referrers;
}

describe("v7 decision-leg schema objects (task-95d5d80e91024f14916b10599aaa5b8e)", () => {
  it("enforces foreign keys in the harness, so every FK arm below is non-vacuous", () => {
    const database = openHarness();
    try {
      expect(readForeignKeysPragma(database)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("accepts a one-leg roster and its single leg, read back exactly as written", () => {
    const database = openHarness();
    try {
      const decisionId = insertDecision(database, "valid-one-leg", null);
      const rosterSha256 = digest("roster/valid-one-leg");
      insertRoster(database, decisionId, 1, rosterSha256);
      insertReceipt(database, "one-leg-receipt");
      insertLeg(database, {
        aggregateId: "goal-1",
        decisionId,
        expectedVersion: 4,
        index: 0,
        receiptCommandId: "one-leg-receipt",
      });
      expect({ ...readRoster(database, decisionId) }).toEqual({
        decision_id: decisionId,
        leg_count: 1,
        roster_sha256: rosterSha256,
        roster_version: DECISION_LEG_ROSTER_VERSION,
      });
      expect(readLegs(database, decisionId).map((leg) => ({ ...leg }))).toEqual([{
        aggregate_id: "goal-1",
        decision_id: decisionId,
        expected_version: 4,
        leg_index: 0,
        receipt_command_id: "one-leg-receipt",
        receipt_effect_sha256: digest("one-leg-receipt/leg"),
        receipt_request_sha256: digest("one-leg-receipt/leg"),
      }]);
    } finally {
      database.close();
    }
  });

  it("accepts a committed three-leg decision with every receipt digest present", () => {
    const database = openHarness();
    try {
      const decisionId = insertDecision(database, "valid-three-leg", null);
      insertRoster(database, decisionId, 3);
      for (const index of [0, 1, 2]) {
        const receiptCommandId = insertReceipt(database, `three-leg-receipt-${index}`);
        insertLeg(database, {
          aggregateId: `goal-${index}`,
          decisionId,
          expectedVersion: index,
          index,
          receiptCommandId,
        });
      }
      const legs = readLegs(database, decisionId);
      expect(legs).toHaveLength(3);
      expect(legs.map((leg) => leg.leg_index)).toEqual([0, 1, 2]);
      expect(legs.map((leg) => leg.receipt_command_id)).toEqual([
        "three-leg-receipt-0", "three-leg-receipt-1", "three-leg-receipt-2",
      ]);
      for (const leg of legs) {
        const expectedDigest = digest(`${String(leg.receipt_command_id)}/leg`);
        expect(leg.receipt_request_sha256).toBe(expectedDigest);
        expect(leg.receipt_effect_sha256).toBe(expectedDigest);
      }
    } finally {
      database.close();
    }
  });

  it("accepts a no-business-effect decision whose legs carry the null receipt trio", () => {
    const database = openHarness();
    try {
      insertReceipt(database, "audit-receipt");
      const auditEventId = insertAuditEvent(database, "audit-event-1", "audit-receipt");
      const decisionId = insertDecision(database, "valid-no-effect", auditEventId);
      insertRoster(database, decisionId, 2);
      for (const index of [0, 1]) {
        insertLeg(database, {
          aggregateId: `goal-${index}`,
          decisionId,
          index,
          receiptCommandId: null,
        });
      }
      const legs = readLegs(database, decisionId);
      expect(legs).toHaveLength(2);
      for (const leg of legs) {
        expect(leg.receipt_command_id).toBeNull();
        expect(leg.receipt_request_sha256).toBeNull();
        expect(leg.receipt_effect_sha256).toBeNull();
      }
      expect(readRoster(database, decisionId).leg_count).toBe(2);
    } finally {
      database.close();
    }
  });
});

interface RefusalFixture {
  readonly absentDecisionId: string;
  readonly database: DatabaseSync;
  readonly decisionA: string;
  readonly decisionB: string;
  readonly decisionWithoutRoster: string;
}

function seedRefusalFixture(): RefusalFixture {
  const database = openHarness();
  const decisionA = insertDecision(database, "refusal-a", null);
  const decisionB = insertDecision(database, "refusal-b", null);
  const decisionWithoutRoster = insertDecision(database, "refusal-c", null);
  insertRoster(database, decisionA, 3);
  insertRoster(database, decisionB, 3);
  insertReceipt(database, "shared-leg-receipt-1");
  return {
    absentDecisionId: digest("decision/never-inserted"),
    database,
    decisionA,
    decisionB,
    decisionWithoutRoster,
  };
}

interface RefusalCase {
  readonly attempt: (fixture: RefusalFixture) => void;
  readonly name: string;
  /** Every fragment must appear in the refusal message: this pins WHICH constraint refused. */
  readonly refusal: readonly string[];
  readonly requiresForeignKeys?: true;
}

const CHECK_FAILED = "CHECK constraint failed:";
const UNIQUE_FAILED = "UNIQUE constraint failed:";
const FOREIGN_KEY_FAILED = "FOREIGN KEY constraint failed";
const ROSTER_VERSION_CONSTRAINT = `roster_version = '${DECISION_LEG_ROSTER_VERSION}'`;

const REFUSAL_CASES: readonly RefusalCase[] = Object.freeze([
  {
    attempt: (f) => insertRoster(
      f.database, f.decisionWithoutRoster, 1, undefined, `${DECISION_LEG_ROSTER_VERSION}x`,
    ),
    name: "roster_version other than the pinned roster version",
    refusal: [CHECK_FAILED, ROSTER_VERSION_CONSTRAINT],
  },
  {
    attempt: (f) => insertRoster(f.database, f.decisionWithoutRoster, 0),
    name: "leg_count of zero",
    refusal: [CHECK_FAILED, `leg_count BETWEEN 1 AND ${MAX_DECISION_LEGS}`],
  },
  {
    attempt: (f) => insertRoster(f.database, f.decisionWithoutRoster, MAX_DECISION_LEGS + 1),
    name: "leg_count above MAX_DECISION_LEGS",
    refusal: [CHECK_FAILED, `leg_count BETWEEN 1 AND ${MAX_DECISION_LEGS}`],
  },
  {
    attempt: (f) => insertRoster(f.database, f.decisionWithoutRoster, 1, "abcdef"),
    name: "roster_sha256 of the wrong length",
    refusal: [CHECK_FAILED, "length(roster_sha256) = 64"],
  },
  {
    attempt: (f) => insertRoster(f.database, f.decisionWithoutRoster, 1, NON_HEX_DIGEST),
    name: "roster_sha256 holding a non-hex character",
    refusal: [CHECK_FAILED, "roster_sha256 NOT GLOB"],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1", decisionId: f.decisionA, index: -1,
    }),
    name: "leg_index below zero",
    refusal: [CHECK_FAILED, `leg_index BETWEEN 0 AND ${MAX_DECISION_LEGS - 1}`],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1", decisionId: f.decisionA, index: MAX_DECISION_LEGS,
    }),
    name: "leg_index at MAX_DECISION_LEGS",
    refusal: [CHECK_FAILED, `leg_index BETWEEN 0 AND ${MAX_DECISION_LEGS - 1}`],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1", decisionId: f.decisionA, expectedVersion: -1, index: 0,
    }),
    name: "expected_version below zero",
    refusal: [CHECK_FAILED, `expected_version BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}`],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1",
      decisionId: f.decisionA,
      expectedVersion: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      index: 0,
    }),
    name: "expected_version above the safe-integer ceiling",
    refusal: [CHECK_FAILED, `expected_version BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}`],
  },
  {
    attempt: (f) => {
      insertLeg(f.database, { aggregateId: "goal-1", decisionId: f.decisionA, index: 0 });
      insertLeg(f.database, { aggregateId: "goal-2", decisionId: f.decisionA, index: 0 });
    },
    name: "duplicate decision_id and leg_index against the primary key",
    refusal: [UNIQUE_FAILED, "command_decision_legs.decision_id, command_decision_legs.leg_index"],
  },
  {
    attempt: (f) => {
      insertLeg(f.database, { aggregateId: "goal-1", decisionId: f.decisionA, index: 0 });
      insertLeg(f.database, { aggregateId: "goal-1", decisionId: f.decisionA, index: 1 });
    },
    name: "duplicate decision_id and aggregate_id against its unique identity",
    refusal: [UNIQUE_FAILED, "command_decision_legs.decision_id, command_decision_legs.aggregate_id"],
  },
  {
    attempt: (f) => {
      insertLeg(f.database, {
        aggregateId: "goal-1",
        decisionId: f.decisionA,
        index: 0,
        receiptCommandId: "shared-leg-receipt-1",
      });
      insertLeg(f.database, {
        aggregateId: "goal-1",
        decisionId: f.decisionB,
        index: 0,
        receiptCommandId: "shared-leg-receipt-1",
      });
    },
    name: "one receipt_command_id reused across two decisions",
    refusal: [UNIQUE_FAILED, "command_decision_legs.receipt_command_id"],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1",
      decisionId: f.decisionA,
      index: 0,
      receiptCommandId: "shared-leg-receipt-1",
      requestSha256: null,
    }),
    name: "receipt command id present with a null request digest",
    refusal: [CHECK_FAILED, "receipt_command_id IS NULL"],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1",
      decisionId: f.decisionA,
      effectSha256: null,
      index: 0,
      receiptCommandId: "shared-leg-receipt-1",
    }),
    name: "receipt command id present with a null effect digest",
    refusal: [CHECK_FAILED, "receipt_command_id IS NULL"],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1",
      decisionId: f.decisionA,
      effectSha256: null,
      index: 0,
      receiptCommandId: null,
      requestSha256: digest("orphan-request"),
    }),
    name: "request digest set alone",
    refusal: [CHECK_FAILED, "receipt_command_id IS NULL"],
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1",
      decisionId: f.decisionA,
      effectSha256: digest("orphan-effect"),
      index: 0,
      receiptCommandId: null,
      requestSha256: null,
    }),
    name: "effect digest set alone",
    refusal: [CHECK_FAILED, "receipt_command_id IS NULL"],
  },
  {
    attempt: (f) => insertRoster(f.database, f.absentDecisionId, 1),
    name: "roster naming a decision that does not exist",
    refusal: [FOREIGN_KEY_FAILED],
    requiresForeignKeys: true,
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1", decisionId: f.decisionWithoutRoster, index: 0,
    }),
    name: "leg naming a roster that does not exist",
    refusal: [FOREIGN_KEY_FAILED],
    requiresForeignKeys: true,
  },
  {
    attempt: (f) => insertLeg(f.database, {
      aggregateId: "goal-1",
      decisionId: f.decisionA,
      index: 0,
      receiptCommandId: "receipt-never-inserted",
    }),
    name: "leg naming a receipt that does not exist",
    refusal: [FOREIGN_KEY_FAILED],
    requiresForeignKeys: true,
  },
]);

const EXPECTED_REFUSAL_CASE_COUNT = 19;
const EXPECTED_FOREIGN_KEY_CASE_COUNT = 3;

describe("v7 decision-leg schema refusals (task-95d5d80e91024f14916b10599aaa5b8e)", () => {
  it("keeps the refusal roster at its frozen, non-empty, duplicate-free size", () => {
    expect(EXPECTED_REFUSAL_CASE_COUNT).toBeGreaterThan(0);
    expect(REFUSAL_CASES).toHaveLength(EXPECTED_REFUSAL_CASE_COUNT);
    expect(new Set(REFUSAL_CASES.map((kase) => kase.name)).size).toBe(EXPECTED_REFUSAL_CASE_COUNT);
    expect(REFUSAL_CASES.filter((kase) => kase.requiresForeignKeys === true))
      .toHaveLength(EXPECTED_FOREIGN_KEY_CASE_COUNT);
  });

  it.each(REFUSAL_CASES)("refuses $name", (kase: RefusalCase) => {
    const fixture = seedRefusalFixture();
    try {
      if (kase.requiresForeignKeys === true) {
        expect(readForeignKeysPragma(fixture.database)).toBe(1);
      }
      const message = refusalMessage(() => kase.attempt(fixture));
      for (const fragment of kase.refusal) {
        expect(message).toContain(fragment);
      }
    } finally {
      fixture.database.close();
    }
  });
});

interface ThreeLegFixture {
  readonly database: DatabaseSync;
  readonly decisionId: string;
  readonly legReceiptIds: readonly string[];
  readonly rosterSha256: string;
}

function seedCommittedThreeLegDecision(): ThreeLegFixture {
  const database = openHarness();
  const decisionId = insertDecision(database, "independence", null);
  const rosterSha256 = digest("roster/independence");
  const legReceiptIds: string[] = [];
  insertRoster(database, decisionId, 3, rosterSha256);
  for (const index of [0, 1, 2]) {
    legReceiptIds.push(insertReceipt(database, `independence-receipt-${index}`));
    insertLeg(database, {
      aggregateId: `goal-${index}`,
      decisionId,
      expectedVersion: index,
      index,
      receiptCommandId: `independence-receipt-${index}`,
    });
  }
  return { database, decisionId, legReceiptIds, rosterSha256 };
}

describe("v7 decision-leg roster independence (task-95d5d80e91024f14916b10599aaa5b8e)", () => {
  it("keeps leg_count and roster_sha256 untouched when a leg row is deleted", () => {
    const { database, decisionId, rosterSha256 } = seedCommittedThreeLegDecision();
    try {
      const before = { ...readRoster(database, decisionId) };
      run(database, "DELETE FROM command_decision_legs WHERE decision_id = ? AND leg_index = ?",
        decisionId, 1);
      const after = readRoster(database, decisionId);
      expect(after.leg_count).toBe(3);
      expect(after.roster_sha256).toBe(rosterSha256);
      expect({ ...after }).toEqual(before);
      // The summary is independent authority, so the missing leg is detectable
      // by comparing surviving rows against a count nothing re-derived.
      const surviving = readLegs(database, decisionId);
      expect(surviving).toHaveLength(2);
      expect(surviving.map((leg) => leg.leg_index)).toEqual([0, 2]);
      expect(surviving.length).not.toBe(after.leg_count);
    } finally {
      database.close();
    }
  });

  it("keeps the roster row untouched when the surviving legs are reordered", () => {
    const { database, decisionId, rosterSha256 } = seedCommittedThreeLegDecision();
    try {
      const before = { ...readRoster(database, decisionId) };
      const parkingIndex = MAX_DECISION_LEGS - 1;
      const move = (from: number, to: number): void => {
        run(database, "UPDATE command_decision_legs SET leg_index = ? WHERE decision_id = ? AND leg_index = ?",
          to, decisionId, from);
      };
      move(0, parkingIndex);
      move(2, 0);
      move(parkingIndex, 2);
      const after = readRoster(database, decisionId);
      expect(after.leg_count).toBe(3);
      expect(after.roster_sha256).toBe(rosterSha256);
      expect({ ...after }).toEqual(before);
      const reordered = readLegs(database, decisionId);
      expect(reordered).toHaveLength(3);
      expect(reordered.map((leg) => leg.aggregate_id)).toEqual(["goal-2", "goal-1", "goal-0"]);
    } finally {
      database.close();
    }
  });

  it("restricts deleting a command_decisions row whose roster carries zero legs", () => {
    // DIVERGENCE fixture for the roster's own ON DELETE RESTRICT. The legs'
    // identical downstream RESTRICT cannot answer here because no leg row
    // exists, and sqlite-schema-decision-legs.ts:16 is this schema's ONLY
    // referrer of command_decisions, so the roster FK is the sole mechanism
    // able to refuse. Loosen it by one to ON DELETE CASCADE and the roster is
    // swept away instead: the delete succeeds and this arm reds, while the
    // three-leg arm below stays green on the legs' fence.
    const database = openHarness();
    try {
      const decisionId = insertDecision(database, "roster-only-restrict", null);
      insertRoster(database, decisionId, 1, digest("roster/roster-only-restrict"));
      expect(readForeignKeysPragma(database)).toBe(1);
      expect(readLegs(database, decisionId)).toHaveLength(0);
      // The divergence rests on this, so it is asserted rather than asserted in
      // prose: the roster is the only table pointing at command_decisions.
      expect(referrersOf(database, "command_decisions"))
        .toEqual(["command_decision_leg_rosters"]);
      const message = refusalMessage(() => {
        run(database, "DELETE FROM command_decisions WHERE decision_id = ?", decisionId);
      });
      expect(message).toContain(FOREIGN_KEY_FAILED);
      // Both rows survive the refused delete; under CASCADE neither would.
      expect(database.prepare("SELECT COUNT(*) AS total FROM command_decisions").get()?.total).toBe(1);
      expect(readRoster(database, decisionId).leg_count).toBe(1);
    } finally {
      database.close();
    }
  });

  it("restricts deleting a command_decisions row while a roster references it", () => {
    const { database, decisionId } = seedCommittedThreeLegDecision();
    try {
      expect(readForeignKeysPragma(database)).toBe(1);
      const message = refusalMessage(() => {
        run(database, "DELETE FROM command_decisions WHERE decision_id = ?", decisionId);
      });
      expect(message).toContain(FOREIGN_KEY_FAILED);
      // REACHING case only. Loosen the roster FK and the delete cascades into
      // the roster row, whereupon the legs' own identical ON DELETE RESTRICT
      // refuses with the byte-identical message, so this arm cannot name which
      // fence spoke. The zero-leg arm above is the divergence that isolates the
      // roster FK. The teardown below only shows the delete succeeds once
      // nothing references the decision at all.
      run(database, "DELETE FROM command_decision_legs WHERE decision_id = ?", decisionId);
      run(database, "DELETE FROM command_decision_leg_rosters WHERE decision_id = ?", decisionId);
      run(database, "DELETE FROM command_decisions WHERE decision_id = ?", decisionId);
      expect(database.prepare("SELECT COUNT(*) AS total FROM command_decisions").get()?.total).toBe(0);
    } finally {
      database.close();
    }
  });

  it("restricts deleting a command_receipts row while a leg references it", () => {
    const { database, decisionId, legReceiptIds } = seedCommittedThreeLegDecision();
    try {
      expect(readForeignKeysPragma(database)).toBe(1);
      const receiptCommandId = legReceiptIds[1] ?? "unreachable-receipt";
      expect(receiptCommandId).toBe("independence-receipt-1");
      const message = refusalMessage(() => {
        run(database, "DELETE FROM command_receipts WHERE command_id = ?", receiptCommandId);
      });
      expect(message).toContain(FOREIGN_KEY_FAILED);
      // Divergence control: only the leg references this receipt, so dropping
      // that one leg releases it while the other legs stay bound.
      run(database, "DELETE FROM command_decision_legs WHERE decision_id = ? AND leg_index = ?",
        decisionId, 1);
      run(database, "DELETE FROM command_receipts WHERE command_id = ?", receiptCommandId);
      expect(readLegs(database, decisionId)).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
