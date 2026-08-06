import { MAX_BLOB_BYTES } from "./store-contracts.js";

export const SCHEMA_V1_OBJECT_SQL = Object.freeze({
  aggregate_heads: `
    CREATE TABLE aggregate_heads (
      aggregate_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0 AND version <= 9007199254740991)
    ) STRICT
  `,
  command_receipts: `
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY NOT NULL,
      request_identity_version TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      result_version TEXT NOT NULL,
      effect_identity_version TEXT NOT NULL,
      effect_sha256 TEXT NOT NULL CHECK (
        length(effect_sha256) = 64 AND effect_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      aggregate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
      previous_version INTEGER NOT NULL CHECK (previous_version >= 0),
      current_version INTEGER NOT NULL CHECK (current_version > previous_version),
      event_count INTEGER NOT NULL CHECK (event_count > 0),
      outbox_count INTEGER NOT NULL CHECK (outbox_count >= 0),
      committed_at TEXT NOT NULL,
      CHECK (expected_version = previous_version),
      CHECK (current_version = previous_version + event_count)
    ) STRICT
  `,
  domain_events: `
    CREATE TABLE domain_events (
      global_position INTEGER PRIMARY KEY AUTOINCREMENT CHECK (global_position > 0),
      event_id TEXT NOT NULL UNIQUE,
      aggregate_id TEXT NOT NULL,
      aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence > 0),
      command_id TEXT NOT NULL,
      command_event_index INTEGER NOT NULL CHECK (command_event_index >= 0),
      record_version TEXT NOT NULL,
      payload_codec_version TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      event_type TEXT NOT NULL,
      payload BLOB NOT NULL,
      metadata BLOB NOT NULL,
      committed_at TEXT NOT NULL,
      UNIQUE (aggregate_id, aggregate_sequence),
      UNIQUE (command_id, command_event_index),
      FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE RESTRICT
    ) STRICT
  `,
  outbox_messages: `
    CREATE TABLE outbox_messages (
      outbox_position INTEGER PRIMARY KEY AUTOINCREMENT CHECK (outbox_position > 0),
      message_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL,
      event_outbox_index INTEGER NOT NULL CHECK (event_outbox_index >= 0),
      topic TEXT NOT NULL,
      payload BLOB NOT NULL,
      headers BLOB NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      UNIQUE (event_id, event_outbox_index),
      FOREIGN KEY (event_id) REFERENCES domain_events(event_id) ON DELETE RESTRICT
    ) STRICT
  `,
  store_metadata: `
    CREATE TABLE store_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT
  `,
  outbox_pending_order: `
    CREATE INDEX outbox_pending_order
      ON outbox_messages(delivered_at, outbox_position)
  `,
  outbox_event_order: `
    CREATE INDEX outbox_event_order
      ON outbox_messages(event_id, event_outbox_index)
  `,
});

export const SCHEMA_OBJECT_SQL = Object.freeze({
  ...SCHEMA_V1_OBJECT_SQL,
  command_decisions: `
    CREATE TABLE command_decisions (
      decision_position INTEGER PRIMARY KEY AUTOINCREMENT CHECK (decision_position > 0),
      project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      decision_id TEXT NOT NULL UNIQUE CHECK (
        length(decision_id) = 64 AND decision_id NOT GLOB '*[^0-9a-f]*'
      ),
      record_version TEXT NOT NULL,
      coverage TEXT NOT NULL,
      request_identity_version TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      target_aggregate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
      observed_version INTEGER NOT NULL CHECK (observed_version >= 0),
      effect_disposition TEXT NOT NULL CHECK (
        effect_disposition IN ('EFFECTS_COMMITTED', 'NO_BUSINESS_EFFECT')
      ),
      result_code TEXT NOT NULL,
      result_version TEXT NOT NULL,
      result_bytes BLOB NOT NULL CHECK (length(result_bytes) <= ${MAX_BLOB_BYTES}),
      result_sha256 TEXT NOT NULL CHECK (
        length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      decided_at TEXT NOT NULL,
      correlation_sha256 TEXT NOT NULL CHECK (
        length(correlation_sha256) = 64 AND correlation_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      receipt_command_id TEXT NOT NULL UNIQUE,
      audit_event_id TEXT UNIQUE,
      previous_version INTEGER CHECK (previous_version IS NULL OR previous_version >= 0),
      current_version INTEGER CHECK (current_version IS NULL OR current_version > 0),
      business_event_count INTEGER NOT NULL CHECK (business_event_count >= 0),
      outbox_count INTEGER NOT NULL CHECK (outbox_count >= 0),
      effect_identity_version TEXT NOT NULL,
      effect_sha256 TEXT NOT NULL CHECK (
        length(effect_sha256) = 64 AND effect_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      decision_identity_version TEXT NOT NULL,
      decision_sha256 TEXT NOT NULL CHECK (
        length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      UNIQUE (project_id, principal_id, command_id),
      FOREIGN KEY (receipt_command_id)
        REFERENCES command_receipts(command_id) ON DELETE RESTRICT,
      FOREIGN KEY (audit_event_id)
        REFERENCES domain_events(event_id) ON DELETE RESTRICT,
      CHECK (
        (
          effect_disposition = 'EFFECTS_COMMITTED'
          AND result_code = 'EFFECTS_COMMITTED'
          AND observed_version = expected_version
          AND audit_event_id IS NULL
          AND previous_version = expected_version
          AND current_version = previous_version + business_event_count
          AND business_event_count > 0
        )
        OR
        (
          effect_disposition = 'NO_BUSINESS_EFFECT'
          AND result_code = 'EXPECTED_VERSION_CONFLICT'
          AND observed_version <> expected_version
          AND audit_event_id IS NOT NULL
          AND previous_version IS NULL
          AND current_version IS NULL
          AND business_event_count = 0
          AND outbox_count = 0
        )
      )
    ) STRICT
  `,
  store_project_binding: `
    CREATE TABLE store_project_binding (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      project_id TEXT NOT NULL UNIQUE
    ) STRICT
  `,
  command_receipt_scopes: `
    CREATE TABLE command_receipt_scopes (
      receipt_command_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      FOREIGN KEY (receipt_command_id)
        REFERENCES command_receipts(command_id) ON DELETE RESTRICT
    ) STRICT
  `,
});
