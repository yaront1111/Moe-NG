import type { DatabaseSync } from "node:sqlite";

import {
  COMMAND_EFFECT_IDENTITY_VERSION,
  COMMAND_REQUEST_IDENTITY_VERSION,
  DurableStoreError,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  RECEIPT_RESULT_VERSION,
  SQLITE_SCHEMA_MANIFEST_VERSION,
} from "./store-contracts.js";
import { SCHEMA_VERSION } from "./store-internals.js";
import {
  validateExactSchemaObjects,
  validateSchemaManifestMetadata,
} from "./sqlite-schema-conformance.js";
import { SCHEMA_OBJECT_SQL } from "./sqlite-schema-manifest.js";
import { readScalar, requireRowInteger } from "./store-rows.js";
import { DecisionLedgerIntegrityError } from "./decision-leg-roster.js";

export function validateSchema(database: DatabaseSync): void {
  try {
    validateExactSchemaObjects(database, SCHEMA_OBJECT_SQL, SCHEMA_VERSION);
    validateSchemaManifestMetadata(database, SQLITE_SCHEMA_MANIFEST_VERSION);
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.some((row) => {
      const table = row.table;
      return table === "command_decision_leg_rosters" || table === "command_decision_legs";
    })) {
      throw new DecisionLedgerIntegrityError();
    }
    if (foreignKeyViolations.length !== 0) {
      throw new DurableStoreError(
        "STORE_SCHEMA_INVALID",
        "foreign-key verification found durable relationship violations",
      );
    }
    if (String(readScalar(database, "PRAGMA quick_check", "quick_check")) !== "ok") {
      throw new DurableStoreError("STORE_SCHEMA_INVALID", "SQLite quick_check did not pass");
    }

    const semanticRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM command_receipts AS receipts
        WHERE
          receipts.request_identity_version <> ?
          OR receipts.result_version <> ?
          OR receipts.effect_identity_version <> ?
          OR receipts.current_version - receipts.previous_version <> receipts.event_count
          OR NOT EXISTS (
            SELECT 1
            FROM aggregate_heads AS heads
            WHERE heads.aggregate_id = receipts.aggregate_id
              AND heads.version >= receipts.current_version
          )
          OR (
            SELECT count(*)
            FROM domain_events AS events
            WHERE events.command_id = receipts.command_id
          ) <> receipts.event_count
          OR EXISTS (
            SELECT 1
            FROM domain_events AS events
            WHERE events.command_id = receipts.command_id
              AND (
                events.aggregate_id <> receipts.aggregate_id
                OR events.aggregate_sequence <>
                  receipts.previous_version + events.command_event_index + 1
                OR events.command_event_index >= receipts.event_count
                OR events.record_version <> ?
                OR events.payload_codec_version <> ?
                OR events.request_sha256 <> receipts.request_sha256
                OR events.committed_at <> receipts.committed_at
              )
          )
          OR (
            SELECT count(*)
            FROM outbox_messages AS messages
            INNER JOIN domain_events AS events ON events.event_id = messages.event_id
            WHERE events.command_id = receipts.command_id
          ) <> receipts.outbox_count
      `)
      .get(
        COMMAND_REQUEST_IDENTITY_VERSION,
        RECEIPT_RESULT_VERSION,
        COMMAND_EFFECT_IDENTITY_VERSION,
        EVENT_RECORD_VERSION,
        OPAQUE_PAYLOAD_CODEC_VERSION,
      );
    if (requireRowInteger(semanticRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "durable command receipts do not match the authoritative event ledger",
      );
    }
    const aggregateRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM (
          SELECT heads.aggregate_id
          FROM aggregate_heads AS heads
          LEFT JOIN (
            SELECT
              aggregate_id,
              count(*) AS event_count,
              max(aggregate_sequence) AS maximum_sequence
            FROM domain_events
            GROUP BY aggregate_id
          ) AS ledger ON ledger.aggregate_id = heads.aggregate_id
          WHERE
            ledger.maximum_sequence IS NULL
            OR heads.version <> ledger.maximum_sequence
            OR ledger.event_count <> ledger.maximum_sequence

          UNION ALL

          SELECT ledger.aggregate_id
          FROM (
            SELECT
              aggregate_id,
              count(*) AS event_count,
              max(aggregate_sequence) AS maximum_sequence
            FROM domain_events
            GROUP BY aggregate_id
          ) AS ledger
          LEFT JOIN aggregate_heads AS heads ON heads.aggregate_id = ledger.aggregate_id
          WHERE heads.aggregate_id IS NULL
        )
      `)
      .get();
    if (requireRowInteger(aggregateRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "aggregate heads do not exactly match the event ledger",
      );
    }

    const unexpectedSequenceRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM sqlite_sequence
        WHERE
          name IS NULL
          OR name NOT IN ('domain_events', 'outbox_messages', 'command_decisions')
      `)
      .get();
    if (requireRowInteger(unexpectedSequenceRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "SQLite sequence metadata names an unknown append-only ledger",
      );
    }

    const sequenceRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM (
          SELECT
            'domain_events' AS table_name,
            (SELECT min(global_position) FROM domain_events) AS minimum_position,
            (SELECT max(global_position) FROM domain_events) AS maximum_position,
            (SELECT count(*) FROM domain_events) AS ledger_row_count,
            (SELECT seq FROM sqlite_sequence WHERE name = 'domain_events') AS sequence_value,
            typeof((SELECT seq FROM sqlite_sequence WHERE name = 'domain_events')) AS sequence_type,
            (SELECT count(*) FROM sqlite_sequence WHERE name = 'domain_events') AS sequence_row_count

          UNION ALL

          SELECT
            'outbox_messages',
            (SELECT min(outbox_position) FROM outbox_messages),
            (SELECT max(outbox_position) FROM outbox_messages),
            (SELECT count(*) FROM outbox_messages),
            (SELECT seq FROM sqlite_sequence WHERE name = 'outbox_messages'),
            typeof((SELECT seq FROM sqlite_sequence WHERE name = 'outbox_messages')),
            (SELECT count(*) FROM sqlite_sequence WHERE name = 'outbox_messages')

          UNION ALL

          SELECT
            'command_decisions',
            (SELECT min(decision_position) FROM command_decisions),
            (SELECT max(decision_position) FROM command_decisions),
            (SELECT count(*) FROM command_decisions),
            (SELECT seq FROM sqlite_sequence WHERE name = 'command_decisions'),
            typeof((SELECT seq FROM sqlite_sequence WHERE name = 'command_decisions')),
            (SELECT count(*) FROM sqlite_sequence WHERE name = 'command_decisions')
        ) AS sequence_evidence
        WHERE
          (
            maximum_position IS NULL
            AND sequence_row_count <> 0
          )
          OR (
            maximum_position IS NOT NULL
            AND (
              minimum_position <> 1
              OR ledger_row_count <> maximum_position
              OR sequence_row_count <> 1
              OR sequence_type <> 'integer'
              OR sequence_value <> maximum_position
            )
          )
      `)
      .get();
    if (requireRowInteger(sequenceRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "append-only ledger positions conflict with SQLite sequence evidence",
      );
    }
  } catch (error) {
    if (error instanceof DurableStoreError) {
      throw error;
    }
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      "unable to verify the application schema",
      { cause: error },
    );
  }
}
