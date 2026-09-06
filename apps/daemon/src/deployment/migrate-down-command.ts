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

export interface MigrateDownCommandOptions {
  readonly clock?: () => string;
  /** Host authority only; connection values never enter command or receipt bytes. */
  readonly databaseUrl?: string;
  readonly operatorPrincipalId: string;
  readonly ports?: MigrationDownPorts;
  readonly projectId: string;
  readonly projectRoot?: string;
  readonly store: SqliteEventStore;
  readonly workspace?: string;
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
    const identity = migrationCommandIdentity(input, projectId);
    const databaseUrl = options.databaseUrl ?? "", workspace = options.workspace ?? "";
    const projectRoot = options.projectRoot ?? "";
    if (databaseUrl.length === 0 || workspace.length === 0 || projectRoot.length === 0) {
      throw new DomainRefusal(MIGRATE_DOWN_UNCONFIGURED, DAEMON_COMMAND_SEAM,
        `no ${databaseUrl.length === 0 ? "database" : workspace.length === 0 ? "workspace" : "project root"} is configured on this daemon`, 422);
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
