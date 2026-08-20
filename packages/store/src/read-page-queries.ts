import { READ_PAGE_ROW_OVERHEAD_BYTES } from "./read-page-budget.js";
import { LEG_RECEIPT_SEPARATOR } from "./store-internals.js";

const bytes = (column: string): string =>
  `COALESCE(length(CAST(${column} AS BLOB)), 0)`;

/**
 * Matches `command_decisions.receipt_command_id` against a receipt or event
 * command ID that may be a multi-leg decision's leg receipt. Leg receipts append
 * `:leg:<index>` to the canonical ID, so truncating at the separator recovers the
 * canonical ID and keeps this an EQUALITY probe on a unique column rather than a
 * scan. A single-aggregate ID never contains the separator, so the second
 * disjunct is dead for every pre-leg row and cannot change its plan.
 */
export const decisionReceiptMatchSql = (commandIdColumn: string): string => `(
      decisions.receipt_command_id = ${commandIdColumn}
      OR (
        instr(${commandIdColumn}, '${LEG_RECEIPT_SEPARATOR}') > 0
        AND decisions.receipt_command_id = substr(
          ${commandIdColumn},
          1,
          instr(${commandIdColumn}, '${LEG_RECEIPT_SEPARATOR}') - 1
        )
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
    ON ${decisionReceiptMatchSql("events.command_id")}
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
        + ${bytes("receipts.command_id")}
        + ${bytes("receipts.request_identity_version")}
        + ${bytes("receipts.request_sha256")}
        + ${bytes("receipts.result_version")}
        + ${bytes("receipts.effect_identity_version")}
        + ${bytes("receipts.effect_sha256")}
        + ${bytes("receipts.aggregate_id")}
        + ${bytes("receipts.committed_at")}
      FROM command_receipts AS receipts
      WHERE receipts.command_id = decisions.receipt_command_id
    ), 0)
  + COALESCE((
      SELECT
        ${READ_PAGE_ROW_OVERHEAD_BYTES}
        + ${bytes("scopes.project_id")}
      FROM command_receipt_scopes AS scopes
      WHERE scopes.receipt_command_id = decisions.receipt_command_id
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
      WHERE receipt_events.command_id = decisions.receipt_command_id
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
      WHERE receipt_events.command_id = decisions.receipt_command_id
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
