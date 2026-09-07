import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { afterEach, expect, it, vi } from "vitest";

import { closeStores, driveThrough, openStore, PROJECT_ID }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import type { MigrationDownPorts } from "../repository/migrations/migration-down-ports.js";
import { readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DeployTarget } from "./deploy-ports.js";
import { candidateContainerName } from "./deploy-service.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deploy-target-contracts.js";
import { DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND, MIGRATE_DOWN_UNCONFIGURED }
  from "./migrate-down-command.js";
import type { MigrateDownHostContext } from "./migrate-down-command.js";

const OPERATOR = "principal-1";
const ENVIRONMENT = "staging";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-06T00:00:00.000Z";
const REVERT_AT = "2026-09-06T01:00:00.000Z";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";

/* ══════════════════ OFFLINE: PER-ENVIRONMENT HOST AUTHORITY (DoD 1, 2, 3, 5) ══════════════════
 *
 * Everything below runs on EVERY machine -- no Docker, no live database, no container, no child
 * process -- and it is dispatched through `createDaemonCommandPorts`, the daemon's REAL
 * composition root: the function that builds the registry the HTTP seam looks commands up in.
 * That choice is load-bearing. The production defect this row closes was not only that the three
 * host values were daemon-wide statics; it was that `daemon-command-registry.ts` NEVER FORWARDED
 * `migrateDown` AT ALL, so production `deployment.migrate_down` always refused UNCONFIGURED. An
 * arm that stopped at `createAsyncCommandEntries` would prove the seam and miss the wiring, and
 * DoD 1 excludes exactly that: "actual dispatch through default composition, not an isolated
 * entry constructed with hardcoded databaseUrl".
 *
 * THE SCHEMA IS KEYED BY THE CONNECTION THE PORTS WERE HANDED, not by environment name. So an
 * arm cannot pass by moving a variable the production path never touched, and a daemon that
 * reused one database for both environments would visibly revert the WRONG one.
 */

const ENV_B = "production";
const PASSWORD = "pgpassword-never-surfaces";
const BATCH_A = "1700000000011_a_only.js";
const BATCH_B = "1700000000012_b_only.js";
const TABLE_OF: Readonly<Record<string, string>> =
  Object.freeze({ [BATCH_A]: "a_only_table", [BATCH_B]: "b_only_table" });
const SURVIVES = "kept_by_earlier_batch";
const hostUrl = (environment: string): string =>
  `postgres://app:${PASSWORD}@127.0.0.1:${environment === ENV_B ? 2 : 1}/${environment}`;

/** The arm's policy, handed the environment's OWN real host record so it can return it,
 *  withhold it (`null`), or damage one field -- without any arm having to know the temp
 *  roots the engine actually needs to exist on disk. */
type Resolver =
  (environment: string, host: MigrateDownHostContext) => MigrateDownHostContext | null;

interface Offline {
  readonly asked: readonly string[];
  /** What the host ports were handed, in order: the ENGINE's own view of the resolution. */
  readonly seen: readonly { readonly connection: string; readonly workspace: string }[];
  readonly rootOf: (environment: string) => string;
  readonly schemaOf: (environment: string) => readonly string[];
  readonly revert: (input: { readonly environment: string; readonly commandId?: string;
    readonly principalId?: string; readonly toMigrationRequestId?: string }) => Promise<unknown>;
  readonly receipt: (commandId: string) => unknown;
  readonly close: () => void;
}

/** The daemon under test, composed the way production composes it. `hostContext` is passed
 *  through verbatim -- including ABSENT, which reaches the composition as a missing option
 *  rather than as a resolver that answers null: those are two distinct refusal arms. */
async function offline(hostContext: Resolver | undefined,
  options: { readonly compose?: boolean } = {}): Promise<Offline> {
  const roots = new Map<string, string>();
  const schemas = new Map<string, Set<string>>();
  const asked: string[] = [];
  const seen: { readonly connection: string; readonly workspace: string }[] = [];
  const store = openStore();
  const rootOf = (environment: string): string => {
    let value = roots.get(environment);
    if (value === undefined) {
      value = mkdtempSync(join(tmpdir(), `moe-md-${environment}-`));
      mkdirSync(join(value, "migrations"), { recursive: true });
      roots.set(environment, value);
    }
    return value;
  };
  // Both hosts materialise UP FRONT so the two environments differ in every field, and so a
  // resolver that ignored its argument would hand one host's root and database to the other.
  for (const environment of [ENVIRONMENT, ENV_B]) {
    rootOf(environment);
    schemas.set(hostUrl(environment), new Set([SURVIVES]));
  }
  const ports: MigrationDownPorts = Object.freeze({
    dump: async (_connection: string, path: string): Promise<void> => {
      writeFileSync(path, "-- offline dump\n");
    },
    revert: async (workspace: string, connection: string,
      batch: readonly string[]): Promise<readonly string[]> => {
      // THE REVERT LANDS ON THE DATABASE IT WAS POINTED AT, and only there.
      seen.push({ connection, workspace });
      const schema = schemas.get(connection);
      if (schema === undefined) throw new Error(`revert reached an unknown database: ${workspace}`);
      for (const name of batch) schema.delete(TABLE_OF[name] ?? name);
      return [...batch].reverse();
    },
  });
  const recording: ((environment: string) => MigrateDownHostContext | null) | undefined
    = hostContext === undefined
    ? undefined
    : (environment: string): MigrateDownHostContext | null => {
      asked.push(environment);
      // The REAL host record for this environment -- a distinct temp root and a distinct
      // connection each -- so "it reached A's database and workspace" is measurable.
      return hostContext(environment, { databaseUrl: hostUrl(environment),
        projectRoot: rootOf(environment), workspace: rootOf(environment) });
    };
  const double = createDockerDouble({
    proxyConfig: PROXY_CONFIG, running: { app: "HEALTHY" },
    health: { [candidateContainerName(ENVIRONMENT, SHA, "cmd-deploy-offline")]: ["HEALTHY"] },
  });
  driveThrough(store, "goal.close");
  const daemon = createDaemonCommandPorts({
    clock: (): string => DECIDED_AT, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    deploymentDeploy: {
      buildContext: "/workspace/product", clock: (): string => DECIDED_AT,
      healthBudgetMs: 10, pollMs: 1, sleep: (): Promise<void> => Promise.resolve(),
      ports: { build: double.build, docker: double.docker, releaseDecision: (): string | null => null,
        ssh: double.ssh, target: (): DeployTarget => LOCAL, transfer: double.transfer },
    },
    // THE NINTH SEAM, exercised through the production registry rather than around it.
    ...(options.compose === false ? {} : { migrateDown: {
      clock: (): string => REVERT_AT, ports,
      ...(recording === undefined ? {} : { hostContext: recording }),
    } }),
  });
  const dispatch = async (kind: string, commandId: string,
    payload: Readonly<Record<string, unknown>>, principalId: string): Promise<unknown> => {
    const entry = daemon.registry.get(kind as RuntimeCommandEnvelope["commandKind"]);
    const handler = entry?.asyncHandler;
    if (handler === undefined) throw new Error(`${kind} carries no async handler in the registry`);
    const envelope: RuntimeCommandEnvelope = {
      commandId, commandKind: kind as RuntimeCommandEnvelope["commandKind"],
      correlationId: `corr-${commandId}`, expectedVersion: store.getAggregateVersion(PROJECT_ID),
      payload: payload as RuntimeCommandEnvelope["payload"], requestDigest: "d".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: "migrate-down-offline-credential", targetAggregateId: PROJECT_ID,
    };
    return handler({ envelope,
      principal: { capabilities: ["goal.write"], principalId, projectId: PROJECT_ID } });
  };
  await dispatch(DEPLOYMENT_DEPLOY_COMMAND_KIND, "cmd-deploy-offline",
    { environment: ENVIRONMENT, sha: SHA }, OPERATOR);
  // The APPLIED batch each environment's revert will name, written by the REAL forward engine
  // against that environment's OWN root and connection.
  for (const [environment, batch] of [[ENVIRONMENT, BATCH_A], [ENV_B, BATCH_B]] as const) {
    const applied = await migrateWithBackup(store, {
      databaseUrl: hostUrl(environment), environment, now: new Date(DECIDED_AT),
      projectId: PROJECT_ID, projectRoot: rootOf(environment), requestId: `applied-${environment}`,
      sha: SHA, workspace: rootOf(environment),
    }, {
      dump: async (_connection: string, path: string): Promise<void> => {
        writeFileSync(path, "-- offline forward dump\n");
      },
      apply: async (): Promise<readonly string[]> => {
        schemas.get(hostUrl(environment))!.add(TABLE_OF[batch]!);
        return [batch];
      },
    });
    expect(applied, `forward setup for ${environment}`)
      .toMatchObject({ applied: [batch], outcome: "APPLIED", refusal: null });
  }
  return {
    asked, seen, rootOf,
    schemaOf: (environment: string): readonly string[] =>
      [...(schemas.get(hostUrl(environment)) ?? new Set<string>())].sort(),
    receipt: (commandId: string): unknown => readMigrationReceipt(store, PROJECT_ID, commandId),
    revert: async (input): Promise<unknown> => dispatch(DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND,
      input.commandId ?? `cmd-revert-${input.environment}`,
      { environment: input.environment,
        toMigrationRequestId: input.toMigrationRequestId ?? `applied-${input.environment}` },
      input.principalId ?? OPERATOR),
    close: (): void => {
      for (const value of roots.values()) rmSync(value, { recursive: true, force: true });
      roots.clear();
    },
  };
}

/** The refusal a dispatch produced, or a failure naming what came back instead -- so an arm
 *  cannot pass by swallowing a success it was supposed to refuse. */
async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
}

// TEARDOWN ON EVERY EXIT PATH, refusing arms included (epic rail 4). Store handles are released
// here as well as each arm's temp trees in its own `finally`, so an arm that throws before its
// cleanup still leaves nothing open. No arm below creates a container, a port or a child process.
afterEach(() => { closeStores(); vi.restoreAllMocks(); });

it("resolves each environment's own host authority through the production registry", async () => {
  const world = await offline((environment, host) =>
    environment === ENVIRONMENT || environment === ENV_B ? host : null);
  try {
    expect(world.schemaOf(ENVIRONMENT)).toEqual([TABLE_OF[BATCH_A], SURVIVES].sort());
    expect(world.schemaOf(ENV_B)).toEqual([TABLE_OF[BATCH_B], SURVIVES].sort());

    await world.revert({ environment: ENVIRONMENT });
    // A's revert landed on A's DATABASE, named A's batch, and left B entirely alone.
    expect(world.schemaOf(ENVIRONMENT)).toEqual([SURVIVES]);
    expect(world.schemaOf(ENV_B)).toEqual([TABLE_OF[BATCH_B], SURVIVES].sort());
    expect(world.receipt("cmd-revert-staging")).toMatchObject({
      applied: [BATCH_A], environment: ENVIRONMENT, outcome: "REVERTED", refusal: null,
    });

    await world.revert({ environment: ENV_B });
    expect(world.schemaOf(ENV_B)).toEqual([SURVIVES]);
    expect(world.receipt("cmd-revert-production")).toMatchObject({
      applied: [BATCH_B], environment: ENV_B, outcome: "REVERTED", refusal: null,
    });

    // THE RESOLVER SAW THE ADMITTED ENVIRONMENT, in order, and nothing else. An arm where both
    // requests resolved the same host would satisfy every assertion above but this one.
    expect(world.asked).toEqual([ENVIRONMENT, ENV_B]);
    // AND THE ENGINE WAS HANDED THAT ENVIRONMENT'S OWN CONNECTION AND WORKSPACE, in order.
    expect(world.seen).toEqual([
      { connection: hostUrl(ENVIRONMENT), workspace: world.rootOf(ENVIRONMENT) },
      { connection: hostUrl(ENV_B), workspace: world.rootOf(ENV_B) },
    ]);
    expect(world.rootOf(ENVIRONMENT)).not.toBe(world.rootOf(ENV_B));
  } finally { world.close(); }
});

it("refuses MIGRATE_DOWN_UNCONFIGURED when no resolver is composed at all", async () => {
  const world = await offline(undefined, { compose: false });
  try {
    const before = world.schemaOf(ENVIRONMENT);
    const refusal = await refusalOf(world.revert({ environment: ENVIRONMENT }));
    expect(refusal.code).toBe(MIGRATE_DOWN_UNCONFIGURED);
    expect(refusal.layer).toBe(DAEMON_COMMAND_SEAM);
    expect(refusal.httpStatus).toBe(422);
    expect(refusal.message)
      .toBe(`${MIGRATE_DOWN_UNCONFIGURED}: no database is configured on this daemon`);
    // BEFORE ANY ENGINE READ OR WRITE: the schema is untouched and no receipt was written.
    expect(world.schemaOf(ENVIRONMENT)).toEqual(before);
    expect(world.receipt("cmd-revert-staging")).toBeNull();
    expect(world.asked).toEqual([]);
    expect(world.seen).toEqual([]);
  } finally { world.close(); }
});

it("refuses MIGRATE_DOWN_UNCONFIGURED when the resolver answers null for the environment",
  async () => {
    const world = await offline((environment, host) => environment === ENV_B ? host : null);
    try {
      const before = world.schemaOf(ENVIRONMENT);
      const refusal = await refusalOf(world.revert({ environment: ENVIRONMENT }));
      expect(refusal.code).toBe(MIGRATE_DOWN_UNCONFIGURED);
      expect(refusal.layer).toBe(DAEMON_COMMAND_SEAM);
      expect(refusal.httpStatus).toBe(422);
      expect(refusal.message)
        .toBe(`${MIGRATE_DOWN_UNCONFIGURED}: no database is configured on this daemon`);
      expect(world.schemaOf(ENVIRONMENT)).toEqual(before);
      expect(world.receipt("cmd-revert-staging")).toBeNull();
      // A COMPOSED daemon that holds no authority for THIS environment: the resolver WAS asked,
      // and asked for the admitted environment -- it simply had nothing to answer.
      expect(world.asked).toEqual([ENVIRONMENT]);
      expect(world.seen).toEqual([]);
    } finally { world.close(); }
  });

it("refuses MIGRATE_DOWN_UNCONFIGURED, naming the FIELD, when a resolved record is incomplete",
  async () => {
    const world = await offline((_environment, host) => ({ ...host, workspace: "" }));
    try {
      const before = world.schemaOf(ENVIRONMENT);
      const refusal = await refusalOf(world.revert({ environment: ENVIRONMENT }));
      expect(refusal.code).toBe(MIGRATE_DOWN_UNCONFIGURED);
      expect(refusal.layer).toBe(DAEMON_COMMAND_SEAM);
      expect(refusal.httpStatus).toBe(422);
      // THE FIELD, NEVER THE VALUE -- and the empty field is named precisely, not generically.
      expect(refusal.message)
        .toBe(`${MIGRATE_DOWN_UNCONFIGURED}: no workspace is configured on this daemon`);
      expect(refusal.message).not.toContain(PASSWORD);
      expect(world.schemaOf(ENVIRONMENT)).toEqual(before);
      expect(world.receipt("cmd-revert-staging")).toBeNull();
      expect(world.asked).toEqual([ENVIRONMENT]);
      expect(world.seen).toEqual([]);
    } finally { world.close(); }
  });

it("rejects a non-operator principal before the resolver is ever consulted", async () => {
  const world = await offline((_environment, host) => host);
  try {
    const before = world.schemaOf(ENVIRONMENT);
    const refusal = await refusalOf(
      world.revert({ environment: ENVIRONMENT, principalId: "principal-agent" }));
    expect(refusal.code).toBe("OPERATOR_PRINCIPAL_REQUIRED");
    expect(refusal.layer).toBe("DAEMON_AUTHORIZATION");
    expect(refusal.httpStatus).toBe(403);
    // NO RESOLUTION AND NO DECRYPTION FOR AN UNAUTHORISED CALLER: the fence answers first, so
    // the resolver is never called and no host secret is even looked up.
    expect(world.asked).toEqual([]);
    expect(world.seen).toEqual([]);
    expect(world.schemaOf(ENVIRONMENT)).toEqual(before);
    expect(world.receipt("cmd-revert-staging")).toBeNull();
  } finally { world.close(); }
});

it("keeps the resolved connection out of every log line, receipt and durable payload", async () => {
  const written: string[] = [];
  const capture = (chunk: unknown): boolean => { written.push(String(chunk)); return true; };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(args.map(value => String(value)).join(" "));
    });
  }
  const world = await offline((_environment, host) => host);
  try {
    const answer = await world.revert({ environment: ENVIRONMENT });
    const receipt = world.receipt("cmd-revert-staging");
    expect(receipt).toMatchObject({ outcome: "REVERTED", refusal: null });
    // ASSERTED POSITIVELY AGAINST CAPTURED OUTPUT AND DURABLE BYTES, not by reading the source.
    for (const [label, text] of [["log", written.join("\n")],
      ["decision", JSON.stringify(answer)], ["receipt", JSON.stringify(receipt)]] as const) {
      expect(text, `${label} leaked the password`).not.toContain(PASSWORD);
      expect(text, `${label} leaked the connection`).not.toContain(hostUrl(ENVIRONMENT));
      expect(text, `${label} leaked a connection scheme`).not.toContain("postgres://");
    }
    // The capture is real: the arm would notice a leak because it notices a plant.
    written.push(`planted ${PASSWORD}`);
    expect(written.join("\n")).toContain(PASSWORD);
  } finally { world.close(); }
});
