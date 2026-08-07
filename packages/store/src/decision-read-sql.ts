import { DECISION_DECODED_BYTES_SQL } from "./read-page-queries.js";

export const STORED_COMMAND_DECISION_SELECT_COLUMNS = `CAST(decision_position AS TEXT) AS decision_position,
          project_id,
          principal_id,
          command_id,
          command_kind,
          decision_id,
          record_version,
          coverage,
          request_identity_version,
          request_sha256,
          target_aggregate_id,
          expected_version,
          observed_version,
          effect_disposition,
          result_code,
          result_version,
          result_bytes,
          result_sha256,
          decided_at,
          correlation_sha256,
          receipt_command_id,
          audit_event_id,
          previous_version,
          current_version,
          business_event_count,
          outbox_count,
          effect_identity_version,
          effect_sha256,
          decision_identity_version,
          decision_sha256` as const;

export const COMMAND_DECISION_BY_KEY_QUERY = `
        SELECT
          ${STORED_COMMAND_DECISION_SELECT_COLUMNS}
        FROM command_decisions
        WHERE project_id = ? AND principal_id = ? AND command_id = ?
      ` as const;

export const COMMAND_DECISION_BY_POSITION_QUERY = `
        SELECT
          ${STORED_COMMAND_DECISION_SELECT_COLUMNS}
        FROM command_decisions
        WHERE decision_position = ?
      ` as const;

export const COMMAND_DECISION_CANDIDATE_PAGE_QUERY = `
          SELECT
            CAST(decisions.decision_position AS TEXT) AS decision_position,
            CAST(${DECISION_DECODED_BYTES_SQL} AS TEXT) AS decoded_bytes
          FROM command_decisions AS decisions
          WHERE decisions.decision_position > ?
          ORDER BY decisions.decision_position
          LIMIT ?
        ` as const;

export const REJECTION_AUDIT_EVENT_QUERY = `
          SELECT aggregate_id, command_id, event_type, payload, metadata
          FROM domain_events
          WHERE event_id = ?
        ` as const;

export const COMMAND_DECISION_POSITION_SCAN_QUERY =
  "SELECT CAST(decision_position AS TEXT) AS decision_position FROM command_decisions ORDER BY decision_position" as const;

export const RESERVED_DECISION_NAMESPACE_QUERY = `
        SELECT count(*) AS violations
        FROM (
          SELECT receipts.command_id AS durable_id
          FROM command_receipts AS receipts
          LEFT JOIN command_decisions AS decisions
            ON decisions.receipt_command_id = receipts.command_id
          WHERE receipts.command_id GLOB 'moe-internal:*'
            AND (
              receipts.command_id NOT GLOB 'moe-internal:decision-effect:*'
              OR decisions.decision_position IS NULL
            )

          UNION ALL

          SELECT events.event_id AS durable_id
          FROM domain_events AS events
          LEFT JOIN command_decisions AS decisions
            ON decisions.receipt_command_id = events.command_id
          WHERE (
              events.command_id GLOB 'moe-internal:*'
              OR events.aggregate_id GLOB 'moe-internal:*'
              OR events.event_id GLOB 'moe-internal:*'
            )
            AND decisions.decision_position IS NULL

          UNION ALL

          SELECT heads.aggregate_id AS durable_id
          FROM aggregate_heads AS heads
          WHERE heads.aggregate_id GLOB 'moe-internal:*'
            AND NOT EXISTS (
              SELECT 1
              FROM command_receipts AS receipts
              INNER JOIN command_decisions AS decisions
                ON decisions.receipt_command_id = receipts.command_id
              WHERE receipts.aggregate_id = heads.aggregate_id
            )
        )
      ` as const;
