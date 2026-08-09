import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { DurableStoreError, IdempotencyConflictError, SqliteEventStore } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import { reseatToSnapshot } from "@moe/store/subscriptions/subscription-writes.js";
import type { JsonObject } from "@moe/contracts";

import { BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap/bootstrap-contracts.js";
import type { BootstrapCommandKind } from "./bootstrap/bootstrap-contracts.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap/bootstrap-services.js";
import type { HandlerTable, ServiceOutcome } from "./bootstrap/bootstrap-ledger.js";
import type { DaemonDependencyProvider } from "./daemon-entry.js";
import { GOAL_HANDLERS } from "./goals/goal-services.js";
import { PLANNING_HANDLERS } from "./planning/planning-services.js";
import { REVIEW_SCHEMA_VERSION } from "./review/review-contracts.js";
import type { ReviewCommandKind } from "./review/review-contracts.js";
import type { ReviewOutcome } from "./review/review-ledger.js";
import { runReviewCommand } from "./review/review-services.js";
import { buildCommandRegistry } from "./http/http-contract.js";
import type {
  AuthenticationResult,
  CommandAdapterDeps,
  CommandDecisionPort,
  CommandHandler,
  CommandRegistryEntry,
  DecisionPortResult,
  DurableDecision,
} from "./http/http-contract.js";
import type {
  StreamPageRequest,
  StreamReseatRequest,
  SubscriptionPort,
} from "./http/event-stream-contract.js";

/**
 * The production dependency provider: committed authority only, composed, never minted.
 *
 * Commands run through the committed domain services (`runBootstrapCommand`,
 * `runReviewCommand`) against a real `SqliteEventStore`, which own idempotent replay and
 * the durable decision ledger. A domain refusal stays a refusal — `authority: "NONE"`
 * is never presented as a durable decision. The subscription port is the committed
 * store implementation; on a store with no published cursor generation it refuses
 * `SUBSCRIPTION_GENERATION_MISSING`, which is the honest arm until the projection
 * pipeline lands.
 *
 * Known impedance, disclosed: the wire envelope's `requestDigest` cannot participate in
 * store-side digest-conflict detection because `BootstrapRequest`/`ReviewRequest` key
 * sets are closed; conflict detection runs over the canonical request bytes instead.
 * There is also no committed session machinery (`session.open` has no handler anywhere),
 * so authentication is a single operator credential compared in constant time.
 */

const CAPABILITIES = {
  ADMIN: "project.admin",
  GOAL: "goal.write",
  PLANNING: "planning.write",
  REVIEW: "review.write",
} as const;

const BOOTSTRAP_FAMILY: Readonly<Record<BootstrapCommandKind, string>> = Object.freeze({
  "approval.decide": CAPABILITIES.PLANNING,
  "goal.close": CAPABILITIES.GOAL,
  "goal.create": CAPABILITIES.GOAL,
  "plan.propose": CAPABILITIES.PLANNING,
  "policy.install": CAPABILITIES.ADMIN,
  "policy.validate": CAPABILITIES.ADMIN,
  "project.activate": CAPABILITIES.ADMIN,
  "project.bind_repository": CAPABILITIES.ADMIN,
  "project.register": CAPABILITIES.ADMIN,
  "provider.probe": CAPABILITIES.ADMIN,
});

const REVIEW_FAMILY: Readonly<Record<ReviewCommandKind, string>> = Object.freeze({
  "escalation.decide": CAPABILITIES.REVIEW,
  "integration.accept_output": CAPABILITIES.REVIEW,
  "qualification.replan": CAPABILITIES.REVIEW,
  "review.submit": CAPABILITIES.REVIEW,
});

/** Exact top-level payload keys each command admits; an unlisted key is refused upstream. */
const PAYLOAD_KEYS: Readonly<Record<BootstrapCommandKind | ReviewCommandKind, readonly string[]>> =
  Object.freeze({
    "approval.decide": ["activation", "command", "graphRevisionRef", "record", "runId"],
    "escalation.decide": ["escalationRef", "subjectRef"],
    "goal.close": ["closureWitness", "goalId", "zeroAuthorityWitness"],
    "goal.create": ["budgetAccountRef", "goalId", "planningRunRef", "witness"],
    "integration.accept_output": [
      "calibration", "packageItems", "policy", "proof", "reviewer", "subjectRef",
    ],
    "plan.propose": ["commands", "runId"],
    "policy.install": ["slice"],
    "policy.validate": ["input"],
    "project.activate": ["witness"],
    "project.bind_repository": ["observation"],
    "project.register": ["owner"],
    "provider.probe": ["observation"],
    "qualification.replan": [
      "nodes", "subjectRef", "successorPlanRef", "supportedCanonicalizerVersions",
    ],
    "review.submit": ["findings", "packageItems", "subjectRef"],
  });

const OPERATOR_CAPABILITIES: readonly string[] = Object.freeze([
  CAPABILITIES.ADMIN, CAPABILITIES.GOAL, CAPABILITIES.PLANNING, CAPABILITIES.REVIEW,
]);

export interface StoreDependencyConfig {
  readonly clock?: () => string;
  readonly credential: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly storePath: string;
}

/** Thrown before any socket exists; surfaces as DAEMON_ENTRY_PROVIDER_THREW. */
export const STORE_DEPENDENCIES_ENV_MISSING = "STORE_DEPENDENCIES_ENV_MISSING" as const;

const ENV_KEYS = ["MOE_STORE_PATH", "MOE_PROJECT_ID", "MOE_DAEMON_CREDENTIAL"] as const;

export function readStoreDependencyEnv(
  env: Readonly<Record<string, string | undefined>>,
): StoreDependencyConfig {
  const missing = ENV_KEYS.filter((key) => (env[key] ?? "") === "");
  if (missing.length > 0) {
    throw new Error(`${STORE_DEPENDENCIES_ENV_MISSING}: ${missing.join(", ")}`);
  }
  return Object.freeze({
    credential: env.MOE_DAEMON_CREDENTIAL as string,
    principalId: env.MOE_PRINCIPAL_ID ?? "operator-local",
    projectId: env.MOE_PROJECT_ID as string,
    storePath: env.MOE_STORE_PATH as string,
  });
}

function constantTimeMatches(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}

const encoder = new TextEncoder();

class DomainRefusal extends Error {
  public readonly code: string;
  public readonly detail: string;
  public readonly layer: string;

  public constructor(code: string, layer: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.layer = layer;
  }
}

function decisionOf(outcome: ReviewOutcome | ServiceOutcome): DurableDecision {
  if (!outcome.ok) {
    throw new DomainRefusal(
      outcome.code,
      outcome.refusedBy,
      outcome.error === null ? outcome.code : outcome.error.code,
    );
  }
  return Object.freeze({
    commandId: outcome.decision.key.commandId,
    disposition: outcome.disposition,
    effectId: outcome.decision.decisionId,
    resultCode: outcome.decision.resultCode,
  });
}

function refusal(
  code: string, httpStatus: number, detail: string, layer: string,
): DecisionPortResult {
  return Object.freeze({
    outcome: "REFUSED",
    refusal: Object.freeze({ code, detail, httpStatus, layer }),
  } as const);
}

/** Builds the provider. Opens the store once; `close` releases both handles. */
export function createStoreDependencies(
  config: StoreDependencyConfig,
): DaemonDependencyProvider & { close(): void } {
  const clock = config.clock ?? ((): string => new Date().toISOString());
  const store = SqliteEventStore.openForProject(config.storePath, config.projectId);
  let subscriptionDatabase: DatabaseSync | null = null;

  const requestOf = (
    kind: string,
    schemaVersion: string,
    envelope: { commandId: string; correlationId: string; expectedVersion: number;
      payload: JsonObject; },
    principalId: string,
  ): Uint8Array => encoder.encode(JSON.stringify({
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    decidedAt: clock(),
    expectedVersion: envelope.expectedVersion,
    kind,
    payload: envelope.payload,
    principalId,
    projectId: config.projectId,
    schemaVersion,
  }));

  const bootstrapTable: HandlerTable = Object.freeze({
    ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS,
  });

  const entryOf = (kind: BootstrapCommandKind | ReviewCommandKind): CommandRegistryEntry => {
    const review = kind in REVIEW_FAMILY;
    const handler: CommandHandler = ({ envelope, principal }) => {
      const bytes = requestOf(
        kind,
        review ? REVIEW_SCHEMA_VERSION : BOOTSTRAP_SCHEMA_VERSION,
        envelope,
        principal.principalId,
      );
      return decisionOf(review
        ? runReviewCommand(store, bytes)
        : runBootstrapCommand(store, bytes, bootstrapTable));
    };
    return Object.freeze({
      handler,
      kind,
      payloadKeys: PAYLOAD_KEYS[kind],
      requiredCapability: review
        ? REVIEW_FAMILY[kind as ReviewCommandKind]
        : BOOTSTRAP_FAMILY[kind as BootstrapCommandKind],
    });
  };

  const registry = buildCommandRegistry(
    (Object.keys(PAYLOAD_KEYS) as readonly (BootstrapCommandKind | ReviewCommandKind)[])
      .map(entryOf),
  );

  const decisions: CommandDecisionPort = {
    decide(_key, _requestDigest, commit): DecisionPortResult {
      try {
        return Object.freeze({ decision: commit(), outcome: "DECIDED" } as const);
      } catch (error) {
        if (error instanceof DomainRefusal) {
          return refusal(error.code, 422, error.detail, error.layer);
        }
        if (error instanceof IdempotencyConflictError) {
          return refusal(
            error.code, 409,
            "same command identity with different request bytes", "DURABLE_STORE",
          );
        }
        if (error instanceof DurableStoreError) {
          return refusal(error.code, 503, error.message, "DURABLE_STORE");
        }
        throw error;
      }
    },
  };

  const authenticate = (credential: string | null): AuthenticationResult => {
    if (credential === null || !constantTimeMatches(credential, config.credential)) {
      return Object.freeze({ verdict: "UNAUTHENTICATED" } as const);
    }
    return Object.freeze({
      principal: Object.freeze({
        capabilities: OPERATOR_CAPABILITIES,
        principalId: config.principalId,
        projectId: config.projectId,
      }),
      verdict: "AUTHENTICATED",
    } as const);
  };

  const provide = (): CommandAdapterDeps =>
    Object.freeze({ authenticator: Object.freeze({ authenticate }), decisions, registry });

  const subscriptions = (): SubscriptionPort => {
    const database = subscriptionDatabase ?? new DatabaseSync(config.storePath);
    subscriptionDatabase = database;
    database.exec("PRAGMA busy_timeout = 5000;");
    return Object.freeze({
      readPage: (request: StreamPageRequest) => readSubscriptionPage(store, database, request),
      reseat: (request: StreamReseatRequest) => reseatToSnapshot(database, request),
    });
  };

  return Object.freeze({
    close: (): void => { subscriptionDatabase?.close(); store.close(); },
    provide,
    subscriptions,
  });
}

let envProvider: (DaemonDependencyProvider & { close(): void }) | null = null;

function fromEnv(): DaemonDependencyProvider & { close(): void } {
  envProvider = envProvider ?? createStoreDependencies(readStoreDependencyEnv(process.env));
  return envProvider;
}

/** Bin entry: `--dependencies=src/daemon-store-dependencies.js`. Env is read lazily. */
const provider: DaemonDependencyProvider = Object.freeze({
  provide: () => fromEnv().provide(),
  subscriptions: () => {
    const port = fromEnv().subscriptions;
    if (port === undefined) throw new Error("unreachable: subscriptions is always wired");
    return port();
  },
});

export default provider;
