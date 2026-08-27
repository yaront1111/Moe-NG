import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  PRIMARY,
  PROJECT_ID,
  SECONDARY,
  seedActive,
  seedActiveWithoutBody,
  withStore,
} from "../planning/graph-query-test-fixtures.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import {
  POLICY_RISK_EVENT_TYPE,
  buildPolicyRiskRecord,
  policyRiskAggregateIdFor,
} from "./policy-risk-record.js";
import {
  POLICY_RISK_READER_CODES,
  readPolicyRisk,
} from "./policy-risk-reader.js";

const ENCODER = new TextEncoder();
const PRINCIPAL_ID = "principal-risk-reader-1";
const ACTION = "policy.validate";
const ASSESSED_AT = "2026-08-27T00:00:00.000Z";

interface SeedRecord {
  readonly actionKind: string;
  readonly approvedBy: string;
  readonly assessedAt: string;
  readonly decisionRef: string;
  readonly projectId: string;
  readonly subjectRef: string;
  readonly subjectRevision: number;
  readonly tier: "R2";
}

function activeRecord(store: SqliteEventStore): SeedRecord {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`active graph fixture refused: ${active.code}`);
  return {
    actionKind: ACTION,
    approvedBy: PRINCIPAL_ID,
    assessedAt: ASSESSED_AT,
    decisionRef: "decision-risk-reader-1",
    projectId: PROJECT_ID,
    subjectRef: active.graphContentHash,
    subjectRevision: active.graphEpoch,
    tier: "R2",
  };
}

function seedRecord(store: SqliteEventStore, record: SeedRecord): void {
  const built = buildPolicyRiskRecord(record);
  if (!built.ok) throw new Error(`record fixture refused: ${built.code}`);
  const aggregateId = policyRiskAggregateIdFor(record);
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode(`seed-${record.decisionRef}`),
    commandId: `seed-${record.decisionRef}`,
    committedAt: ASSESSED_AT,
    events: [{
      eventId: `event-${record.decisionRef}`,
      eventType: POLICY_RISK_EVENT_TYPE,
      payload: built.bytes,
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  });
}

function seedUnreadable(store: SqliteEventStore, record: SeedRecord): void {
  const aggregateId = policyRiskAggregateIdFor(record);
  store.commit({
    aggregateId,
    commandBytes: ENCODER.encode("seed-unreadable-risk"),
    commandId: "seed-unreadable-risk",
    committedAt: ASSESSED_AT,
    events: [{
      eventId: "event-unreadable-risk",
      eventType: POLICY_RISK_EVENT_TYPE,
      payload: ENCODER.encode("{not-json"),
    }],
    expectedVersion: 0,
  });
}

function expectUnknown(
  result: ReturnType<typeof readPolicyRisk>,
  code: string,
  layer = "DAEMON_POLICY_RISK",
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected UNKNOWN policy risk");
  expect(result.code).toBe(code);
  expect(result.layer).toBe(layer);
  expect(result.tier).toBeNull();
  expect(result.truthClass).toBe("UNKNOWN");
  expect(result).not.toHaveProperty("factId");
}

const JOIN_CASES = Object.freeze([
  ["project", "POLICY_RISK_PROJECT_FOREIGN", (record: SeedRecord) => ({
    ...record, projectId: "project-foreign",
  })],
  ["approvedBy", "POLICY_RISK_APPROVER_FOREIGN", (record: SeedRecord) => ({
    ...record, approvedBy: "principal-foreign",
  })],
  ["action", "POLICY_RISK_ACTION_MISSING", (record: SeedRecord) => ({
    ...record, actionKind: "policy.foreign",
  })],
  ["subjectRef", "POLICY_RISK_SUBJECT_STALE", (record: SeedRecord) => ({
    ...record, subjectRef: "f".repeat(64),
  })],
  ["subjectRevision", "POLICY_RISK_REVISION_STALE", (record: SeedRecord) => ({
    ...record, subjectRevision: record.subjectRevision - 1,
  })],
] as const);

describe("strict durable policy-risk reader", () => {
  it("returns only a fully joined human-approved record, with its tier copied verbatim", () => {
    withStore("policy-risk-happy", (store) => {
      seedActive(store);
      const record = activeRecord(store);
      seedRecord(store, record);

      const result = readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, ACTION);

      expect(result).toEqual({
        factId: record.decisionRef,
        ok: true,
        tier: "R2",
        truthClass: "HUMAN_APPROVED",
      });
      expect(result.truthClass).not.toBe("DAEMON_VERIFIED");
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  it("pins five ordered, independently distinguished join-key refusals", () => {
    expect(JOIN_CASES).toHaveLength(5);
    expect(new Set(JOIN_CASES.map(([key]) => key)).size).toBe(5);
    expect(new Set(JOIN_CASES.map(([, code]) => code)).size).toBe(5);
  });

  it.each(JOIN_CASES)("refuses a sole %s mismatch as %s", (_key, code, change) => {
    withStore(`policy-risk-${code}`, (store) => {
      seedActive(store);
      seedRecord(store, change(activeRecord(store)));

      expectUnknown(readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, ACTION), code);
    });
  });

  it("distinguishes a missing record from every join miss", () => {
    withStore("policy-risk-missing", (store) => {
      seedActive(store);
      expectUnknown(
        readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, ACTION),
        "POLICY_RISK_RECORD_MISSING",
      );
    });
  });

  it("treats an undecodable durable row as unreadable, never absent", () => {
    withStore("policy-risk-unreadable", (store) => {
      seedActive(store);
      seedUnreadable(store, activeRecord(store));
      expectUnknown(
        readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, ACTION),
        "POLICY_RISK_RECORD_UNREADABLE",
      );
    });
  });

  it("refuses a mixed-type event in a policy-risk aggregate", () => {
    withStore("policy-risk-mixed-type", (store) => {
      seedActive(store);
      const record = activeRecord(store);
      seedRecord(store, record);
      const aggregateId = policyRiskAggregateIdFor(record);
      store.commit({
        aggregateId,
        commandBytes: ENCODER.encode("seed-unexpected-risk-event"),
        commandId: "seed-unexpected-risk-event",
        committedAt: ASSESSED_AT,
        events: [{
          eventId: "event-unexpected-risk",
          eventType: "unexpected.policy.event",
          payload: ENCODER.encode("{}"),
        }],
        expectedVersion: 1,
      });
      expectUnknown(
        readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, ACTION),
        "POLICY_RISK_RECORD_UNREADABLE",
      );
    });
  });

  it("refuses authority when the durable horizon moves during the join", () => {
    withStore("policy-risk-concurrent", (store) => {
      seedActive(store);
      seedRecord(store, activeRecord(store));
      let horizonReads = 0;
      const concurrent = new Proxy(store, {
        get(target, property) {
          if (property === "readEventHorizon") return () => {
            horizonReads += 1;
            if (horizonReads === 2) target.commit({
              aggregateId: "concurrent-unrelated",
              commandBytes: ENCODER.encode("concurrent-unrelated"),
              commandId: "concurrent-unrelated",
              committedAt: ASSESSED_AT,
              events: [{
                eventId: "event-concurrent-unrelated",
                eventType: "ConcurrentUnrelated",
                payload: ENCODER.encode("{}"),
              }],
              expectedVersion: 0,
            });
            return target.readEventHorizon();
          };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      expectUnknown(
        readPolicyRisk(concurrent, PROJECT_ID, PRINCIPAL_ID, ACTION),
        "POLICY_RISK_RECORD_UNREADABLE",
      );
      expect(horizonReads).toBe(2);
    });
  });

  it("publishes the exact nonzero reader-code roster", () => {
    expect(POLICY_RISK_READER_CODES).toEqual([
      "POLICY_RISK_RECORD_MISSING",
      "POLICY_RISK_RECORD_UNREADABLE",
      "POLICY_RISK_PROJECT_FOREIGN",
      "POLICY_RISK_APPROVER_FOREIGN",
      "POLICY_RISK_ACTION_MISSING",
      "POLICY_RISK_SUBJECT_STALE",
      "POLICY_RISK_REVISION_STALE",
    ]);
    expect(POLICY_RISK_READER_CODES).toHaveLength(7);
    expect(Object.isFrozen(POLICY_RISK_READER_CODES)).toBe(true);
  });
});

const ACTIVE_FAILURES = Object.freeze([
  ["absent", "ACTIVE_GRAPH_ABSENT", (_store: SqliteEventStore) => undefined],
  ["split brain", "ACTIVE_GRAPH_SPLIT_BRAIN", (store: SqliteEventStore) => {
    seedActive(store, "graph-revision-primary", PRIMARY);
    seedActive(store, "graph-revision-secondary", SECONDARY);
  }],
  ["body unavailable", "ACTIVE_GRAPH_BODY_UNAVAILABLE", (store: SqliteEventStore) => {
    seedActiveWithoutBody(store);
  }],
] as const);

describe("active subject refusal provenance", () => {
  it("pins the exact nonzero pass-through roster", () => {
    expect(ACTIVE_FAILURES).toHaveLength(3);
    expect(new Set(ACTIVE_FAILURES.map(([, code]) => code)).size).toBe(3);
  });

  it.each(ACTIVE_FAILURES)("preserves %s as %s", (name, code, arrange) => {
    withStore(`policy-risk-active-${name.replace(" ", "-")}`, (store) => {
      arrange(store);
      seedRecord(store, {
        actionKind: ACTION,
        approvedBy: PRINCIPAL_ID,
        assessedAt: ASSESSED_AT,
        decisionRef: `decision-${name.replace(" ", "-")}`,
        projectId: PROJECT_ID,
        subjectRef: PRIMARY.graphContentHash,
        subjectRevision: 1,
        tier: "R2",
      });

      expectUnknown(
        readPolicyRisk(store, PROJECT_ID, PRINCIPAL_ID, ACTION),
        code,
        "ACTIVE_GRAPH_PROJECTION",
      );
    });
  });
});
