import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  bytes,
  installFrozenV1Schema,
  proposedDecision,
} from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

describe("expected-version command decision ledger integrity", () => {
  it("rejects a durable event collision before any decision effect is written", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      store.commit({
        aggregateId: "collision-source",
        commandBytes: bytes("collision-seed"),
        commandId: "collision-seed-command",
        committedAt: "2026-08-06T18:10:00.000Z",
        events: [
          {
            eventId: "shared-event",
            eventType: "goal.seeded",
            payload: bytes("seed"),
          },
        ],
        expectedVersion: 0,
      });
      const key = {
        commandId: "collision-command",
        principalId: "principal-1",
        projectId: "project-1",
      };
      expect(() =>
        store.commitExpectedVersionDecision(
          proposedDecision({
            events: [
              {
                eventId: "shared-event",
                eventType: "goal.created",
                payload: bytes("must-roll-back"),
              },
            ],
            key,
            targetAggregateId: "collision-target",
          }),
        ),
      ).toThrowError(storeModule.DurableIdConflictError);
      expect(store.getCommandDecision(key)).toBeNull();
      expect(store.getAggregateVersion("collision-target")).toBe(0);
      expect(store.readEvents("collision-target")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back post-effect decision-insert failures on both factual branches", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-atomic-rollback-"));
    try {
      for (const branch of ["accepted", "stale"] as const) {
        const databasePath = join(directory, `${branch}.sqlite`);
        const store = storeModule.SqliteEventStore.openForProject(
          databasePath,
          "project-1",
        );
        const targetAggregateId = `${branch}-rollback-goal`;
        if (branch === "stale") {
          store.commit({
            aggregateId: targetAggregateId,
            commandBytes: bytes("seed"),
            commandId: "rollback-seed-command",
            committedAt: "2026-08-06T18:11:00.000Z",
            events: [
              {
                eventId: "rollback-seed-event",
                eventType: "goal.seeded",
                payload: bytes("seed"),
              },
            ],
            expectedVersion: 0,
          });
        }
        const injection = new DatabaseSync(databasePath);
        injection.exec(`
          CREATE TRIGGER fail_command_decision_insert
          BEFORE INSERT ON command_decisions
          BEGIN
            SELECT RAISE(ABORT, 'injected decision insert failure');
          END
        `);
        injection.close();

        const key = {
          commandId: `${branch}-rollback-command`,
          principalId: "principal-1",
          projectId: "project-1",
        };
        expect(() =>
          store.commitExpectedVersionDecision(
            proposedDecision({
              decidedAt: "2026-08-06T18:12:00.000Z",
              events: [
                {
                  eventId: `${branch}-rollback-event`,
                  eventType: "goal.changed",
                  outbox: [
                    {
                      messageId: `${branch}-rollback-message`,
                      payload: bytes("wire"),
                      topic: "goal.events",
                    },
                  ],
                  payload: bytes("must-roll-back"),
                },
              ],
              key,
              targetAggregateId,
            }),
          ),
        ).toThrowError(/STORE_UNAVAILABLE/u);
        expect(store.getCommandDecision(key)).toBeNull();
        expect(store.getAggregateVersion(targetAggregateId)).toBe(
          branch === "stale" ? 1 : 0,
        );
        expect(store.readEvents(targetAggregateId).map((event) => event.eventId)).toEqual(
          branch === "stale" ? ["rollback-seed-event"] : [],
        );
        expect(store.readPendingOutbox()).toEqual([]);
        expect(
          store
            .readEventsAfter(0n, 10)
            .items.filter((event) => event.eventType === "command.expected-version-rejected"),
        ).toEqual([]);

        const cleanup = new DatabaseSync(databasePath);
        cleanup.exec("DROP TRIGGER fail_command_decision_insert");
        cleanup.close();
        const retry = store.commitExpectedVersionDecision(
          proposedDecision({
            decidedAt: "2026-08-06T18:13:00.000Z",
            events: [
              {
                eventId: `${branch}-retry-event`,
                eventType: "goal.changed",
                payload: bytes("retry"),
              },
            ],
            key,
            targetAggregateId,
          }),
        );
        expect(retry.disposition).toBe("DECIDED");
        store.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("migrates only an independently frozen empty v1 schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-v1-empty-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const legacy = new DatabaseSync(databasePath);
      installFrozenV1Schema(legacy);
      legacy.close();

      const migrated = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "project-1",
      );
      try {
        expect(migrated.getHealth().userVersion).toBe(6);
        expect(migrated.readCommandDecisionsAfter(0n, 10).items).toEqual([]);
      } finally {
        migrated.close();
      }

      const verification = new DatabaseSync(databasePath);
      try {
        expect(verification.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 6,
        });
        expect(
          verification
            .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
            .get(),
        ).toEqual({ value: storeModule.SQLITE_SCHEMA_MANIFEST_VERSION });
        expect(
          verification
            .prepare("SELECT count(*) AS value FROM sqlite_schema WHERE name = 'command_decisions'")
            .get(),
        ).toEqual({ value: 1 });
      } finally {
        verification.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses a populated v1 schema without inventing scoped decisions or mutating it", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-v1-populated-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const legacy = new DatabaseSync(databasePath);
      installFrozenV1Schema(legacy);
      const digest = "0".repeat(64);
      legacy
        .prepare("INSERT INTO aggregate_heads (aggregate_id, version) VALUES (?, ?)")
        .run("legacy-goal", 1);
      legacy
        .prepare(`
          INSERT INTO command_receipts (
            command_id, request_identity_version, request_sha256, result_version,
            effect_identity_version, effect_sha256, aggregate_id, expected_version,
            previous_version, current_version, event_count, outbox_count, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "legacy-command",
          storeModule.COMMAND_REQUEST_IDENTITY_VERSION,
          digest,
          storeModule.RECEIPT_RESULT_VERSION,
          storeModule.COMMAND_EFFECT_IDENTITY_VERSION,
          digest,
          "legacy-goal",
          0,
          0,
          1,
          1,
          0,
          "2026-08-06T18:00:00.000Z",
        );
      legacy
        .prepare(`
          INSERT INTO domain_events (
            event_id, aggregate_id, aggregate_sequence, command_id,
            command_event_index, record_version, payload_codec_version,
            request_sha256, event_type, payload, metadata, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "legacy-event",
          "legacy-goal",
          1,
          "legacy-command",
          0,
          storeModule.EVENT_RECORD_VERSION,
          storeModule.OPAQUE_PAYLOAD_CODEC_VERSION,
          digest,
          "goal.created",
          bytes("legacy"),
          new Uint8Array(),
          "2026-08-06T18:00:00.000Z",
        );
      legacy.close();

      expect(() => {
        const wronglyMigrated = storeModule.SqliteEventStore.open(databasePath);
        wronglyMigrated.close();
      }).toThrowError(/STORE_MIGRATION_REQUIRED/u);

      const verification = new DatabaseSync(databasePath);
      try {
        expect(verification.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 1,
        });
        expect(
          verification
            .prepare("SELECT value FROM store_metadata WHERE key = 'schema_manifest_version'")
            .get(),
        ).toEqual({ value: "moe-sqlite-schema/1" });
        expect(
          verification.prepare("SELECT count(*) AS value FROM command_receipts").get(),
        ).toEqual({ value: 1 });
        expect(
          verification
            .prepare("SELECT count(*) AS value FROM sqlite_schema WHERE name = 'command_decisions'")
            .get(),
        ).toEqual({ value: 0 });
      } finally {
        verification.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists only a redacted stale result and normalized audit fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-redaction-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.commit({
        aggregateId: "private-goal",
        commandBytes: bytes("seed"),
        commandId: "private-seed",
        committedAt: "2026-08-06T18:20:00.000Z",
        events: [
          {
            eventId: "private-seed-event",
            eventType: "goal.seeded",
            payload: bytes("seed"),
          },
        ],
        expectedVersion: 0,
      });
      store.commitExpectedVersionDecision(
        proposedDecision({
          committedResultBytes: bytes("stack=PRIVATE_STACK SQL=PRIVATE_SQL"),
          correlationId: "PRIVATE_CORRELATION_TOKEN",
          decidedAt: "2026-08-06T18:21:00.000Z",
          key: {
            commandId: "private-command",
            principalId: "principal-1",
            projectId: "project-1",
          },
          requestBytes: bytes(
            "Authorization: Bearer PRIVATE_BEARER; lease=PRIVATE_LEASE; nextAllowedCommands=delete",
          ),
          targetAggregateId: "private-goal",
        }),
      );
      store.close();

      const inspection = new DatabaseSync(databasePath);
      try {
        const decision = inspection
          .prepare(`
            SELECT
              project_id, principal_id, command_id, command_kind, decision_id,
              request_sha256, target_aggregate_id, result_code,
              CAST(result_bytes AS TEXT) AS result_text, correlation_sha256
            FROM command_decisions
            WHERE command_id = 'private-command'
          `)
          .get();
        const audit = inspection
          .prepare(`
            SELECT CAST(payload AS TEXT) AS payload_text, CAST(metadata AS TEXT) AS metadata_text
            FROM domain_events
            WHERE event_type = 'command.expected-version-rejected'
          `)
          .get();
        const durableText = JSON.stringify({ audit, decision });
        for (const forbidden of [
          "PRIVATE_BEARER",
          "PRIVATE_LEASE",
          "PRIVATE_STACK",
          "PRIVATE_SQL",
          "PRIVATE_CORRELATION_TOKEN",
          "nextAllowedCommands",
          "Authorization",
        ]) {
          expect(durableText).not.toContain(forbidden);
        }
      } finally {
        inspection.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails startup when immutable decision fields or audit bytes are tampered", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-corruption-"));
    try {
      const corruptions = [
        {
          name: "result",
          mutate(database: DatabaseSync): void {
            database
              .prepare("UPDATE command_decisions SET result_bytes = ?")
              .run(bytes("forged-result"));
          },
        },
        {
          name: "scope",
          mutate(database: DatabaseSync): void {
            database.exec("UPDATE command_decisions SET project_id = 'transplanted-project'");
          },
        },
        {
          name: "effect-link",
          mutate(database: DatabaseSync): void {
            database.exec(`UPDATE command_decisions SET effect_sha256 = '${"1".repeat(64)}'`);
          },
        },
        {
          name: "position",
          mutate(database: DatabaseSync): void {
            database.exec("UPDATE command_decisions SET decision_position = 1000");
          },
        },
      ] as const;
      for (const corruption of corruptions) {
        const databasePath = join(directory, `${corruption.name}.sqlite`);
        const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
        store.commitExpectedVersionDecision(proposedDecision());
        store.close();

        const tamper = new DatabaseSync(databasePath);
        corruption.mutate(tamper);
        tamper.close();

        expect(() => {
          const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
          wronglyOpened.close();
        }).toThrowError(/STORE_CORRUPT/u);
      }

      const auditPath = join(directory, "audit.sqlite");
      const auditStore = storeModule.SqliteEventStore.openForProject(auditPath, "project-1");
      auditStore.commit({
        aggregateId: "audit-target",
        commandBytes: bytes("seed"),
        commandId: "audit-seed-command",
        committedAt: "2026-08-06T18:30:00.000Z",
        events: [
          {
            eventId: "audit-seed-event",
            eventType: "goal.seeded",
            payload: bytes("seed"),
          },
        ],
        expectedVersion: 0,
      });
      auditStore.commitExpectedVersionDecision(
        proposedDecision({
          decidedAt: "2026-08-06T18:31:00.000Z",
          key: {
            commandId: "audit-stale-command",
            principalId: "principal-1",
            projectId: "project-1",
          },
          targetAggregateId: "audit-target",
        }),
      );
      auditStore.close();
      const auditTamper = new DatabaseSync(auditPath);
      auditTamper
        .prepare(`
          UPDATE domain_events
          SET payload = ?
          WHERE event_type = 'command.expected-version-rejected'
        `)
        .run(bytes("forged-audit"));
      auditTamper.close();
      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(auditPath);
        wronglyOpened.close();
      }).toThrowError(/STORE_CORRUPT/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects deletion of a lifetime command-decision tombstone", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-deleted-tombstone-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      store.commitExpectedVersionDecision(proposedDecision());
      store.close();

      const tamper = new DatabaseSync(databasePath);
      tamper.exec("PRAGMA foreign_keys = OFF; DELETE FROM command_decisions;");
      tamper.close();

      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
        wronglyOpened.close();
      }).toThrowError(/STORE_CORRUPT/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reserves internal receipt, aggregate, event, and audit-type namespaces", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      store.commit({
        aggregateId: "reserved-target",
        commandBytes: bytes("seed"),
        commandId: "reserved-seed",
        committedAt: "2026-08-06T18:35:00.000Z",
        events: [
          {
            eventId: "reserved-seed-event",
            eventType: "goal.seeded",
            payload: bytes("seed"),
          },
        ],
        expectedVersion: 0,
      });
      const stale = store.commitExpectedVersionDecision(
        proposedDecision({
          decidedAt: "2026-08-06T18:36:00.000Z",
          key: {
            commandId: "reserved-stale-command",
            principalId: "principal-1",
            projectId: "project-1",
          },
          targetAggregateId: "reserved-target",
        }),
      );
      const auditEvent = store
        .readEventsAfter(0n, 10)
        .items.find((event) => event.eventId === stale.decision.auditEventId)!;

      expect(() =>
        store.commit({
          aggregateId: auditEvent.aggregateId,
          commandBytes: bytes("append-audit"),
          commandId: "append-audit-command",
          committedAt: "2026-08-06T18:37:00.000Z",
          events: [
            {
              eventId: "append-audit-event",
              eventType: "goal.changed",
              payload: bytes("append"),
            },
          ],
          expectedVersion: 1,
        }),
      ).toThrowError(/STORE_INPUT_INVALID/u);
      expect(() =>
        store.commit({
          aggregateId: "ordinary-target",
          commandBytes: bytes("reserved-event"),
          commandId: "ordinary-command",
          committedAt: "2026-08-06T18:38:00.000Z",
          events: [
            {
              eventId: "moe-internal:forged-event",
              eventType: "goal.changed",
              payload: bytes("forged"),
            },
          ],
          expectedVersion: 0,
        }),
      ).toThrowError(/STORE_INPUT_INVALID/u);
      expect(() =>
        store.commit({
          aggregateId: "ordinary-target",
          commandBytes: bytes("reserved-type"),
          commandId: "ordinary-command-2",
          committedAt: "2026-08-06T18:39:00.000Z",
          events: [
            {
              eventId: "ordinary-event",
              eventType: "command.expected-version-rejected",
              payload: bytes("forged"),
            },
          ],
          expectedVersion: 0,
        }),
      ).toThrowError(/STORE_INPUT_INVALID/u);
      expect(store.getAggregateVersion(auditEvent.aggregateId)).toBe(1);
    } finally {
      store.close();
    }
  });

});
