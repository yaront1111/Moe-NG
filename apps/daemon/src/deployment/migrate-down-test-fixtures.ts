import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { expect } from "vitest";

import { driveThrough, openStore, PROJECT_ID }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { AuthenticatedPrincipal } from "../http/http-contract.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import type { MigrationDownPorts } from "../repository/migrations/migration-down-ports.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DeployTarget } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deploy-target-contracts.js";
import { DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND }
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



export const OPERATOR = "principal-1";
export const AGENT = "principal-agent";
export const ENVIRONMENT = "staging";
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const DATABASE_URL = "postgres://app:hunter2@127.0.0.1:1/app";
export const DECIDED_AT = "2026-09-06T00:00:00.000Z";
export const SECOND_AT = "2026-09-06T00:30:00.000Z";
export const REVERT_AT = "2026-09-06T01:00:00.000Z";
export const BATCH_ONE = ["1700000000001_first.js"] as const;
export const BATCH_TWO = ["1700000000002_second.js", "1700000000003_third.js"] as const;
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
export async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
}

type Commit = SqliteEventStore["commitExpectedVersionDecision"];
type CommitHook = (input: Parameters<Commit>[0], commit: Commit) => ReturnType<Commit>;
type CompletionHook = (commit: (resultBytes?: Uint8Array) => ReturnType<Commit>) => ReturnType<Commit>;
interface World {
  readonly interceptCommit: (hook: CommitHook | null) => void;
  readonly interceptCompletion: (hook: CompletionHook | null) => void;
  readonly applyBatch: (requestId: string, batch: readonly string[], at: string) => Promise<void>;
  readonly close: () => void;
  readonly revert: (input?: {
    readonly commandId?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly principalId?: string;
    readonly unconfigured?: boolean;
    readonly expectedVersion?: number;
    readonly principalProjectId?: string;
    readonly targetAggregateId?: string;
    readonly commandKind?: RuntimeCommandEnvelope["commandKind"];
  }) => Promise<unknown>;
  /** The tables that exist, sorted. READ from the state the ports actually mutate. */
  readonly schema: () => readonly string[];
  readonly store: SqliteEventStore;
  readonly effects: () => { readonly dumps: number; readonly reverts: number };
}

interface WorldOptions {
  /** Replaces the revert half of the host ports; the dump half stays real enough to hash. */
  readonly revert?: (batch: readonly string[]) => Promise<readonly string[]>;
  /** Held open inside `dump`, so a second dispatch arrives while the lock is taken. */
  readonly holdDump?: Promise<void>;
  readonly onDump?: () => void;
}

export function world(options: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), "moe-migrate-down-"));
  const durableStore = openStore();
  let commitHook: CommitHook | null = null;
  let completionHook: CompletionHook | null = null;
  const commit = durableStore.commitExpectedVersionDecision.bind(durableStore);
  const store = new Proxy(durableStore, { get(target, property) {
    if (property === "commitExpectedVersionDecision") {
      return (input: Parameters<Commit>[0]) => {
        if (input.commandKind === "deployment.migrate_down" && completionHook !== null) {
          return completionHook(resultBytes => commit({ ...input,
            committedResultBytes: resultBytes ?? input.committedResultBytes }));
        }
        return commitHook === null ? commit(input) : commitHook(input, commit);
      };
    }
    if (property === "commitExpectedVersionDecisionLegs") {
      return (input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0]) => {
        const apply = (resultBytes?: Uint8Array) => target.commitExpectedVersionDecisionLegs({ ...input,
          committedResultBytes: resultBytes ?? input.committedResultBytes });
        return input.commandKind === "deployment.migrate_down" && completionHook !== null
          ? completionHook(apply) : apply();
      };
    }
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const tables = new Set<string>();
  const versions = new Map<string, number>();
  let dumps = 0, reverts = 0;
  const schema = (): readonly string[] => [...tables].sort();
  const dump = async (_connection: string, path: string): Promise<void> => {
    dumps += 1;
    writeFileSync(path, `-- ${schema().join(",")}\n`);
    options.onDump?.();
    if (options.holdDump !== undefined) await options.holdDump;
  };
  const ports: MigrationDownPorts = Object.freeze({
    dump,
    revert: async (
      _workspace: string, _connection: string, batch: readonly string[],
    ): Promise<readonly string[]> => {
      reverts += 1;
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
        build: double.build, docker: double.docker, releaseDecision: (): string | null => null, ssh: double.ssh,
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
    overrides: NonNullable<Parameters<World["revert"]>[0]> = {},
  ): Promise<unknown> => {
    const handler = table[kind].asyncHandler;
    if (handler === undefined) throw new Error(`${String(kind)} carries no async handler`);
    if (!versions.has(commandId)) versions.set(commandId, store.getAggregateVersion(PROJECT_ID));
    const envelope: RuntimeCommandEnvelope = {
      commandId, commandKind: overrides.commandKind ?? kind, correlationId: `corr-${commandId}`,
      // READ from the store, never pinned: a literal starts refusing CONFLICT as the fixture grows.
      expectedVersion: overrides.expectedVersion ?? versions.get(commandId)!,
      payload: payload as RuntimeCommandEnvelope["payload"],
      requestDigest: "d".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "migrate-down-journey-credential", targetAggregateId: PROJECT_ID,
    };
    return handler({ envelope: { ...envelope,
      targetAggregateId: overrides.targetAggregateId ?? envelope.targetAggregateId },
      principal: { ...principal(principalId), projectId: overrides.principalProjectId ?? PROJECT_ID } });
  };
  driveThrough(store, "goal.close");
  const deployed = send(entries, DEPLOYMENT_DEPLOY_COMMAND_KIND, "cmd-deploy-first",
    { environment: ENVIRONMENT, sha: SHA }, OPERATOR);
  return {
    schema, store, effects: () => ({ dumps, reverts }),
    interceptCommit: hook => { commitHook = hook; },
    interceptCompletion: hook => { completionHook = hook; },
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
        input.principalId ?? OPERATOR, input);
    },
  };
}
