import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { commitAccepted, refuse, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler, HandlerTable } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import { aggregateIdFor } from "../bootstrap/bootstrap-sequence.js";
import { BOOTSTRAP_HANDLERS, admitBootstrapCommand, runBootstrapCommand }
  from "../bootstrap/bootstrap-services.js";
import { DomainRefusal, decisionOf } from "../daemon-command-dispatch.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { bootstrapRequestBytes } from "../repository/repository-bootstrap-command.js";
import type { MigrationDownPorts } from "../repository/migrations/migration-down-ports.js";
import { revertLastBatch } from "../repository/migrations/migration-down-service.js";
import type { MigrationReceipt } from "../repository/migrations/migration-receipt.js";

/**
 * The command edge for `deployment.migrate_down`: the one place the revert engine, the bootstrap
 * admission surface and the operator fence are composed.
 *
 * IT IS AN ASYNC ENTRY, NOT A `GOAL_HANDLERS` ROW, and that is forced rather than chosen, for
 * the reason `bootstrap-contracts.ts` states about its async-served siblings: `CommandHandler` is
 * `(context) => ServiceOutcome` — synchronous — while this command dumps a database and runs the
 * generated product's migration tool. A synchronous adapter could only answer BEFORE the schema
 * moved, so its receipt would describe an intention. `deployment.deploy` and `deployment.rollback`
 * are registered here for the same reason, and the registry SPREADS this table, so the kind is
 * served without a single line in `daemon-command-registry.ts`.
 *
 * NO MIGRATION-TOOL ARGV AND NO SQL LIVE HERE. Every spawn, the backup, the last-batch guard and
 * the lock belong to the engine behind `MigrationDownPorts`.
 */

/** The daemon was never configured with a workspace and a database to revert, so no request can
 *  name one. Refused BEFORE any effect: this is a fact about the wiring, not about the request. */
export const MIGRATE_DOWN_UNCONFIGURED = "MIGRATE_DOWN_UNCONFIGURED" as const;

/** The durable event a decided revert appends. The engine's own receipt lands separately on
 *  `migration:<receiptId>`; this one records that the COMMAND was decided, so the bootstrap
 *  ledger's replay fence and prerequisite chain see the kind at all. */
export const ENVIRONMENT_MIGRATE_DOWN_DECIDED_EVENT = "EnvironmentMigrateDownDecided" as const;

export const DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND = "deployment.migrate_down" as const;

export interface MigrateDownCommandOptions {
  readonly clock?: () => string;
  /** HOST-SCOPED DAEMON CONFIGURATION, never a payload key. A caller-supplied connection string
   *  would be arbitrary database reach from any operator-authenticated request, and it would put
   *  a production password on the command wire and into every envelope the store keeps. */
  readonly databaseUrl?: string;
  /** THE ASYNC ENTRY MUST FENCE ITSELF: the registry's operator check lives in the SYNCHRONOUS
   *  handler path, which an async entry never reaches, so roster membership alone would leave
   *  this kind dispatchable by any GOAL-capable session — including an agent's, since the MCP
   *  port authenticates with the operator bootstrap credential. */
  readonly operatorPrincipalId: string;
  /** ABSENT means production: the real dump and the real migration tool on this host. */
  readonly ports?: MigrationDownPorts;
  readonly projectId: string;
  /** Where the pre-revert backup tree lives. Host-scoped for the same reason as the two above. */
  readonly projectRoot?: string;
  readonly store: SqliteEventStore;
  /** The bound product workspace whose `migrations` directory is reverted. Host-scoped. */
  readonly workspace?: string;
}

/** A placeholder that admit-time only has to FIND. `admitBootstrapCommand` checks presence and
 *  never calls it, so reaching this body would mean the gate order had changed underneath. */
const unreachableHandler: CommandHandler = (context) =>
  refuse(context.request.kind, "BOOTSTRAP_COMMAND_UNKNOWN", "DAEMON_INGRESS");

/** One committed decision per revert, refusals included: an operator whose revert refused after
 *  the dump needs the ledger to say the command was decided. The caller still receives the
 *  refusal — see `refusalOf`. */
function commitReceipt(receipt: MigrationReceipt): CommandHandler {
  return (context) => {
    const { ledger, request, store } = context;
    const aggregateId = aggregateIdFor(request, null);
    // THE REVERTED MIGRATIONS ARE NAMED, not counted: an operator reading this decision weeks
    // later needs to know WHICH change was undone, which a count cannot say.
    const result = {
      environment: receipt.environment, outcome: receipt.outcome,
      receiptId: receipt.receiptId, reverted: [...receipt.applied],
    } satisfies JsonObject;
    return commitAccepted(store, request, {
      aggregateId,
      eventPayload: result as unknown as JsonValue,
      eventType: ENVIRONMENT_MIGRATE_DOWN_DECIDED_EVENT,
      expectedVersion: versionOf(ledger, aggregateId),
      result: result as unknown as JsonValue,
    });
  };
}

/** The engine's OWN code, layer and detail. A REFUSED receipt always carries one, so the seam
 *  never has to invent a generic message for a refusal the engine reached. */
function refusalOf(receipt: MigrationReceipt): DomainRefusal {
  const refusal = receipt.refusal;
  return refusal === null
    ? new DomainRefusal("MIGRATION_DOWN_FAILED", DAEMON_COMMAND_SEAM, "the revert refused", 422)
    : new DomainRefusal(refusal.code, refusal.layer, refusal.detail, 422);
}

/**
 * The engine's LOCK and RECEIPT failures are thrown, not returned — a concurrent revert, an
 * unwritable receipt, a backup directory that turned into a symlink. They carry the engine's own
 * `{code, layer, detail}`, so they are re-thrown as coded refusals rather than escaping as an
 * opaque Error: an operator whose revert lost a race must be told MIGRATION_IN_PROGRESS, not
 * handed a 500. MIGRATION_IN_PROGRESS is a CONFLICT (409) because retrying later is the correct
 * response; everything else is unprocessable (422).
 */
function thrownRefusal(error: unknown): never {
  const carried = error as { code?: unknown; detail?: unknown; layer?: unknown };
  if (typeof carried.code === "string" && typeof carried.layer === "string") {
    throw new DomainRefusal(carried.code, carried.layer,
      typeof carried.detail === "string" ? carried.detail : carried.code,
      carried.code === "MIGRATION_IN_PROGRESS" ? 409 : 422);
  }
  throw error;
}

function stringField(payload: JsonObject, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

export function createMigrateDownCommandHandler(
  options: MigrateDownCommandOptions,
): AsyncCommandHandler {
  const { operatorPrincipalId, projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  return async ({ envelope, principal }: CommandHandlerInput): Promise<DurableDecision> => {
    // FENCED AT ENTRY, before the clock, the decode and any effect. Reverting a production
    // schema is never an agent's decision, and this kind is served asynchronously, so no
    // synchronous operator check will ever run for it.
    if (principal.principalId !== operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    const databaseUrl = options.databaseUrl ?? "";
    const workspace = options.workspace ?? "";
    const projectRoot = options.projectRoot ?? "";
    if (databaseUrl.length === 0 || workspace.length === 0 || projectRoot.length === 0) {
      // The detail names WHICH of the three is missing, and deliberately never the value of any
      // of them: the connection string is a secret (epic rail 3) and a refusal is a log line.
      throw new DomainRefusal(MIGRATE_DOWN_UNCONFIGURED, DAEMON_COMMAND_SEAM,
        `no ${databaseUrl.length === 0 ? "database" : workspace.length === 0 ? "workspace" : "project root"} is configured on this daemon`, 422);
    }
    const decidedAt = clock();
    const bytes = bootstrapRequestBytes(DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND, projectId, decidedAt,
      envelope.payload, envelope, principal.principalId);
    // ADMIT FIRST. A replay, a missing `deployment.deploy` in this project's durable sequence or
    // a malformed envelope is answered here, before anything dumps or reverts.
    const admitted = admitBootstrapCommand(store, bytes, {
      ...BOOTSTRAP_HANDLERS, [DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND]: unreachableHandler,
    } satisfies HandlerTable);
    if ("outcome" in admitted) return decisionOf(admitted.outcome);

    const receipt = await revertLastBatch(store, {
      databaseUrl, environment: stringField(envelope.payload, "environment"), projectId,
      projectRoot, requestId: envelope.commandId,
      toMigrationRequestId: stringField(envelope.payload, "toMigrationRequestId"), workspace,
    }, options.ports).catch(thrownRefusal);

    const committed = runBootstrapCommand(store, bytes, {
      ...BOOTSTRAP_HANDLERS, [DEPLOYMENT_MIGRATE_DOWN_COMMAND_KIND]: commitReceipt(receipt),
    } satisfies HandlerTable);
    // The decision is durable either way; a refused revert still answers with the engine's own
    // code and layer rather than a committed success the operator would misread as a revert.
    if (committed.ok && receipt.outcome !== "REVERTED") throw refusalOf(receipt);
    return decisionOf(committed);
  };
}
