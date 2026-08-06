import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import * as storeModule from "./index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function text(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function proposedDecision(
  overrides: Partial<storeModule.CommitExpectedVersionDecisionInput> = {},
): storeModule.CommitExpectedVersionDecisionInput {
  return {
    commandKind: "goal.create",
    committedResultBytes: bytes('{"goalId":"goal-1"}'),
    correlationId: "correlation-1",
    decidedAt: "2026-08-06T18:00:00.000Z",
    events: [
      {
        eventId: "event-1",
        eventType: "goal.created",
        outbox: [
          {
            messageId: "message-1",
            payload: bytes("wire-1"),
            topic: "goal.events",
          },
        ],
        payload: bytes("payload-1"),
      },
    ],
    expectedVersion: 0,
    key: {
      commandId: "command-1",
      principalId: "principal-1",
      projectId: "project-1",
    },
    requestBytes: bytes("goal.create/v1"),
    targetAggregateId: "goal-1",
    ...overrides,
  };
}

// Frozen independently from the active v2 manifest so migration tests cannot
// accidentally manufacture a v1 fixture by downgrading current schema bytes.
export function installFrozenV1Schema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE aggregate_heads (
      aggregate_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0 AND version <= 9007199254740991)
    ) STRICT;
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
    ) STRICT;
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
    ) STRICT;
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
    ) STRICT;
    CREATE TABLE store_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;
    CREATE INDEX outbox_pending_order
      ON outbox_messages(delivered_at, outbox_position);
    CREATE INDEX outbox_event_order
      ON outbox_messages(event_id, event_outbox_index);
    INSERT INTO store_metadata (key, value)
      VALUES ('schema_manifest_version', 'moe-sqlite-schema/1');
    PRAGMA application_id = ${storeModule.SQLITE_APPLICATION_ID};
    PRAGMA user_version = 1;
  `);
}

export interface DecisionRaceResult {
  readonly businessEventIds?: readonly string[];
  readonly code?: string;
  readonly decisionId?: string;
  readonly decisionSha256?: string;
  readonly disposition?: string;
  readonly effectDisposition?: string;
  readonly effectSha256?: string;
  readonly resultCode?: string;
  readonly resultSha256?: string;
}

export interface DecisionRaceOptions {
  readonly commandId: string;
  readonly principalId?: string;
  readonly projectId?: string;
  readonly requestBytes: string;
  readonly suffix: string;
  readonly targetAggregateId?: string;
}

export function startDecisionRaceWorker(
  databasePath: string,
  gate: SharedArrayBuffer,
  options: DecisionRaceOptions,
): {
  readonly preOpenReady: Promise<void>;
  readonly ready: Promise<void>;
  readonly result: Promise<DecisionRaceResult>;
} {
  const worker = new Worker(new URL("./command-decision-race-worker.mjs", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
    workerData: {
      commandId: options.commandId,
      databasePath,
      decidedAt: "2026-08-06T18:40:00.000Z",
      gate,
      principalId: options.principalId ?? "race-principal",
      projectId: options.projectId ?? "race-project",
      requestBytes: options.requestBytes,
      suffix: options.suffix,
      targetAggregateId: options.targetAggregateId ?? "race-goal",
    },
  });
  let resolvePreOpenReady!: () => void;
  let resolveReady!: () => void;
  let resolveResult!: (value: DecisionRaceResult) => void;
  let rejectAll!: (error: Error) => void;
  const preOpenReady = new Promise<void>((resolve, reject) => {
    resolvePreOpenReady = resolve;
    rejectAll = reject;
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    const previousReject = rejectAll;
    rejectAll = (error) => {
      previousReject(error);
      reject(error);
    };
  });
  const result = new Promise<DecisionRaceResult>((resolve, reject) => {
    resolveResult = resolve;
    const previousReject = rejectAll;
    rejectAll = (error) => {
      previousReject(error);
      reject(error);
    };
  });
  worker.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && "kind" in message) {
      if (message.kind === "PREOPEN_READY") {
        resolvePreOpenReady();
      } else if (message.kind === "READY") {
        resolveReady();
      } else if (message.kind === "RESULT") {
        resolveResult(message as DecisionRaceResult);
      }
    }
  });
  worker.on("error", (error) => rejectAll(error));
  worker.on("exit", (code) => {
    if (code !== 0) {
      rejectAll(new Error(`command decision race worker exited with ${code}`));
    }
  });
  return { preOpenReady, ready, result };
}

export async function releaseDecisionRace(
  gate: SharedArrayBuffer,
  workers: readonly ReturnType<typeof startDecisionRaceWorker>[],
): Promise<readonly DecisionRaceResult[]> {
  await Promise.all(workers.map((worker) => worker.preOpenReady));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, workers.length);
  await Promise.all(workers.map((worker) => worker.ready));
  Atomics.store(new Int32Array(gate), 1, 1);
  Atomics.notify(new Int32Array(gate), 1, workers.length);
  return Promise.all(workers.map((worker) => worker.result));
}
