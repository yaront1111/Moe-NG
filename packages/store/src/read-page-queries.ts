import { READ_PAGE_ROW_OVERHEAD_BYTES } from "./read-page-budget.js";

const bytes = (column: string): string =>
  `COALESCE(length(CAST(${column} AS BLOB)), 0)`;

/**
 * Matches a receipt/event only when the canonical decision row or its persisted
 * leg roster names that exact command ID. Prefix resemblance grants no durable
 * authority.
 *
 * Spelled as `column IN (<the decision's command ids>)`, never as
 * `decisions.receipt_command_id = column OR EXISTS (...)`: the OR form made the
 * planner SCAN every receipt, scope, event and outbox row for EVERY candidate
 * decision (four full-table scans per row), so one 200-row page cost ~130 ms
 * and a control-room surface read, which walks the ledger 23 times, ~14 s of
 * CPU (measured 2026-09-05 on a 612-decision store). The list form probes the
 * unique index each of those tables already carries on its command-id column
 * (2 ms per page, byte-identical estimates for every decision).
 */
export const decisionReceiptMatchSql = (commandIdColumn: string): string => `${commandIdColumn} IN (
      SELECT decisions.receipt_command_id
      UNION ALL
      SELECT decision_legs.receipt_command_id
      FROM command_decision_legs AS decision_legs
      WHERE decision_legs.decision_id = decisions.decision_id
    )`;

const decisionIdForReceiptSql = (commandIdColumn: string): string => `COALESCE(
      (
        SELECT decision_legs.decision_id
        FROM command_decision_legs AS decision_legs
        WHERE decision_legs.receipt_command_id = ${commandIdColumn}
      ),
      (
        SELECT direct_decisions.decision_id
        FROM command_decisions AS direct_decisions
        WHERE direct_decisions.receipt_command_id = ${commandIdColumn}
      )
    )`;

export const STORED_EVENT_SELECT_COLUMNS = `
  CAST(events.global_position AS TEXT) AS global_position,
  events.aggregate_id,
  events.aggregate_sequence,
  events.command_id,
  decisions.project_id AS decision_project_id,
  decisions.principal_id AS decision_principal_id,
  decisions.command_id AS decision_command_id,
  decisions.command_kind AS decision_command_kind,
  decisions.request_identity_version AS decision_request_identity_version,
  decisions.request_sha256 AS decision_request_sha256,
  events.record_version,
  events.payload_codec_version,
  events.domain_schema_version,
  events.request_sha256,
  events.event_id,
  events.event_type,
  events.payload,
  events.metadata,
  events.committed_at
` as const;

export const STORED_EVENT_DECISION_JOIN = `
  LEFT JOIN command_decisions AS decisions
    ON decisions.decision_id = ${decisionIdForReceiptSql("events.command_id")}
` as const;

export const EVENT_DECODED_BYTES_SQL = `(
  ${READ_PAGE_ROW_OVERHEAD_BYTES}
  + ${bytes("events.global_position")}
  + ${bytes("events.aggregate_id")}
  + ${bytes("events.command_id")}
  + ${bytes("decisions.project_id")}
  + ${bytes("decisions.principal_id")}
  + ${bytes("decisions.command_id")}
  + ${bytes("decisions.command_kind")}
  + ${bytes("decisions.request_identity_version")}
  + ${bytes("decisions.request_sha256")}
  + ${bytes("events.record_version")}
  + ${bytes("events.payload_codec_version")}
  + ${bytes("events.domain_schema_version")}
  + ${bytes("events.request_sha256")}
  + ${bytes("events.event_id")}
  + ${bytes("events.event_type")}
  + ${bytes("events.payload")}
  + ${bytes("events.metadata")}
  + ${bytes("events.committed_at")}
)` as const;

export const OUTBOX_DECODED_BYTES_SQL = `(
  ${READ_PAGE_ROW_OVERHEAD_BYTES}
  + ${bytes("outbox_messages.outbox_position")}
  + ${bytes("outbox_messages.message_id")}
  + ${bytes("outbox_messages.event_id")}
  + ${bytes("outbox_messages.topic")}
  + ${bytes("outbox_messages.payload")}
  + ${bytes("outbox_messages.headers")}
  + ${bytes("outbox_messages.created_at")}
)` as const;

const decisionTextColumns = [
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
  "result_sha256",
  "decided_at",
  "correlation_sha256",
  "receipt_command_id",
  "audit_event_id",
  "effect_identity_version",
  "effect_sha256",
  "decision_identity_version",
  "decision_sha256",
] as const;

const decisionTextBytes = decisionTextColumns
  .map((column) => bytes(`decisions.${column}`))
  .join("\n  + ");

export const DECISION_DECODED_BYTES_SQL = `(
  ${READ_PAGE_ROW_OVERHEAD_BYTES}
  + ${bytes("decisions.decision_position")}
  + ${decisionTextBytes}
  + ${bytes("decisions.result_bytes")}
  + COALESCE((
      SELECT
        ${READ_PAGE_ROW_OVERHEAD_BYTES}
        + ${bytes("leg_rosters.decision_id")}
        + ${bytes("leg_rosters.roster_version")}
        + ${bytes("leg_rosters.roster_sha256")}
      FROM command_decision_leg_rosters AS leg_rosters
      WHERE leg_rosters.decision_id = decisions.decision_id
    ), 0)
  + COALESCE((
      SELECT SUM(
        ${READ_PAGE_ROW_OVERHEAD_BYTES}
        + ${bytes("decision_legs.decision_id")}
        + ${bytes("decision_legs.aggregate_id")}
        + ${bytes("decision_legs.receipt_command_id")}
        + ${bytes("decision_legs.receipt_request_sha256")}
        + ${bytes("decision_legs.receipt_effect_sha256")}
      )
      FROM command_decision_legs AS decision_legs
      WHERE decision_legs.decision_id = decisions.decision_id
    ), 0)
  + COALESCE((
      SELECT SUM(
        ${READ_PAGE_ROW_OVERHEAD_BYTES}
        + ${bytes("receipts.command_id")}
        + ${bytes("receipts.request_identity_version")}
        + ${bytes("receipts.request_sha256")}
        + ${bytes("receipts.result_version")}
        + ${bytes("receipts.effect_identity_version")}
        + ${bytes("receipts.effect_sha256")}
        + ${bytes("receipts.aggregate_id")}
        + ${bytes("receipts.committed_at")}
      )
      FROM command_receipts AS receipts
      WHERE ${decisionReceiptMatchSql("receipts.command_id")}
    ), 0)
  + COALESCE((
      SELECT SUM(
        ${READ_PAGE_ROW_OVERHEAD_BYTES}
        + ${bytes("scopes.project_id")}
      )
      FROM command_receipt_scopes AS scopes
      WHERE ${decisionReceiptMatchSql("scopes.receipt_command_id")}
    ), 0)
  + COALESCE((
      SELECT SUM(
        ${READ_PAGE_ROW_OVERHEAD_BYTES}
        + ${bytes("receipt_events.global_position")}
        + ${bytes("receipt_events.event_id")}
        + ${bytes("receipt_events.aggregate_id")}
        + ${bytes("receipt_events.record_version")}
        + ${bytes("receipt_events.payload_codec_version")}
        + ${bytes("receipt_events.request_sha256")}
        + ${bytes("receipt_events.event_type")}
        + ${bytes("receipt_events.payload")}
        + ${bytes("receipt_events.metadata")}
        + ${bytes("receipt_events.committed_at")}
      )
      FROM domain_events AS receipt_events
      WHERE ${decisionReceiptMatchSql("receipt_events.command_id")}
    ), 0)
  + COALESCE((
      SELECT SUM(
        ${READ_PAGE_ROW_OVERHEAD_BYTES}
        + ${bytes("receipt_messages.outbox_position")}
        + ${bytes("receipt_messages.message_id")}
        + ${bytes("receipt_messages.event_id")}
        + ${bytes("receipt_messages.topic")}
        + ${bytes("receipt_messages.payload")}
        + ${bytes("receipt_messages.headers")}
        + ${bytes("receipt_messages.created_at")}
      )
      FROM outbox_messages AS receipt_messages
      INNER JOIN domain_events AS receipt_events
        ON receipt_events.event_id = receipt_messages.event_id
      WHERE ${decisionReceiptMatchSql("receipt_events.command_id")}
    ), 0)
  + CASE
      WHEN decisions.audit_event_id IS NULL THEN 0
      ELSE COALESCE((
        SELECT
          ${READ_PAGE_ROW_OVERHEAD_BYTES}
          + ${bytes("audit_events.aggregate_id")}
          + ${bytes("audit_events.command_id")}
          + ${bytes("audit_events.event_type")}
          + ${bytes("audit_events.payload")}
          + ${bytes("audit_events.metadata")}
        FROM domain_events AS audit_events
        WHERE audit_events.event_id = decisions.audit_event_id
      ), 0)
    END
)` as const;
