import { decodeBoundedJsonBytes } from "@moe/contracts";
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
import { nodeDockerRunner, nodeImageTransfer, nodeSshRunner } from "./deploy-ports.js";
import type { DeployPorts } from "./deploy-ports.js";
import { createDeployService } from "./deploy-service.js";
import type { DeployReport, DeployRequest } from "./deploy-service.js";
import {
  DEPLOYMENT_DEPLOY_COMMAND_KIND, DEPLOY_TARGET_BOUND_EVENT, decodeDeployTarget,
  deployTargetAggregateId,
} from "./deploy-target-contracts.js";

/**
 * The command edge for `deployment.deploy`: the one place the landed engine
 * (`deploy-service.ts`), the bootstrap admission surface and the operator fence are composed.
 *
 * IT IS AN ASYNC ENTRY, NOT A `GOAL_HANDLERS` ROW, and that is forced rather than chosen.
 * `CommandHandler` is `(context) => ServiceOutcome` — synchronous — while this command builds an
 * image, replaces a container and polls health until docker itself calls it healthy. A
 * fire-and-forget synchronous adapter would answer with an outcome describing a deploy that has
 * not happened, and every receipt downstream of it would then be about an INTENTION. The shape
 * here is deliberately `repository-bootstrap-command.ts`'s twin: ADMIT FIRST through the
 * bootstrap surface (decode, replay fence, known kind, durable prerequisites), then perform the
 * effects, then commit through a handler closing over what the effects produced.
 *
 * ADMIT-FIRST IS A SAFETY PROPERTY HERE, not an optimisation: a replayed or out-of-sequence
 * request is answered before `docker build` spawns anything on the operator's host.
 *
 * NO DOCKER ARGV LIVES HERE. Every spawn, the atomic replace and the health poll belong to the
 * engine behind `DeployPorts`; this module holds no process spawn and no reducer.
 */

/** The docker build context: HOST-SCOPED DAEMON CONFIGURATION, read at the composition root.
 *  It is deliberately absent from `PAYLOAD_KEYS["deployment.deploy"]` — a caller-supplied path
 *  would let any operator-authenticated request build an arbitrary directory on this host. */
export const DEPLOY_BUILD_CONTEXT_ENV_KEY = "MOE_DEPLOY_BUILD_CONTEXT" as const;

/** The daemon has no configured build context, so no deploy can name one. Refused BEFORE any
 *  effect, in the seam's own layer: this is a fact about the wiring, not about the request. */
export const DEPLOY_BUILD_CONTEXT_UNCONFIGURED = "DEPLOY_BUILD_CONTEXT_UNCONFIGURED" as const;

/** The request never reached the engine: its sha or environment did not admit, so no receipt
 *  exists to carry a code. The SEAM refused, and the layer says so. */
export const DEPLOY_REQUEST_REJECTED = "DEPLOY_REQUEST_REJECTED" as const;

/** The durable event a decided deploy appends. The engine's own receipt lands separately on
 *  `deploy:<projectId>:<environment>`; this one records that the COMMAND was decided, so the
 *  bootstrap ledger's replay fence and prerequisite chain see the kind at all. */
export const ENVIRONMENT_DEPLOY_DECIDED_EVENT = "EnvironmentDeployDecided" as const;

export interface DeployCommandOptions {
  /** ABSENT means unconfigured, which is not the same as "build the current directory": the
   *  handler refuses rather than choosing a directory the operator never named. */
  readonly buildContext?: string;
  readonly clock?: () => string;
  /** The health-poll budget and interval, and the sleep between probes. Forwarded UNTOUCHED to
   *  the engine, which owns their defaults: an offline arm proving DEPLOY_HEALTH_TIMEOUT would
   *  otherwise have to wait out docker's real start-period in wall clock. */
  readonly healthBudgetMs?: number;
  /** THE ASYNC ENTRY MUST FENCE ITSELF: the registry's operator check lives in the SYNCHRONOUS
   *  handler path, which an async entry never reaches, so membership in the operator roster
   *  alone would leave this kind dispatchable by any GOAL-capable session — including an agent's,
   *  since the MCP port authenticates with the operator bootstrap credential. */
  readonly operatorPrincipalId: string;
  /** ABSENT means production: the real docker and ssh runners on this host. */
  readonly ports?: DeployPorts;
  readonly pollMs?: number;
  readonly projectId: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly store: SqliteEventStore;
}

/**
 * The host effects and the latest durable, per-project/environment target. The target decoder
 * remains the setter's authority; unreadable or invalid bindings fail closed as a missing target.
 * `releaseDecision` deliberately remains unconfigured: Gate 3's release authority is separate.
 */
export function productionDeployPorts(
  store: Pick<SqliteEventStore, "readEvents">, projectId: string,
): DeployPorts {
  return Object.freeze({
    docker: nodeDockerRunner,
    releaseDecision: () => null,
    ssh: nodeSshRunner,
    target: (environment: string) => {
      try {
        const latest = store.readEvents(deployTargetAggregateId(projectId, environment))
          .filter((event) => event.eventType === DEPLOY_TARGET_BOUND_EVENT).at(-1);
        if (latest === undefined) return null;
        const decoded = decodeBoundedJsonBytes(latest.payload);
        return decoded.ok ? decodeDeployTarget(decoded.value) : null;
      } catch {
        // Store failure means UNKNOWN, never permission to reuse a stale/default target.
        return null;
      }
    },
    transfer: nodeImageTransfer,
  });
}

/** A placeholder that admit-time only has to FIND. `admitBootstrapCommand` checks presence and
 *  never calls it, so reaching this body would mean the gate order had changed underneath. */
const unreachableHandler: CommandHandler = (context) =>
  refuse(context.request.kind, "BOOTSTRAP_COMMAND_UNKNOWN", "DAEMON_INGRESS");

/** One committed decision per deploy, refusals included: an operator whose deploy refused after
 *  `docker build` needs the ledger to say the command was decided, which an uncommitted refusal
 *  cannot. The caller still receives the refusal — see `refusalOf` below. */
function commitReport(report: DeployReport): CommandHandler {
  return (context) => {
    const { ledger, request, store } = context;
    const aggregateId = aggregateIdFor(request, null);
    // THE ENGINE'S OWN DETAIL IS CARRIED, not dropped: it is where a PRODUCTION deploy states
    // its release standing ("cites release decision <id>" or "no release decision", DoD 7).
    // A decision that recorded only the outcome would leave that standing unreadable to
    // everyone downstream of the command, which is exactly who needs it.
    const result = {
      detail: report.detail, environment: report.environment, outcome: report.outcome,
      receiptId: report.receipt?.receiptId ?? null, sha: report.receipt?.sha ?? null,
    } satisfies JsonObject;
    return commitAccepted(store, request, {
      aggregateId,
      eventPayload: result as unknown as JsonValue,
      eventType: ENVIRONMENT_DEPLOY_DECIDED_EVENT,
      expectedVersion: versionOf(ledger, aggregateId),
      result: result as unknown as JsonValue,
    });
  };
}

/** The engine's OWN code, layer and detail, never a generic message: `DEPLOY_BUILD_FAILED`
 *  carries docker's last stderr line because a receipt read weeks later is otherwise
 *  undiagnosable. A report with NO receipt refused before one could be recorded — the request
 *  named a sha or environment the receipt decoder would reject — so that arm carries the
 *  seam's own code and layer rather than borrowing the engine's stamp for a refusal the engine
 *  never reached. */
function refusalOf(report: DeployReport): DomainRefusal {
  const refusal = report.receipt?.refusal ?? null;
  return refusal === null
    ? new DomainRefusal(DEPLOY_REQUEST_REJECTED, DAEMON_COMMAND_SEAM, report.detail, 422)
    : new DomainRefusal(refusal.code, refusal.layer, refusal.detail, 422);
}

function stringField(payload: JsonObject, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/** The decision id is the COMMAND id: the receipt id and the candidate container name both
 *  derive from it, so a retry of the same command replays instead of starting a second
 *  container beside the first. */
function deployRequestOf(
  envelope: CommandHandlerInput["envelope"], context: string,
): DeployRequest {
  return {
    context,
    decisionId: envelope.commandId,
    environment: stringField(envelope.payload, "environment"),
    sha: stringField(envelope.payload, "sha"),
  };
}

export function createDeployCommandHandler(options: DeployCommandOptions): AsyncCommandHandler {
  const { operatorPrincipalId, projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  return async ({ envelope, principal }: CommandHandlerInput): Promise<DurableDecision> => {
    // FENCED AT ENTRY, before the clock, the decode and any effect. Deploying a product is
    // never an agent's decision, and this kind is served asynchronously, so no synchronous
    // operator check will ever run for it.
    if (principal.principalId !== operatorPrincipalId) {
      throw new DomainRefusal("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
        "this command requires the configured operator principal", 403);
    }
    const context = options.buildContext ?? "";
    if (context.length === 0) {
      throw new DomainRefusal(DEPLOY_BUILD_CONTEXT_UNCONFIGURED, DAEMON_COMMAND_SEAM,
        "no docker build context is configured on this daemon", 422);
    }
    const decidedAt = clock();
    const bytes = bootstrapRequestBytes(DEPLOYMENT_DEPLOY_COMMAND_KIND, projectId, decidedAt,
      envelope.payload, envelope, principal.principalId);
    // ADMIT FIRST. A replay, an unbound environment's missing `deployment.set_target` or a
    // malformed envelope is answered here, before docker is asked for anything.
    const admitted = admitBootstrapCommand(store, bytes, {
      ...BOOTSTRAP_HANDLERS, [DEPLOYMENT_DEPLOY_COMMAND_KIND]: unreachableHandler,
    } satisfies HandlerTable);
    if ("outcome" in admitted) return decisionOf(admitted.outcome);

    const report = await createDeployService({
      ports: options.ports ?? productionDeployPorts(store, projectId), projectId, store,
      // Spread rather than assigned: under exactOptionalPropertyTypes an explicit `undefined`
      // is a DIFFERENT thing from an absent key, and only the absent key means "the engine's
      // own default".
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.healthBudgetMs === undefined ? {} : { healthBudgetMs: options.healthBudgetMs }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    }).deploy(deployRequestOf(envelope, context));

    const committed = runBootstrapCommand(store, bytes, {
      ...BOOTSTRAP_HANDLERS, [DEPLOYMENT_DEPLOY_COMMAND_KIND]: commitReport(report),
    } satisfies HandlerTable);
    // The decision is durable either way; a refused deploy still answers with the engine's own
    // code and layer rather than a committed success the operator would misread as a deploy.
    if (committed.ok && report.outcome === "REFUSED") throw refusalOf(report);
    return decisionOf(committed);
  };
}
