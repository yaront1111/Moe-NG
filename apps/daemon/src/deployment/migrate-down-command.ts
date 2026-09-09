import type { SqliteEventStore } from "@moe/store";
import { refuse } from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler, HandlerTable } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import { BOOTSTRAP_HANDLERS, admitBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { DomainRefusal, decisionOf } from "../daemon-command-dispatch.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { bootstrapRequestBytes } from "../repository/repository-bootstrap-command.js";
import type { MigrationDownPorts } from "../repository/migrations/migration-down-ports.js";
import { revertLastBatch } from "../repository/migrations/migration-down-service.js";
import { readMigrationReceipt } from "../repository/migrations/migration-receipt.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";
import { MIGRATE_DOWN_KIND, finishMigrationCommand, migrateDownRefuse, migrationCommandHistory,
  migrationCommandIdentity, readMigrationCommandTerminal, reserveMigrationCommand }
  from "./migrate-down-admission.js";
import type { MigrationCommandIdentity, MigrationCommandTerminal } from "./migrate-down-admission.js";

export const MIGRATE_DOWN_UNCONFIGURED = "MIGRATE_DOWN_UNCONFIGURED" as const;
export const ENVIRONMENT_MIGRATE_DOWN_DECIDED_EVENT = "EnvironmentMigrateDownDecided" as const;
export const DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND = MIGRATE_DOWN_KIND;

/** The three HOST-SCOPED values ONE environment's revert needs, resolved together or not at all.
 *  Host authority only: connection values never enter command bytes, receipt bytes, a log line or
 *  a refusal message, and not one of the three may be read off a caller-supplied payload. */
export interface MigrateDownHostContext {
  readonly databaseUrl: string;
  readonly projectRoot: string;
  readonly workspace: string;
}

/** The refusal a daemon that cannot resolve host authority owes, naming the FIELD and never the
 *  value: a resolved connection string must not reach a refusal message (secrecy). */
const unconfigured = (field: string): DomainRefusal => new DomainRefusal(
  MIGRATE_DOWN_UNCONFIGURED, DAEMON_COMMAND_SEAM, `no ${field} is configured on this daemon`, 422);

export interface MigrateDownCommandOptions {
  readonly clock?: () => string;
  /** PER-REQUEST host authority, resolved against the ADMITTED environment rather than held as a
   *  daemon-wide constant: a daemon serving two environments must not apply one database to both.
   *  ABSENT, a `null` answer, or any empty field is a REFUSING state (MIGRATE_DOWN_UNCONFIGURED @
   *  the command seam), never a skipped one and never a fallback to an inherited DATABASE_URL. */
  readonly hostContext?: (environment: string) => MigrateDownHostContext | null;
  readonly operatorPrincipalId: string;
  readonly ports?: MigrationDownPorts;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}
const unreachableHandler: CommandHandler = context =>
  refuse(context.request.kind, "BOOTSTRAP_COMMAND_UNKNOWN", "DAEMON_INGRESS");

function validateReceipt(
  store: SqliteEventStore, identity: MigrationCommandIdentity, receipt: MigrationReceipt,
): void {
  if (receipt.environment !== identity.environment || receipt.outcome === "APPLIED") {
    migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  }
  const source = readMigrationReceipt(store, identity.key.projectId, identity.sourceRequestId);
  if (receipt.outcome === "REVERTED") {
    if (source === null || source.outcome !== "APPLIED" || source.environment !== identity.environment
      || source.sha !== receipt.sha || JSON.stringify([...source.applied].reverse()) !== JSON.stringify(receipt.applied)) {
      migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
    }
  } else if (source !== null && source.outcome === "APPLIED" && source.environment === identity.environment
    && source.sha !== receipt.sha) migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
}

function answer(
  options: MigrateDownCommandOptions, identity: MigrationCommandIdentity,
  terminal: MigrationCommandTerminal, replayed: boolean,
): DurableDecision {
  if (terminal.outcome === "REFUSED") {
    throw new DomainRefusal(terminal.code, terminal.layer, terminal.detail, terminal.httpStatus);
  }
  const receipt = readMigrationReceipt(options.store, options.projectId, identity.key.commandId);
  if (receipt === null || receipt.receiptId !== terminal.receiptId) {
    return migrateDownRefuse("MIGRATE_DOWN_COMMAND_RESULT_INVALID");
  }
  validateReceipt(options.store, identity, receipt);
  if (receipt.refusal !== null) {
    throw new DomainRefusal(receipt.refusal.code, receipt.refusal.layer, receipt.refusal.detail, 422);
  }
  return { commandId: identity.key.commandId, disposition: replayed ? "REPLAYED" : "DECIDED",
    effectId: receipt.receiptId, resultCode: "REVERTED" };
}

function thrownTerminal(error: unknown): MigrationCommandTerminal {
  const carried = error as { code?: unknown; layer?: unknown } | null;
  if (carried !== null && typeof carried?.code === "string" && typeof carried?.layer === "string") {
    // Keep diagnostics value-free, even if a host seam attached a raw connection error.
    return { outcome: "REFUSED", code: carried.code, layer: carried.layer, detail: carried.code,
      httpStatus: carried.code === "MIGRATION_IN_PROGRESS" ? 409 : 422 };
  }
  throw error;
}

/** Authenticated identity and a durable version claim precede every effect. A retry can
 * recover an existing receipt; a pending intent without one cannot repeat an uncertain revert. */
export function createMigrateDownCommandHandler(options: MigrateDownCommandOptions): AsyncCommandHandler {
  const { operatorPrincipalId, projectId, store } = options;
  const clock = options.clock ?? (() => new Date().toISOString());
  return async (input: CommandHandlerInput): Promise<DurableDecision> => {
    const { envelope, principal } = input;
    if (principal.principalId !== operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    // Composition is settled before target admission, and only here. In every other case
    // `migrationCommandIdentity` must answer first, because `targetAggregateId` decides WHICH
    // aggregate this command's durable version claim is made against, and that has to be settled
    // before any effect is reserved. But on a daemon with nothing composed there is no aggregate
    // to revert at all: the operator's target is fine, so refusing it as MIGRATE_DOWN_TARGET_INVALID
    // would be a substantively untrue reason for a true refusal. The operator-principal fence above
    // still answers first, so an unauthenticated caller never observes UNCONFIGURED.
    const resolveHost = options.hostContext;
    if (resolveHost === undefined) throw unconfigured("database");
    const identity = migrationCommandIdentity(input, projectId);
    // RESOLVED ONCE PER DISPATCH, against the environment THIS request admitted. The indirection
    // is NOT a new fallback: absence above and a `null` or partial answer here keep the SAME
    // MIGRATE_DOWN_UNCONFIGURED the composition seam has always raised, still ahead of every
    // store read and every engine effect. Nothing here reads an inherited DATABASE_URL, and the
    // environment comes from the ADMITTED identity, never raw off the payload.
    const host = resolveHost(identity.environment);
    const databaseUrl = host?.databaseUrl ?? "", workspace = host?.workspace ?? "";
    const projectRoot = host?.projectRoot ?? "";
    if (databaseUrl.length === 0 || workspace.length === 0 || projectRoot.length === 0) {
      throw unconfigured(databaseUrl.length === 0
        ? "database" : workspace.length === 0 ? "workspace" : "project root");
    }
    const history = migrationCommandHistory(store, identity);
    if (history.decided !== null) return answer(options, identity, readMigrationCommandTerminal(history.decided), true);
    const recovered = readMigrationReceipt(store, projectId, envelope.commandId);
    if (history.intent !== null && recovered === null) migrateDownRefuse("MIGRATE_DOWN_IN_PROGRESS", 409);
    if (history.intent === null && recovered !== null) migrateDownRefuse("MIGRATE_DOWN_COMMAND_ID_SPENT", 409);
    const decidedAt = clock();
    if (history.intent === null) {
      const bytes = bootstrapRequestBytes(MIGRATE_DOWN_KIND, projectId, decidedAt,
        envelope.payload, envelope, principal.principalId);
      const admitted = admitBootstrapCommand(store, bytes, {
        ...BOOTSTRAP_HANDLERS, [MIGRATE_DOWN_KIND]: unreachableHandler,
      } satisfies HandlerTable);
      if ("outcome" in admitted) return decisionOf(admitted.outcome);
      reserveMigrationCommand(store, identity, decidedAt);
    }
    let terminal: MigrationCommandTerminal;
    let receipt: MigrationReceipt | null = recovered;
    try {
      receipt ??= await revertLastBatch(store, {
        databaseUrl, environment: identity.environment, projectId, projectRoot,
        requestId: envelope.commandId, toMigrationRequestId: identity.sourceRequestId, workspace,
      }, options.ports);
      validateReceipt(store, identity, receipt);
      terminal = { outcome: "RECEIPTED", receiptId: receipt.receiptId };
    } catch (error) { terminal = thrownTerminal(error); }
    const event = receipt === null ? terminal : { environment: receipt.environment,
      outcome: receipt.outcome, receiptId: receipt.receiptId, reverted: [...receipt.applied] };
    const decided = finishMigrationCommand(store, identity, terminal, clock(), event);
    return answer(options, identity, readMigrationCommandTerminal(decided), history.intent !== null);
  };
}
