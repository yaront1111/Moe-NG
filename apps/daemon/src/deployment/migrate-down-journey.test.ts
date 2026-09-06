import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { closeStores, driveThrough, openStore, PROJECT_ID }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { AuthenticatedPrincipal } from "../http/http-contract.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import { MIGRATION_DOWN_NOT_LAST, MigrationDownError }
  from "../repository/migrations/migration-down-ports.js";
import type { MigrationDownPorts } from "../repository/migrations/migration-down-ports.js";
import { readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DeployTarget } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deploy-target-contracts.js";
import { DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND, MIGRATE_DOWN_UNCONFIGURED }
  from "./migrate-down-command.js";

/**
 * `deployment.migrate_down` END TO END THROUGH THE REGISTERED COMMAND (DoD 5).
 *
 * THE SCHEMA IS READ BEFORE AND AFTER AND COMPARED — never "the command returned a success
 * shape". A revert that answers REVERTED while the schema stands is exactly the failure DoD 5's
 * wording exists to catch, so the happy-path arm reads `schema()` on both sides and compares
 * against the reading taken BEFORE the batch was applied, not against a value it composed.
 *
 * OFFLINE, and the schema here is the STATE THE PORTS ACTUALLY MOVE: one `tables` set backs both
 * the forward `apply` and the reverse `revert`, so an arm cannot pass by moving a variable the
 * production path never touches. The REAL-PostgreSQL proof — a live `information_schema` read
 * across two batches — is `migrate-down-real.test.ts`, opt-in behind MOE_MIGRATION_RESTORE=1.
 * This file is what runs on every machine.
 *
 * NOTHING ON THE HAPPY PATH IS PLANTED. The prerequisite deploy is committed by the REAL
 * `deployment.deploy` command through its own async entry, and the source batch by the REAL
 * `migrateWithBackup`. The only doubles are the two host ports.
 *
 * TEARDOWN: every temp root is removed in a `finally` that also runs on the throwing path, and
 * store handles are released by `afterEach(closeStores)` (epic rail 4). No container, no port,
 * no child process is created by any arm here.
 */

afterEach(closeStores);

const OPERATOR = "principal-1";
const AGENT = "principal-agent";
const ENVIRONMENT = "staging";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DATABASE_URL = "postgres://app:hunter2@127.0.0.1:1/app";
const DECIDED_AT = "2026-09-06T00:00:00.000Z";
const SECOND_AT = "2026-09-06T00:30:00.000Z";
const REVERT_AT = "2026-09-06T01:00:00.000Z";
const BATCH_ONE = ["1700000000001_first.js"] as const;
const BATCH_TWO = ["1700000000002_second.js", "1700000000003_third.js"] as const;
const TABLES: Readonly<Record<string, string>> = Object.freeze({
  "1700000000001_first.js": "first_table",
  "1700000000002_second.js": "second_table",
  "1700000000003_third.js": "third_table",
});
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";

const principal = (principalId: string): AuthenticatedPrincipal =>
  ({ capabilities: ["goal.write"], principalId, projectId: PROJECT_ID });

/** The refusal a throwing dispatch produced, or a failure naming what came back instead — so an
 *  arm cannot pass by swallowing a success it was supposed to refuse. */
async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
}

interface World {
  readonly applyBatch: (requestId: string, batch: readonly string[], at: string) => Promise<void>;
  readonly close: () => void;
  readonly revert: (input?: {
    readonly commandId?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly principalId?: string;
    readonly unconfigured?: boolean;
  }) => Promise<unknown>;
  /** The tables that exist, sorted. READ from the state the ports actually mutate. */
  readonly schema: () => readonly string[];
  readonly store: SqliteEventStore;
}

interface WorldOptions {
  /** Replaces the revert half of the host ports; the dump half stays real enough to hash. */
  readonly revert?: (batch: readonly string[]) => Promise<readonly string[]>;
  /** Held open inside `dump`, so a second dispatch arrives while the lock is taken. */
  readonly holdDump?: Promise<void>;
}

function world(options: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), "moe-migrate-down-"));
  const store = openStore();
  const tables = new Set<string>();
  const schema = (): readonly string[] => [...tables].sort();
  const dump = async (_connection: string, path: string): Promise<void> => {
    writeFileSync(path, `-- ${schema().join(",")}\n`);
    if (options.holdDump !== undefined) await options.holdDump;
  };
  const ports: MigrationDownPorts = Object.freeze({
    dump,
    revert: async (
      _workspace: string, _connection: string, batch: readonly string[],
    ): Promise<readonly string[]> => {
      if (options.revert !== undefined) return options.revert(batch);
      for (const name of batch) tables.delete(TABLES[name] ?? name);
      return [...batch].reverse();
    },
  });
  const double = createDockerDouble({
    proxyConfig: PROXY_CONFIG, running: { app: "HEALTHY" },
    health: { [candidateContainerName(ENVIRONMENT, SHA, "cmd-deploy-first")]: ["HEALTHY"] },
  });
  const entries = createAsyncCommandEntries({
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    deploymentDeploy: {
      buildContext: "/workspace/product", clock: (): string => DECIDED_AT,
      healthBudgetMs: 10, pollMs: 1, sleep: (): Promise<void> => Promise.resolve(),
      ports: {
        docker: double.docker, releaseDecision: (): string | null => null, ssh: double.ssh,
        target: (): DeployTarget => LOCAL, transfer: double.transfer,
      },
    },
    migrateDown: {
      clock: (): string => REVERT_AT, databaseUrl: DATABASE_URL, ports,
      projectRoot: root, workspace: root,
    },
  });
  // The SAME store, composed with NO migrateDown seams: an unconfigured daemon, not a mocked one.
  const unconfigured = createAsyncCommandEntries({
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
  });
  const send = async (
    table: ReturnType<typeof createAsyncCommandEntries>, kind: keyof typeof table,
    commandId: string, payload: Readonly<Record<string, unknown>>, principalId: string,
  ): Promise<unknown> => {
    const handler = table[kind].asyncHandler;
    if (handler === undefined) throw new Error(`${String(kind)} carries no async handler`);
    const envelope: RuntimeCommandEnvelope = {
      commandId, commandKind: kind, correlationId: `corr-${commandId}`,
      // READ from the store, never pinned: a literal starts refusing CONFLICT as the fixture grows.
      expectedVersion: store.getAggregateVersion(PROJECT_ID),
      payload: payload as RuntimeCommandEnvelope["payload"],
      requestDigest: "d".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "migrate-down-journey-credential", targetAggregateId: PROJECT_ID,
    };
    return handler({ envelope, principal: principal(principalId) });
  };
  driveThrough(store, "goal.close");
  const deployed = send(entries, DEPLOYMENT_DEPLOY_COMMAND_KIND, "cmd-deploy-first",
    { environment: ENVIRONMENT, sha: SHA }, OPERATOR);
  return {
    schema, store,
    close: (): void => { rmSync(root, { recursive: true, force: true }); },
    applyBatch: async (requestId, batch, at): Promise<void> => {
      await deployed;
      const receipt = await migrateWithBackup(store, {
        databaseUrl: DATABASE_URL, environment: ENVIRONMENT, now: new Date(at),
        projectId: PROJECT_ID, projectRoot: root, requestId, sha: SHA, workspace: root,
      }, {
        dump: async (_connection: string, path: string): Promise<void> => {
          writeFileSync(path, `-- ${schema().join(",")}\n`);
        },
        apply: async (): Promise<readonly string[]> => {
          for (const name of batch) tables.add(TABLES[name] ?? name);
          return [...batch];
        },
      });
      expect(receipt, `batch ${requestId} did not apply`)
        .toMatchObject({ applied: [...batch], outcome: "APPLIED", refusal: null });
    },
    revert: async (input = {}): Promise<unknown> => {
      await deployed;
      return send(input.unconfigured === true ? unconfigured : entries,
        DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND, input.commandId ?? "cmd-migrate-down",
        input.payload ?? { environment: ENVIRONMENT, toMigrationRequestId: "batch-two" },
        input.principalId ?? OPERATOR);
    },
  };
}

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
            applied: [], backupRef: null, outcome: "REFUSED",
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
        expect(refusal.code).toBe("MIGRATION_RECEIPT_INVALID");
        expect(refusal.layer).toBe("DAEMON_INGRESS");
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
        expect(refusal.code).toBe("MIGRATION_IN_PROGRESS");
        // A CONFLICT, not a malformed request: retrying after the holder finishes is correct.
        expect(refusal.layer).toBe("DAEMON_INGRESS");
        expect(refusal.httpStatus).toBe(409);
        release();
        await first;
        // The FIRST one still completed: the lock serialised the pair, it did not lose one.
        expect(context.schema()).toEqual([]);
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
