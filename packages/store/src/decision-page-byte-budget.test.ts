import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import {
  MAX_PAGE_DECODED_BYTES,
  SqliteEventStore,
} from "./index.js";
import { READ_PAGE_ROW_OVERHEAD_BYTES } from "./read-page-budget.js";

const textEncoder = new TextEncoder();

function fieldBytes(value: unknown): number {
  if (value === null) return 0;
  if (typeof value === "string") return textEncoder.encode(value).byteLength;
  if (value instanceof Uint8Array) return value.byteLength;
  throw new Error(`unexpected variable-field value ${String(value)}`);
}

function rowBytes(row: Record<string, unknown>, columns: readonly string[]): number {
  return (
    READ_PAGE_ROW_OVERHEAD_BYTES +
    columns.reduce((total, column) => total + fieldBytes(row[column]), 0)
  );
}

function requiredRow(
  row: Record<string, unknown> | undefined,
  description: string,
): Record<string, unknown> {
  if (row === undefined) throw new Error(`missing ${description}`);
  return row;
}

function decisionOracleBytes(database: DatabaseSync, position: bigint): number {
  const decision = requiredRow(
    database
      .prepare(`
        SELECT
          CAST(decision_position AS TEXT) AS decision_position_text,
          project_id, principal_id, command_id, command_kind, decision_id,
          record_version, coverage, request_identity_version, request_sha256,
          target_aggregate_id, effect_disposition, result_code, result_version,
          result_bytes, result_sha256, decided_at, correlation_sha256,
          receipt_command_id, audit_event_id, effect_identity_version,
          effect_sha256, decision_identity_version, decision_sha256
        FROM command_decisions
        WHERE decision_position = ?
      `)
      .get(position),
    "decision",
  );
  const receiptCommandId = decision.receipt_command_id;
  if (typeof receiptCommandId !== "string") throw new Error("invalid receipt link");
  const decisionId = decision.decision_id;
  if (typeof decisionId !== "string") throw new Error("invalid decision identity");
  const roster = requiredRow(
    database.prepare(`
      SELECT decision_id, roster_version, roster_sha256
      FROM command_decision_leg_rosters
      WHERE decision_id = ?
    `).get(decisionId),
    "decision leg roster",
  );
  const legs = database.prepare(`
    SELECT
      decision_id, aggregate_id, receipt_command_id,
      receipt_request_sha256, receipt_effect_sha256
    FROM command_decision_legs
    WHERE decision_id = ?
    ORDER BY leg_index
  `).all(decisionId);
  const receiptIds = new Set<string>([receiptCommandId]);
  for (const leg of legs) {
    if (typeof leg.receipt_command_id === "string") receiptIds.add(leg.receipt_command_id);
  }
  const receipts = [...receiptIds].map((commandId) => requiredRow(
    database.prepare(`
      SELECT
        command_id, request_identity_version, request_sha256, result_version,
        effect_identity_version, effect_sha256, aggregate_id, committed_at
      FROM command_receipts
      WHERE command_id = ?
    `).get(commandId),
    "receipt",
  ));
  const scopes = [...receiptIds].map((commandId) => requiredRow(
    database.prepare(`
      SELECT project_id
      FROM command_receipt_scopes
      WHERE receipt_command_id = ?
    `).get(commandId),
    "receipt scope",
  ));
  const events = [...receiptIds].flatMap((commandId) => database.prepare(`
      SELECT
        CAST(global_position AS TEXT) AS global_position_text,
        event_id, aggregate_id, record_version, payload_codec_version,
        request_sha256, event_type, payload, metadata, committed_at
      FROM domain_events
      WHERE command_id = ?
      ORDER BY command_event_index
    `).all(commandId));
  const outbox = [...receiptIds].flatMap((commandId) => database.prepare(`
      SELECT
        CAST(messages.outbox_position AS TEXT) AS outbox_position_text,
        messages.message_id, messages.event_id, messages.topic,
        messages.payload, messages.headers, messages.created_at
      FROM outbox_messages AS messages
      INNER JOIN domain_events AS events ON events.event_id = messages.event_id
      WHERE events.command_id = ?
      ORDER BY events.command_event_index, messages.event_outbox_index
    `).all(commandId));

  let total = rowBytes(decision, [
    "decision_position_text",
    "project_id",
    "principal_id",
    "command_id",
    "command_kind",
    "decision_id",
    "record_version",
    "coverage",
    "request_identity_version",
    "request_sha256",
    "target_aggregate_id",
    "effect_disposition",
    "result_code",
    "result_version",
    "result_bytes",
    "result_sha256",
    "decided_at",
    "correlation_sha256",
    "receipt_command_id",
    "audit_event_id",
    "effect_identity_version",
    "effect_sha256",
    "decision_identity_version",
    "decision_sha256",
  ]);
  total += rowBytes(roster, ["decision_id", "roster_version", "roster_sha256"]);
  total += legs.reduce((sum, row) => sum + rowBytes(row, [
    "decision_id",
    "aggregate_id",
    "receipt_command_id",
    "receipt_request_sha256",
    "receipt_effect_sha256",
  ]), 0);
  total += receipts.reduce((sum, receipt) => sum + rowBytes(receipt, [
    "command_id", "request_identity_version", "request_sha256", "result_version",
    "effect_identity_version", "effect_sha256", "aggregate_id", "committed_at",
  ]), 0);
  total += scopes.reduce((sum, scope) => sum + rowBytes(scope, ["project_id"]), 0);
  total += events.reduce(
    (sum, row) =>
      sum +
      rowBytes(row, [
        "global_position_text",
        "event_id",
        "aggregate_id",
        "record_version",
        "payload_codec_version",
        "request_sha256",
        "event_type",
        "payload",
        "metadata",
        "committed_at",
      ]),
    0,
  );
  total += outbox.reduce(
    (sum, row) =>
      sum +
      rowBytes(row, [
        "outbox_position_text",
        "message_id",
        "event_id",
        "topic",
        "payload",
        "headers",
        "created_at",
      ]),
    0,
  );

  if (typeof decision.audit_event_id === "string") {
    const audit = requiredRow(
      database
        .prepare(`
          SELECT aggregate_id, command_id, event_type, payload, metadata
          FROM domain_events
          WHERE event_id = ?
        `)
        .get(decision.audit_event_id),
      "rejection audit",
    );
    total += rowBytes(audit, [
      "aggregate_id",
      "command_id",
      "event_type",
      "payload",
      "metadata",
    ]);
  }
  return total;
}

function addDecision(store: SqliteEventStore, index: number): void {
  store.commitExpectedVersionDecision({
    commandKind: "goal.create",
    committedResultBytes: new Uint8Array(4_096).fill(index),
    correlationId: `correlation-${index}`,
    decidedAt: `2026-08-06T21:0${index}:00.000Z`,
    events: [
      {
        eventId: `decision-event-${index}`,
        eventType: "goal.created",
        payload: new Uint8Array(64).fill(index),
      },
    ],
    expectedVersion: 0,
    key: {
      commandId: `decision-command-${index}`,
      principalId: "principal-page",
      projectId: "project-page",
    },
    requestBytes: new Uint8Array([index]),
    targetAggregateId: `decision-goal-${index}`,
  });
}

it("walks decision pages by verified materialized bytes without gaps", () => {
  const store = SqliteEventStore.openEphemeralForProjectTest("project-page");
  try {
    addDecision(store, 1);
    addDecision(store, 2);
    addDecision(store, 3);

    const commandIds: string[] = [];
    let cursor = 0n;
    for (;;) {
      const page = store.readCommandDecisionsAfter(cursor, 10, 10_000);
      expect(page.items).toHaveLength(1);
      commandIds.push(...page.items.map((decision) => decision.key.commandId));
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }
    expect(commandIds).toEqual([
      "decision-command-1",
      "decision-command-2",
      "decision-command-3",
    ]);

    expect(() => store.readCommandDecisionsAfter(0n, 10, 1)).toThrowError(
      /STORE_LIMIT_EXCEEDED/u,
    );
    expect(() =>
      store.readCommandDecisionsAfter(0n, 10, MAX_PAGE_DECODED_BYTES + 1),
    ).toThrowError(/STORE_LIMIT_EXCEEDED/u);
  } finally {
    store.close();
  }
});

it("independently proves effectful-outbox and stale-audit byte boundaries", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-decision-page-boundary-"));
  const databasePath = join(directory, "decisions.sqlite");
  try {
    const store = SqliteEventStore.openForProject(databasePath, "project-page");
    try {
      const effectful = store.commitExpectedVersionDecision({
        commandKind: "goal.create",
        committedResultBytes: new Uint8Array(1_024).fill(1),
        correlationId: "effectful-correlation",
        decidedAt: "2026-08-06T21:20:00.000Z",
        events: [
          {
            eventId: "effectful-event",
            eventType: "goal.created",
            outbox: [
              {
                headers: new Uint8Array(32).fill(2),
                messageId: "effectful-message",
                payload: new Uint8Array(1_024).fill(3),
                topic: "goal.events",
              },
            ],
            payload: new Uint8Array(128).fill(4),
          },
        ],
        expectedVersion: 0,
        key: {
          commandId: "effectful-command",
          principalId: "principal-page",
          projectId: "project-page",
        },
        requestBytes: new Uint8Array([1]),
        targetAggregateId: "effectful-goal",
      });
      store.commit({
        aggregateId: "stale-goal",
        commandBytes: new Uint8Array([2]),
        commandId: "stale-seed-command",
        committedAt: "2026-08-06T21:21:00.000Z",
        events: [
          {
            eventId: "stale-seed-event",
            eventType: "goal.seeded",
            payload: new Uint8Array([2]),
          },
        ],
        expectedVersion: 0,
      });
      const stale = store.commitExpectedVersionDecision({
        commandKind: "goal.change",
        committedResultBytes: new Uint8Array(512).fill(5),
        correlationId: "stale-correlation",
        decidedAt: "2026-08-06T21:22:00.000Z",
        events: [
          {
            eventId: "rejected-proposal-event",
            eventType: "goal.changed",
            payload: new Uint8Array(512).fill(6),
          },
        ],
        expectedVersion: 0,
        key: {
          commandId: "stale-command",
          principalId: "principal-page",
          projectId: "project-page",
        },
        requestBytes: new Uint8Array([3]),
        targetAggregateId: "stale-goal",
      });

      const probe = new DatabaseSync(databasePath);
      let effectfulBytes: number;
      let staleBytes: number;
      try {
        effectfulBytes = decisionOracleBytes(
          probe,
          effectful.decision.decisionPosition,
        );
        staleBytes = decisionOracleBytes(probe, stale.decision.decisionPosition);
      } finally {
        probe.close();
      }

      expect(effectfulBytes).toBeLessThanOrEqual(MAX_PAGE_DECODED_BYTES);
      expect(
        store.readCommandDecisionsAfter(0n, 10, effectfulBytes).items.map(
          (decision) => decision.key.commandId,
        ),
      ).toEqual(["effectful-command"]);
      expect(() =>
        store.readCommandDecisionsAfter(0n, 10, effectfulBytes - 1),
      ).toThrowError(/STORE_LIMIT_EXCEEDED/u);

      expect(staleBytes).toBeLessThanOrEqual(MAX_PAGE_DECODED_BYTES);
      expect(
        store
          .readCommandDecisionsAfter(
            effectful.decision.decisionPosition,
            10,
            staleBytes,
          )
          .items.map((decision) => decision.key.commandId),
      ).toEqual(["stale-command"]);
      expect(() =>
        store.readCommandDecisionsAfter(
          effectful.decision.decisionPosition,
          10,
          staleBytes - 1,
        ),
      ).toThrowError(/STORE_LIMIT_EXCEEDED/u);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("charges every receipt and scope in a multi-leg decision byte boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-decision-page-multi-leg-"));
  const databasePath = join(directory, "decisions.sqlite");
  try {
    const store = SqliteEventStore.openForProject(databasePath, "project-page");
    try {
      const response = store.commitExpectedVersionDecisionLegs({
        commandKind: "goal.create-many",
        committedResultBytes: new Uint8Array(128).fill(7),
        correlationId: "multi-leg-correlation",
        decidedAt: "2026-08-06T21:23:00.000Z",
        key: {
          commandId: "multi-leg-command",
          principalId: "principal-page",
          projectId: "project-page",
        },
        legs: [0, 1, 2].map((index) => ({
          aggregateId: `multi-leg-goal-${index}`,
          events: [{
            eventId: `multi-leg-event-${index}`,
            eventType: "goal.created",
            payload: new Uint8Array(32).fill(index + 1),
          }],
          expectedVersion: 0,
        })),
        requestBytes: new Uint8Array([7, 8, 9]),
      });

      const probe = new DatabaseSync(databasePath);
      let exactBytes: number;
      try {
        exactBytes = decisionOracleBytes(probe, response.decision.decisionPosition);
      } finally {
        probe.close();
      }

      expect(exactBytes).toBeLessThanOrEqual(MAX_PAGE_DECODED_BYTES);
      expect(
        store.readCommandDecisionsAfter(0n, 10, exactBytes).items.map(
          (decision) => decision.key.commandId,
        ),
      ).toEqual(["multi-leg-command"]);
      expect(() =>
        store.readCommandDecisionsAfter(0n, 10, exactBytes - 1),
      ).toThrowError(/STORE_LIMIT_EXCEEDED/u);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
