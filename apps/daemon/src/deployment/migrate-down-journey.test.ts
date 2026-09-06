import { afterEach, describe, expect, it } from "vitest";
import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { MigrationDownError, MIGRATION_DOWN_NOT_LAST } from "../repository/migrations/migration-down-ports.js";
import { readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { MIGRATE_DOWN_UNCONFIGURED } from "./migrate-down-command.js";
import { AGENT, BATCH_ONE, BATCH_TWO, DECIDED_AT, ENVIRONMENT, SECOND_AT, SHA, refusalOf, world } from "./migrate-down-test-fixtures.js";
afterEach(closeStores);

describe("deployment.migrate_down reverts the last batch through the registered command", () => {
  it("takes the schema back to what it was before the last batch, leaving the first standing",
    async () => {
      const context = world();
      try {
        await context.applyBatch("batch-one", BATCH_ONE, DECIDED_AT);
        const afterFirst = context.schema();
        expect(afterFirst).toEqual(["first_table"]);
        await context.applyBatch("batch-two", BATCH_TWO, SECOND_AT);
        const afterSecond = context.schema();
        expect(afterSecond).toEqual(["first_table", "second_table", "third_table"]);

        await context.revert();

        // THE SUBJECT: the schema CHANGED BACK, compared against the reading taken before the
        // last batch was applied — not against a value this arm composed.
        expect(context.schema()).toEqual(afterFirst);
        expect(context.schema()).not.toEqual(afterSecond);
        // THE LAST BATCH, not all of them. A revert that unwound everything leaves [] here, and
        // that is a different and far more dangerous command than the one being published.
        expect(context.schema()).toContain("first_table");

        // THE RECEIPT RECORDS IT, read back from the real store, with the migrations NAMED.
        const receipt = readMigrationReceipt(context.store, PROJECT_ID, "cmd-migrate-down");
        expect(receipt).toMatchObject({
          applied: [...BATCH_TWO].reverse(), environment: ENVIRONMENT, outcome: "REVERTED",
          refusal: null, sha: SHA,
        });
        expect(receipt?.backupRef).toMatch(/\.sql@sha256:[a-f0-9]{64}$/u);
        // The surviving batch keeps its own APPLIED receipt: the revert recorded a second
        // decision beside it rather than rewriting history.
        expect(readMigrationReceipt(context.store, PROJECT_ID, "batch-one"))
          .toMatchObject({ applied: [...BATCH_ONE], outcome: "APPLIED" });
      } finally {
        context.close();
      }
    });

  it("refuses an AGENT principal at DAEMON_AUTHORIZATION, before it reads anything", async () => {
    const context = world();
    try {
      await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
      const before = context.schema();
      const refusal = await refusalOf(context.revert({ principalId: AGENT }));
      // THE CODE AND THE LAYER THAT REFUSED, not merely that it failed. The layer says the ASYNC
      // ENTRY's own fence answered: the registry's synchronous operator check never runs for this
      // kind, so a refusal from any other layer would mean a different guard caught it.
      expect(refusal.code).toBe("OPERATOR_PRINCIPAL_REQUIRED");
      expect(refusal.layer).toBe("DAEMON_AUTHORIZATION");
      expect(refusal.httpStatus).toBe(403);
      // Nothing moved and nothing was recorded: the fence is at ENTRY.
      expect(context.schema()).toEqual(before);
      expect(readMigrationReceipt(context.store, PROJECT_ID, "cmd-migrate-down")).toBeNull();
    } finally {
      context.close();
    }
  });

  it("refuses MIGRATE_DOWN_UNCONFIGURED at the command seam when no database is composed",
    async () => {
      const context = world();
      try {
        await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
        const before = context.schema();
        const refusal = await refusalOf(context.revert({ unconfigured: true }));
        expect(refusal.code).toBe(MIGRATE_DOWN_UNCONFIGURED);
        expect(refusal.layer).toBe("DAEMON_COMMAND_SEAM");
        // The detail names WHICH setting is missing and NEVER a value: a connection string is a
        // secret and a refusal is a log line (epic rail 3). The fixture URL carries a password
        // precisely so this assertion has something real to fail on.
        expect(refusal.detail).toBe("no database is configured on this daemon");
        expect(JSON.stringify(refusal)).not.toContain("hunter2");
        expect(context.schema()).toEqual(before);
      } finally {
        context.close();
      }
    });

  it("refuses MIGRATION_DOWN_BATCH_UNKNOWN when the named receipt is not an applied batch",
    async () => {
      const context = world();
      try {
        await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
        const before = context.schema();
        const refusal = await refusalOf(context.revert({
          payload: { environment: ENVIRONMENT, toMigrationRequestId: "never-applied" },
        }));
        expect(refusal.code).toBe("MIGRATION_DOWN_BATCH_UNKNOWN");
        expect(refusal.layer).toBe("DAEMON_INGRESS");
        expect(context.schema()).toEqual(before);
      } finally {
        context.close();
      }
    });

  it("refuses MIGRATION_DOWN_NOT_LAST_BATCH and leaves the schema exactly as it found it",
    async () => {
      // The PORT refuses, exactly as the production child does when `pgmigrations`' tail is not
      // the batch it was told to undo — and it refuses BEFORE reverting, which is why the schema
      // assertion below is the real subject rather than the code alone.
      const context = world({
        revert: (): Promise<readonly string[]> => {
          throw new MigrationDownError(MIGRATION_DOWN_NOT_LAST);
        },
      });
      try {
        await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
        const before = context.schema();
        expect(before).toEqual(["second_table", "third_table"]);
        const refusal = await refusalOf(context.revert());
        expect(refusal.code).toBe("MIGRATION_DOWN_NOT_LAST_BATCH");
        expect(refusal.layer).toBe("DAEMON_INGRESS");
        expect(context.schema()).toEqual(before);
        // The refusal is DURABLE and names the code, so an operator reading the receipt later
        // learns the schema was left alone rather than half-reverted.
        expect(readMigrationReceipt(context.store, PROJECT_ID, "cmd-migrate-down"))
          .toMatchObject({
            applied: [], outcome: "REFUSED",
            refusal: { code: "MIGRATION_DOWN_NOT_LAST_BATCH", layer: "DAEMON_INGRESS" },
          });
      } finally {
        context.close();
      }
    });

  it("would NOT pass if the revert moved nothing: a no-op port leaves the schema forward",
    async () => {
      /**
       * THE DISCRIMINATOR FOR THE ARM ABOVE, committed rather than drilled.
       *
       * "The command returned REVERTED" and "the schema changed back" are different claims, and
       * an arm that only checked the first would be green for a revert that did nothing. This
       * composes a port that reports the batch it was asked to undo WITHOUT touching the schema —
       * exactly the production defect DoD 5's wording exists to catch — and pins what the happy
       * path's own assertions would then see. It survives the commit, so a later reader can
       * re-run it instead of trusting a deleted mutant's transcript.
       */
      const context = world({
        revert: (batch): Promise<readonly string[]> => Promise.resolve([...batch].reverse()),
      });
      try {
        await context.applyBatch("batch-one", BATCH_ONE, DECIDED_AT);
        const afterFirst = context.schema();
        await context.applyBatch("batch-two", BATCH_TWO, SECOND_AT);
        const afterSecond = context.schema();
        await context.revert();

        // The command ANSWERS the same way it does on the real path...
        expect(readMigrationReceipt(context.store, PROJECT_ID, "cmd-migrate-down"))
          .toMatchObject({ applied: [...BATCH_TWO].reverse(), outcome: "REVERTED", refusal: null });
        // ...and the schema did NOT go back. Both halves of the happy-path arm's comparison flip:
        // its `toEqual(afterFirst)` and its `not.toEqual(afterSecond)` would each fail here, so
        // that arm cannot be green for a revert that moved nothing.
        expect(context.schema()).not.toEqual(afterFirst);
        expect(context.schema()).toEqual(afterSecond);
      } finally {
        context.close();
      }
    });

  it("replays the SAME receipt on a retry instead of unwinding a second batch", async () => {
    // THE ADVERSARIAL CASE THAT LOSES DATA: a retried revert that ran again would unwind the
    // batch BELOW the one it was asked for. Found by the adversarial pass, not by a rail.
    const context = world();
    try {
      await context.applyBatch("batch-one", BATCH_ONE, DECIDED_AT);
      const afterFirst = context.schema();
      await context.applyBatch("batch-two", BATCH_TWO, SECOND_AT);
      await context.revert();
      const receipt = readMigrationReceipt(context.store, PROJECT_ID, "cmd-migrate-down");
      expect(context.schema()).toEqual(afterFirst);

      // The SAME commandId again. The engine answers from the durable receipt and reverts nothing.
      await context.revert();
      expect(context.schema()).toEqual(afterFirst);
      expect(context.schema()).toContain("first_table");
      expect(readMigrationReceipt(context.store, PROJECT_ID, "cmd-migrate-down")).toEqual(receipt);
    } finally {
      context.close();
    }
  });

  it("fails closed on an empty environment rather than reverting against an unnamed one",
    async () => {
      // PAYLOAD_KEYS fences the KEY SET, never the values, so an empty environment is ADMITTED
      // and the engine is what must refuse it. Pinned because "admitted" reads like "accepted".
      const context = world();
      try {
        await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
        const before = context.schema();
        const refusal = await refusalOf(context.revert({
          payload: { environment: "", toMigrationRequestId: "batch-two" },
        }));
        expect(refusal.code).toBe("MIGRATE_DOWN_REQUEST_INVALID");
        expect(refusal.layer).toBe("DAEMON_COMMAND_SEAM");
        expect(context.schema()).toEqual(before);
      } finally {
        context.close();
      }
    });

  it("refuses a SECOND concurrent revert rather than racing it into a half-reverted schema",
    async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const context = world({ holdDump: held });
      // Declared OUTSIDE the try so the teardown can await it: see the `finally` below.
      let first: Promise<unknown> = Promise.resolve();
      try {
        await context.applyBatch("batch-two", BATCH_TWO, DECIDED_AT);
        // The first dispatch parks inside `dump`, holding the project-wide lock the forward path
        // takes. The second arrives while it is held.
        first = context.revert({ commandId: "cmd-first-revert" });
        const refusal = await refusalOf(context.revert({ commandId: "cmd-second-revert" }));
        expect(refusal.code).toBe("MIGRATE_DOWN_IN_PROGRESS");
        // A CONFLICT, not a malformed request: retrying after the holder finishes is correct.
        expect(refusal.layer).toBe("DAEMON_COMMAND_SEAM");
        expect(refusal.httpStatus).toBe(409);
        release();
        await first;
        // The FIRST one still completed: the lock serialised the pair, it did not lose one.
        expect(context.schema()).toEqual([]);
        expect(context.effects()).toEqual({ dumps: 1, reverts: 1 });
      } finally {
        // RELEASED AND AWAITED BEFORE THE TREE IS REMOVED, on the throwing path too: tearing the
        // root out from under an in-flight revert makes its lock cleanup fail and surface as an
        // unhandled rejection that would contaminate every later arm (epic rail 4).
        release();
        await first.catch(() => undefined);
        context.close();
      }
    });
});
