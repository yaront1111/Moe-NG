import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import {
  commitAccepted, commitAcceptedLegs, refuse, stateOf, versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler, HandlerTable } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import { aggregateIdFor } from "../bootstrap/bootstrap-sequence.js";
import { BOOTSTRAP_HANDLERS, admitBootstrapCommand, runBootstrapCommand }
  from "../bootstrap/bootstrap-services.js";
import { DomainRefusal, decisionOf } from "../daemon-command-dispatch.js";
import { DAEMON_COMMAND_SEAM } from "../http/http-async-contract.js";
import type { AsyncCommandHandler } from "../http/http-async-contract.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { releaseReceiptId } from "../release/release-receipt-contracts.js";
import { readReleaseReceipt } from "../release/release-receipt-ledger.js";
import { bootstrapRequestBytes } from "../repository/repository-bootstrap-command.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { candidateEnvironmentPort } from "./deploy-candidate-environment.js";
import { nodeDockerRunner, nodeImageTransfer, nodeSshRunner } from "./deploy-ports.js";
import type { DeployMigrationResult, DeployPorts } from "./deploy-ports.js";
import { resolveDeployMigrationContext } from "./deploy-migration-context.js";
import { environmentSchemaGuardId } from "./environment-schema-guard.js";
import {
  deploySchemaReleaseLeg, guardDeployMigration, openDeploySchemaHold,
} from "./deploy-schema-guard.js";
import type { DeploySchemaReservation } from "./deploy-schema-guard.js";
import type { EnvironmentCredentialSource } from "../environment/environment-projection.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { createDeployService } from "./deploy-service.js";
import { nodeDeployBuild } from "./deploy-image-build.js";
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

/** ANOTHER COMMAND HOLDS THIS ENVIRONMENT'S SCHEMA — a restoring `deployment.rollback` or a
 *  `deployment.migrate_down` has the shared per-environment guard reserved. A SEAM CODE, NOT AN
 *  ENGINE ONE, and that is load-bearing: `DEPLOY_REFUSAL_CODES` (`deploy-receipt-contracts.ts`:41)
 *  is a frozen four whose members each carry a `DeployEngineStamp` onto a durable receipt, while
 *  this is a fact about two commands racing at THIS seam. Minted beside `DEPLOY_GOAL_UNBOUND`, at
 *  409 not 422 because it is RETRYABLE — as `DEPLOY_ROLLBACK_IN_PROGRESS` is for the rollback. */
export const DEPLOY_ENVIRONMENT_SCHEMA_BUSY = "DEPLOY_ENVIRONMENT_SCHEMA_BUSY" as const;

/** THIS COMMAND ID ALREADY RESERVED THIS ENVIRONMENT FOR DIFFERENT BYTES, so the reservation on
 *  record is not this request's to release. Reachable, not defensive: a deploy that died before its
 *  terminal leaves no terminal decision, `replayOf` returns null, and the same command id under a
 *  DIFFERENT payload re-runs the handler — which without this refusal would free an environment
 *  whose schema is still mid-flight. Fails closed at 409; a fresh command id is the operator's
 *  move. Both precedents mint their own code rather than share one (`rollback-command.ts`:70,
 *  `migrate-down-admission.ts`:60). */
export const DEPLOY_ENVIRONMENT_SCHEMA_INTENT_CONFLICT
  = "DEPLOY_ENVIRONMENT_SCHEMA_INTENT_CONFLICT" as const;

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
  /**
   * THE DAEMON CREDENTIAL THAT OPENS THE ENVIRONMENT STORE, forwarded from the registry rather
   * than read from `process.env` here. Without it every real migration refuses
   * ENV_STORE_KEY_UNAVAILABLE@KEY, because the seal is underivable — so this is not an optional
   * nicety, it is what makes the composed migration reachable at all. ABSENT reads as an unwired
   * daemon, matching `daemon-command-registry.ts`'s own `?? (() => null)` default.
   */
  readonly environmentCredential?: EnvironmentCredentialSource;
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
 * The command handler binds `releaseDecision` to its admitted goal and requested commit.
 */
export function productionDeployPorts(
  store: Pick<SqliteEventStore, "readEvents">, projectId: string,
): DeployPorts {
  return Object.freeze({
    build: nodeDeployBuild,
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
function commitReport(
  report: DeployReport, reservation: DeploySchemaReservation | null,
): CommandHandler {
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
    const plan = {
      aggregateId,
      eventPayload: result as unknown as JsonValue,
      eventType: ENVIRONMENT_DEPLOY_DECIDED_EVENT,
      expectedVersion: versionOf(ledger, aggregateId),
      result: result as unknown as JsonValue,
    };
    /**
     * NO RESERVATION, NO RELEASE LEG — a real arm, not a defensive `?.`. A deploy refused before
     * its migration (build context unconfigured, goal unbound, a failed build, a missing digest)
     * reserved nothing, and a release leg fired there would fence a stream at an EVEN version and
     * fail the WHOLE terminal, turning a readable refusal into a bare conflict. `legs[0]` is
     * byte-identical either way: `commitAcceptedLegs` builds it from the same `CommitPlan` through
     * the same `eventDraft` (`bootstrap-ledger.ts`:240-244).
     */
    return reservation === null
      ? commitAccepted(store, request, plan)
      : commitAcceptedLegs(store, request, plan,
        [deploySchemaReleaseLeg(reservation, request.commandId, result)]);
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
    const goalId = envelope.targetAggregateId.startsWith("deploy:") ? envelope.targetAggregateId.slice(7) : null;
    if ((goalId !== null && goalId.length === 0) || (goalId === null && envelope.targetAggregateId !== projectId)) {
      throw new DomainRefusal("DEPLOY_GOAL_UNBOUND", DAEMON_COMMAND_SEAM, "deployment target does not name a goal in this project", 422);
    }
    const payload = goalId === null ? envelope.payload : { ...envelope.payload, goalId };
    const bytes = bootstrapRequestBytes(DEPLOYMENT_DEPLOY_COMMAND_KIND, projectId, decidedAt,
      payload, envelope, principal.principalId);
    // ADMIT FIRST. A replay, an unbound environment's missing `deployment.set_target` or a
    // malformed envelope is answered here, before docker is asked for anything.
    const admitted = admitBootstrapCommand(store, bytes, {
      ...BOOTSTRAP_HANDLERS, [DEPLOYMENT_DEPLOY_COMMAND_KIND]: unreachableHandler,
    } satisfies HandlerTable);
    if ("outcome" in admitted) return decisionOf(admitted.outcome);
    if (goalId !== null) {
      const goal = stateOf(admitted.ledger, goalId);
      if (typeof goal !== "object" || goal === null || Array.isArray(goal)
        || (goal as JsonObject)["goalId"] !== goalId || (goal as JsonObject)["projectId"] !== projectId
        || (readPublishLedger(store, projectId).get(goalId)?.requests.length ?? 0) === 0) {
        throw new DomainRefusal("DEPLOY_GOAL_UNBOUND", DAEMON_COMMAND_SEAM, "deployment goal has no publication in this project", 422);
      }
    }
    if (versionOf(admitted.ledger, aggregateIdFor(admitted.request, null)) !== envelope.expectedVersion) {
      throw new DomainRefusal("BOOTSTRAP_EXPECTED_VERSION_STALE", DAEMON_COMMAND_SEAM, "deployment offer has a stale aggregate version", 409);
    }

    const basePorts = options.ports ?? {
      ...productionDeployPorts(store, projectId),
      /**
       * COMPOSED ONLY WHEN THE DAEMON HAS AN ENVIRONMENT CREDENTIAL, and that condition is a
       * WIRING fact rather than a per-request escape hatch. A daemon with no environment store has
       * no database to migrate, so composing a port there would make EVERY deploy on it refuse
       * ENV_STORE_KEY_UNAVAILABLE@KEY — a regression, not a safeguard. The real composition root
       * always supplies it (`daemon-store-foundation-composition.ts:277`
       * `environmentCredential: () => config.credential`), so a production daemon always migrates;
       * only an explicitly unwired composition does not, which is the case
       * `daemon-command-environment.test.ts:702` already names.
       *
       * THE REAL MIGRATION, IN THE REQUEST-SCOPED POSITION and never inside
       * `productionDeployPorts()`, which has no access to the admitted environment, sha or the
       * host's build context. There is NO no-op fallback: when no `ports` option is supplied —
       * which is what every production `deployment.deploy` does — this member is always the real
       * `migrateWithBackup` behind the real resolver. A silent no-op here would let every
       * production deploy skip its migration while reporting DEPLOYED.
       *
       * THE WORKSPACE IS THE BUILD CONTEXT, not a payload key: the same host-scoped directory the
       * image is built from is the tree whose migrations belong to this sha. A caller-supplied
       * path would let any operator-authenticated request migrate a directory nobody named, and
       * an unconfigured daemon already refuses the deploy under DEPLOY_BUILD_CONTEXT_UNCONFIGURED.
       *
       * `decisionId` becomes the migration's `requestId`, so a REPLAYED deploy replays the
       * migration receipt instead of starting a second batch. The replay, the project-wide lock
       * and the receipt identity all stay `migrateWithBackup`'s — nothing is re-implemented here.
       */
      /**
       * THE SAME WIRING CONDITION AS `migrate`, AND FOR THE SAME REASON: a daemon with no
       * environment credential has no variables to deliver, and composing this there would make
       * every deploy on it refuse. Both members read the SAME store through the SAME
       * `readEnvironmentDelivery` seam, so the migration and the container it will serve can never
       * disagree about what `production` means.
       */
      ...(options.environmentCredential === undefined ? {} : {
        environment: candidateEnvironmentPort({
          credential: options.environmentCredential, now: clock, projectId, store,
        }),
      }),
      ...(options.environmentCredential === undefined ? {} : { migrate: async (
        environment: string, sha: string, decisionId: string,
      ): Promise<DeployMigrationResult> => {
        const resolved = resolveDeployMigrationContext({
          credential: options.environmentCredential ?? ((): string | null => null),
          now: clock, projectId, projectRoot: options.buildContext, store,
          workspace: options.buildContext,
        }, { environment, requestId: decisionId, sha });
        // The resolver's refusal carries the layer that actually answered — SCOPE or KEY from the
        // environment slice, DAEMON_DEPLOY_ENGINE from the resolver's own workspace guards.
        if (!resolved.ok) return { code: resolved.code, detail: "", layer: resolved.layer, ok: false };
        const receipt = await migrateWithBackup(store, resolved.input);
        if (receipt.outcome === "APPLIED") return { applied: receipt.applied, ok: true };
        // `refusal.detail` is the engine's own failing FILE for MIGRATION_FAILED, which is what
        // DoD 3 requires the deploy to name. It is a file path, never a connection value.
        return {
          code: receipt.refusal?.code ?? "MIGRATION_FAILED",
          detail: receipt.refusal?.detail ?? "",
          layer: receipt.refusal?.layer ?? "DAEMON_INGRESS",
          ok: false,
        };
      } }),
      releaseDecision: (_environment: string, sha: string): string | null => {
        if (goalId === null) return null;
        const release = readReleaseReceipt(store, projectId,
          releaseReceiptId(projectId, goalId, sha, "RELEASED", null));
        if (release.ok) return release.receipt.receiptId;
        if (release.code === "RELEASE_RECEIPT_NOT_FOUND") return null;
        throw new DomainRefusal(release.code, DAEMON_COMMAND_SEAM,
          "the release receipt for this goal and commit could not be verified", 422);
      },
    };
    /**
     * THE SHARED PER-ENVIRONMENT SCHEMA GUARD, TAKEN AROUND THE MIGRATION AND GIVEN BACK BY THE
     * TERMINAL. `environment-schema-guard.ts`'s header carries the invariant and the span;
     * `deploy-schema-guard.ts`'s carries why the wrapper is shaped as it is. What belongs HERE is
     * the vocabulary — the derivation, the code and the layer this seam answers with. The hold is
     * mutable and NOT on the `DeployReport`, which must not grow a guard field.
     */
    // OPENED BEFORE THE ENGINE RUNS, so a re-issued command id carries its own prior reservation
    // down EVERY path the engine can take — including the receipt-replay one, which returns before
    // the migration and would otherwise commit a terminal with no release leg.
    const hold = openDeploySchemaHold(store, admitted.request);
    if (hold === null) {
      throw new DomainRefusal(DEPLOY_ENVIRONMENT_SCHEMA_INTENT_CONFLICT, DAEMON_COMMAND_SEAM,
        "this command id already reserved this environment for different bytes", 409);
    }
    const innerMigrate = basePorts.migrate;
    const ports: DeployPorts = innerMigrate === undefined ? basePorts : {
      ...basePorts,
      migrate: guardDeployMigration({
        busy: {
          code: DEPLOY_ENVIRONMENT_SCHEMA_BUSY, detail: "", layer: DAEMON_COMMAND_SEAM, ok: false,
        },
        guardIdFor: (environment: string) => environmentSchemaGuardId(projectId, environment),
        hold, inner: innerMigrate, now: clock, request: admitted.request, store,
      }),
    };
    const report = await createDeployService({
      ports, projectId, store,
      // Spread rather than assigned: under exactOptionalPropertyTypes an explicit `undefined`
      // is a DIFFERENT thing from an absent key, and only the absent key means "the engine's
      // own default".
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.healthBudgetMs === undefined ? {} : { healthBudgetMs: options.healthBudgetMs }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    }).deploy(deployRequestOf(envelope, context));

    const committed = runBootstrapCommand(store, bytes, {
      ...BOOTSTRAP_HANDLERS,
      [DEPLOYMENT_DEPLOY_COMMAND_KIND]: commitReport(report, hold.reservation),
    } satisfies HandlerTable);
    // AHEAD OF `refusalOf`: the engine's report is not the authority here. A deploy that never took
    // the guard was refused by THIS seam; the receipt records only `DEPLOY_BUILD_FAILED` with the
    // cause in its detail, the same bucket the engine uses for any migration refusal
    // (`deploy-service.ts`:311-319). The operator gets the code and layer that actually decided.
    if (committed.ok && hold.busy) {
      throw new DomainRefusal(DEPLOY_ENVIRONMENT_SCHEMA_BUSY, DAEMON_COMMAND_SEAM,
        "another command holds this environment's schema", 409);
    }
    // The decision is durable either way; a refused deploy still answers with the engine's own
    // code and layer rather than a committed success the operator would misread as a deploy.
    if (committed.ok && report.outcome === "REFUSED") throw refusalOf(report);
    return decisionOf(committed);
  };
}
