import { MAX_DECISION_LEGS } from "./decision-legs-contracts.js";
import { DECISION_LEG_ROSTER_VERSION } from "./decision-leg-roster.js";

const SAFE_INTEGER_MAX = 9_007_199_254_740_991;

export const SCHEMA_V7_DECISION_LEG_OBJECT_SQL = Object.freeze({
  command_decision_leg_rosters: `
    CREATE TABLE command_decision_leg_rosters (
      decision_id TEXT PRIMARY KEY NOT NULL,
      roster_version TEXT NOT NULL CHECK (roster_version = '${DECISION_LEG_ROSTER_VERSION}'),
      leg_count INTEGER NOT NULL CHECK (leg_count BETWEEN 1 AND ${MAX_DECISION_LEGS}),
      roster_sha256 TEXT NOT NULL CHECK (
        length(roster_sha256) = 64 AND roster_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      FOREIGN KEY (decision_id)
        REFERENCES command_decisions(decision_id) ON DELETE RESTRICT
    ) STRICT
  `,
  command_decision_legs: `
    CREATE TABLE command_decision_legs (
      decision_id TEXT NOT NULL,
      leg_index INTEGER NOT NULL CHECK (leg_index BETWEEN 0 AND ${MAX_DECISION_LEGS - 1}),
      aggregate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (
        expected_version BETWEEN 0 AND ${SAFE_INTEGER_MAX}
      ),
      receipt_command_id TEXT,
      receipt_request_sha256 TEXT CHECK (
        receipt_request_sha256 IS NULL OR (
          length(receipt_request_sha256) = 64
          AND receipt_request_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      receipt_effect_sha256 TEXT CHECK (
        receipt_effect_sha256 IS NULL OR (
          length(receipt_effect_sha256) = 64
          AND receipt_effect_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      PRIMARY KEY (decision_id, leg_index),
      UNIQUE (decision_id, aggregate_id),
      UNIQUE (receipt_command_id),
      FOREIGN KEY (decision_id)
        REFERENCES command_decision_leg_rosters(decision_id) ON DELETE RESTRICT,
      FOREIGN KEY (receipt_command_id)
        REFERENCES command_receipts(command_id) ON DELETE RESTRICT,
      CHECK (
        (
          receipt_command_id IS NULL
          AND receipt_request_sha256 IS NULL
          AND receipt_effect_sha256 IS NULL
        ) OR (
          receipt_command_id IS NOT NULL
          AND receipt_request_sha256 IS NOT NULL
          AND receipt_effect_sha256 IS NOT NULL
        )
      )
    ) STRICT
  `,
});
