import { afterEach, describe, expect, it } from "vitest";
import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { migrationError, readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { BATCH_TWO, DECIDED_AT, ENVIRONMENT, OPERATOR, refusalOf, world } from "./migrate-down-test-fixtures.js";

afterEach(closeStores);
const key = { commandId: "cmd-migrate-down", principalId: OPERATOR, projectId: PROJECT_ID };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("migration down command authority and durable identity", () => {
  it.each([
    [{ principalProjectId: "foreign-project" }, "MIGRATE_DOWN_PROJECT_MISMATCH"],
    [{ targetAggregateId: "foreign-target" }, "MIGRATE_DOWN_TARGET_INVALID"],
    [{ commandKind: "deployment.rollback" }, "MIGRATE_DOWN_REQUEST_INVALID"],
  ] as const)("rejects foreign command authority before effects: %s", async (request, code) => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      const schema = context.schema();
      expect((await refusalOf(context.revert(request))).code).toBe(code);
      expect(context.schema()).toEqual(schema);
      expect(context.effects()).toEqual({ dumps: 0, reverts: 0 });
    } finally { context.close(); }
  });

  it("refuses a stale offered version before the database backup or revert", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      const stale = context.store.getAggregateVersion(PROJECT_ID) - 1;
      expect((await refusalOf(context.revert({ expectedVersion: stale }))).httpStatus).toBe(409);
      expect(context.effects()).toEqual({ dumps: 0, reverts: 0 });
    } finally { context.close(); }
  });

  it("records a durable intent and guards the offered project version before effects", async () => {
    let signal = (): void => undefined, release = (): void => undefined;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const context = world({ onDump: signal, holdDump: held });
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      const offered = context.store.getAggregateVersion(PROJECT_ID);
      pending = context.revert();
      await entered;
      const intent = context.store.getCommandDecision({ ...key, principalId: "daemon:migrate-down-command" });
      expect(intent?.effectDisposition).toBe("EFFECTS_COMMITTED");
      expect(intent?.currentVersion).toBe(1);
      expect(context.store.getAggregateVersion(PROJECT_ID)).toBe(offered);
      expect(readDurableLedger(context.store, PROJECT_ID).aggregates.get(PROJECT_ID)?.currentVersion).toBe(offered);
      expect(context.effects()).toEqual({ dumps: 1, reverts: 0 });
      expect((await refusalOf(context.revert())).code).toBe("MIGRATE_DOWN_IN_PROGRESS");
      expect((await refusalOf(context.revert({ commandId: "different-pending-command" }))).code)
        .toBe("MIGRATE_DOWN_IN_PROGRESS");
      expect(context.effects()).toEqual({ dumps: 1, reverts: 0 });
    } finally { release(); await pending.catch(() => undefined); context.close(); }
  });

  it("finishes despite an unrelated project writer between the terminal read and CAS", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      let raced = false;
      context.interceptCompletion(commit => {
        if (!raced) {
          raced = true;
          context.store.commitExpectedVersionDecision({ commandKind: "internal.fixture.concurrent",
            correlationId: "fixture", decidedAt: DECIDED_AT,
            key: { ...key, commandId: "concurrent-project-writer" }, targetAggregateId: PROJECT_ID,
            expectedVersion: context.store.getAggregateVersion(PROJECT_ID),
            committedResultBytes: bytes({ fixture: true }), requestBytes: bytes({ fixture: true }),
            events: [{ eventId: "concurrent-project-event", eventType: "FixtureProjectChanged", payload: bytes({}) }] });
        }
        return commit();
      });
      expect(await context.revert()).toMatchObject({ resultCode: "REVERTED" });
      expect(raced).toBe(true);
      expect(context.store.getCommandDecision(key)?.effectDisposition).toBe("EFFECTS_COMMITTED");
      expect(await context.revert()).toMatchObject({ disposition: "REPLAYED", resultCode: "REVERTED" });
      expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
    } finally { context.close(); }
  });

  it("recovers a receipt after interrupted finalization and still fences changed request bytes", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      context.interceptCompletion(() => { throw new Error("fixture interrupted completion"); });
      await expect(context.revert()).rejects.toThrow("fixture interrupted completion");
      context.interceptCompletion(null);
      expect(readMigrationReceipt(context.store, PROJECT_ID, key.commandId)?.outcome).toBe("REVERTED");
      expect(context.store.getCommandDecision(key)).toBeNull();
      expect((await refusalOf(context.revert({ payload: { environment: ENVIRONMENT,
        toMigrationRequestId: "another-batch" } }))).code).toBe("MIGRATE_DOWN_COMMAND_BYTES_CONFLICT");
      expect(await context.revert()).toMatchObject({ disposition: "REPLAYED", resultCode: "REVERTED" });
      expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
    } finally { context.close(); }
  });

  it("keeps an uncertain revert pending when the engine receipt cannot be written", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      context.interceptCommit((input, commit) => {
        if (input.commandKind === "internal.repository.migration_receipt") throw new Error("fixture interrupted receipt");
        return commit(input);
      });
      await expect(context.revert()).rejects.toThrow("fixture interrupted receipt");
      context.interceptCommit(null);
      expect(readMigrationReceipt(context.store, PROJECT_ID, key.commandId)).toBeNull();
      expect((await refusalOf(context.revert())).code).toBe("MIGRATE_DOWN_IN_PROGRESS");
      expect((await refusalOf(context.revert({ commandId: "different-uncertain-command" }))).code)
        .toBe("MIGRATE_DOWN_IN_PROGRESS");
      expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
    } finally { context.close(); }
  });

  it("holds the environment guard after a typed uncertain receipt-write refusal", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      context.interceptCommit((input, commit) => {
        if (input.commandKind === "internal.repository.migration_receipt") throw migrationError("MIGRATION_RECEIPT_WRITE_FAILED");
        return commit(input);
      });
      expect((await refusalOf(context.revert())).code).toBe("MIGRATION_RECEIPT_WRITE_FAILED");
      context.interceptCommit(null);
      expect((await refusalOf(context.revert())).code).toBe("MIGRATION_RECEIPT_WRITE_FAILED");
      expect((await refusalOf(context.revert({ commandId: "different-uncertain-command" }))).code)
        .toBe("MIGRATE_DOWN_IN_PROGRESS");
      expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
    } finally { context.close(); }
  });

  it("separates terminal events for different command IDs carrying the same offered bytes", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      const expectedVersion = context.store.getAggregateVersion(PROJECT_ID);
      for (const commandId of ["unknown-batch-one", "unknown-batch-two"]) {
        expect((await refusalOf(context.revert({ commandId, expectedVersion,
          payload: { environment: ENVIRONMENT, toMigrationRequestId: "absent" } }))).code)
          .toBe("MIGRATION_DOWN_BATCH_UNKNOWN");
        expect(context.store.getCommandDecision({ ...key, commandId })?.effectDisposition).toBe("EFFECTS_COMMITTED");
      }
      expect(context.effects()).toEqual({ dumps: 0, reverts: 0 });
    } finally { context.close(); }
  });

  it("answers the winning durable terminal when another completion wins the journal race", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      let raced = false;
      context.interceptCompletion(commit => {
        if (!raced) {
          raced = true;
          commit(bytes({ outcome: "REFUSED",
            code: "MIGRATION_RECEIPT_WRITE_FAILED", layer: "DAEMON_INGRESS",
            detail: "MIGRATION_RECEIPT_WRITE_FAILED", httpStatus: 422 }));
        }
        return commit();
      });
      expect((await refusalOf(context.revert())).code).toBe("MIGRATION_RECEIPT_WRITE_FAILED");
      expect((await refusalOf(context.revert())).code).toBe("MIGRATION_RECEIPT_WRITE_FAILED");
      expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
    } finally { context.close(); }
  });

  it("replays a failed revert as the same refusal without a second effect", async () => {
    const context = world({ revert: async () => { throw new Error("fixture revert refused"); } });
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      const first = await refusalOf(context.revert());
      const replayed = await refusalOf(context.revert());
      expect(replayed.code).toBe(first.code);
      expect(replayed.layer).toBe(first.layer);
      expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
    } finally { context.close(); }
  });

  it("keeps the successful backup reference when the database revert fails", async () => {
    const context = world({ revert: async () => { throw new Error("fixture revert refused"); } });
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      expect((await refusalOf(context.revert())).code).toBe("MIGRATION_DOWN_FAILED");
      const receipt = readMigrationReceipt(context.store, PROJECT_ID, "cmd-migrate-down");
      expect(receipt?.outcome).toBe("REFUSED");
      expect(receipt?.backupRef === null).toBe(false);
      expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
    } finally { context.close(); }
  });
});
