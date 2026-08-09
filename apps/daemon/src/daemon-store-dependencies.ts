import { randomUUID } from "node:crypto";
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
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import { SESSION_SCHEMA_VERSION } from "./identity/session-contracts.js";
import type { SessionCommandKind } from "./identity/session-contracts.js";
import type { SessionOutcome } from "./identity/session-ledger.js";
import { runSessionCommand } from "./identity/session-services.js";
import { PLANNING_HANDLERS } from "./planning/planning-services.js";
import { createBoardProjectionService } from "./projections/board-projection-service.js";
import { readLatestDocumentWorkDossier } from "./documents/document-work-service.js";
import { createAffordancePort } from "./http/affordance-read.js";
import type { DocumentDossierReadPort } from "./http/document-dossier-read.js";
import { REVIEW_SCHEMA_VERSION } from "./review/review-contracts.js";
import type { ReviewCommandKind } from "./review/review-contracts.js";
import type { ReviewOutcome } from "./review/review-ledger.js";
import { runReviewCommand } from "./review/review-services.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "./work/work-claim-contracts.js";
import type { WorkClaimCommandKind } from "./work/work-claim-contracts.js";
import { runWorkClaimCommand } from "./work/work-claim-services.js";
import type { WorkClaimOutcome } from "./work/work-claim-services.js";
import { buildCommandRegistry } from "./http/http-contract.js";
import type {
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
  WORK: "work.write",
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

/** Session lifecycle is an operator concern until scoped delegation lands. */
const SESSION_FAMILY: Readonly<Record<SessionCommandKind, string>> = Object.freeze({
  "session.close": CAPABILITIES.ADMIN,
  "session.open": CAPABILITIES.ADMIN,
  "session.renew": CAPABILITIES.ADMIN,
});

/** Claiming work is every agent's right; the fence is per-item, not per-role. */
const WORK_FAMILY: Readonly<Record<WorkClaimCommandKind, string>> = Object.freeze({
  "work.claim": CAPABILITIES.WORK,
  "work.release": CAPABILITIES.WORK,
  "work.renew": CAPABILITIES.WORK,
});

type WiredCommandKind =
  | BootstrapCommandKind | ReviewCommandKind | SessionCommandKind | WorkClaimCommandKind;

/**
 * The capabilities an agent session needs to execute one wired kind: the kind's
 * own family capability plus work.write, because an agent that cannot claim,
 * renew, and release its item cannot participate in the work register at all.
 * Unknown kinds return null so a caller cannot mint capabilities for a command
 * this provider never wired.
 */
export function agentCapabilitiesFor(kind: string): readonly string[] | null {
  const family = kind in BOOTSTRAP_FAMILY
    ? BOOTSTRAP_FAMILY[kind as BootstrapCommandKind]
    : kind in REVIEW_FAMILY
      ? REVIEW_FAMILY[kind as ReviewCommandKind]
      : kind in SESSION_FAMILY
        ? SESSION_FAMILY[kind as SessionCommandKind]
        : kind in WORK_FAMILY ? WORK_FAMILY[kind as WorkClaimCommandKind] : null;
  if (family === null) return null;
  return family === CAPABILITIES.WORK
    ? Object.freeze([CAPABILITIES.WORK])
    : Object.freeze([family, CAPABILITIES.WORK]);
}

/** Exact top-level payload keys each command admits; an unlisted key is refused upstream. */
const PAYLOAD_KEYS: Readonly<Record<WiredCommandKind, readonly string[]>> =
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
    "session.close": ["sessionId"],
    "session.open": ["capabilities", "credentialSha256", "expiresAt", "sessionId"],
    "session.renew": ["expiresAt", "sessionId"],
    "work.claim": ["expiresAt", "workItemId"],
    "work.release": ["workItemId"],
    "work.renew": ["expiresAt", "workItemId"],
  });

const OPERATOR_CAPABILITIES: readonly string[] = Object.freeze([
  CAPABILITIES.ADMIN, CAPABILITIES.GOAL, CAPABILITIES.PLANNING,
  CAPABILITIES.REVIEW, CAPABILITIES.WORK,
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

function decisionOf(
  outcome: ReviewOutcome | ServiceOutcome | SessionOutcome | WorkClaimOutcome,
): DurableDecision {
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

  const entryOf = (kind: WiredCommandKind): CommandRegistryEntry => {
    const review = kind in REVIEW_FAMILY;
    const session = kind in SESSION_FAMILY;
    const work = kind in WORK_FAMILY;
    const schemaVersion = review
      ? REVIEW_SCHEMA_VERSION
      : session
        ? SESSION_SCHEMA_VERSION
        : work ? WORK_CLAIM_SCHEMA_VERSION : BOOTSTRAP_SCHEMA_VERSION;
    const handler: CommandHandler = ({ envelope, principal }) => {
      const bytes = requestOf(kind, schemaVersion, envelope, principal.principalId);
      if (review) return decisionOf(runReviewCommand(store, bytes));
      if (session) return decisionOf(runSessionCommand(store, bytes));
      if (work) return decisionOf(runWorkClaimCommand(store, bytes));
      return decisionOf(runBootstrapCommand(store, bytes, bootstrapTable));
    };
    const requiredCapability = review
      ? REVIEW_FAMILY[kind as ReviewCommandKind]
      : session
        ? SESSION_FAMILY[kind as SessionCommandKind]
        : work
          ? WORK_FAMILY[kind as WorkClaimCommandKind]
          : BOOTSTRAP_FAMILY[kind as BootstrapCommandKind];
    return Object.freeze({
      handler, kind, payloadKeys: PAYLOAD_KEYS[kind], requiredCapability,
    });
  };

  const registry = buildCommandRegistry(
    (Object.keys(PAYLOAD_KEYS) as readonly WiredCommandKind[]).map(entryOf),
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

  // Real credential resolution: operator secret OR an open unexpired session whose
  // credential hash matches — both resolved by the committed session ledger fold.
  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.now(),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: config.credential,
    operatorPrincipalId: config.principalId,
    projectId: config.projectId,
  });

  const provide = (): CommandAdapterDeps =>
    Object.freeze({ authenticator, decisions, registry });

  /** Default stream reader; the transport seam owns real subscriber lifecycle later. */
  const DEFAULT_READER = "control-room-1";

  const subscriptions = (): SubscriptionPort => {
    const database = subscriptionDatabase ?? new DatabaseSync(config.storePath);
    subscriptionDatabase = database;
    database.exec("PRAGMA busy_timeout = 5000;");
    const board = createBoardProjectionService({ database, store });
    // Idempotent: publishes generation 1 once, then seats the default reader. An
    // already-registered reader refuses SUBSCRIPTION_INPUT_INVALID — expected on
    // every boot after the first, so only unexpected refusals surface.
    const baseline = board.ensureBaseline("daemon provider startup");
    if (baseline.outcome === "BASELINE_READY") board.registerReader(DEFAULT_READER);
    return Object.freeze({
      // Fold-on-read: pages always reflect every committed event. The fold refusal
      // (if any) is deliberately not masked by a possibly-stale page read.
      readPage: (request: StreamPageRequest) => {
        const folded = board.foldOnce();
        if (folded.outcome !== "FOLDED") return folded;
        return readSubscriptionPage(store, database, request);
      },
      reseat: (request: StreamReseatRequest) => reseatToSnapshot(database, request),
    });
  };

  const affordances = () => createAffordancePort({
    mintId: () => randomUUID(),
    projectId: config.projectId,
    store,
  });

  const documentDossiers = (): DocumentDossierReadPort => Object.freeze({
    readLatest: (projectId: string) => readLatestDocumentWorkDossier(store, projectId),
  });

  return Object.freeze({
    affordances,
    close: (): void => { subscriptionDatabase?.close(); store.close(); },
    documentDossiers,
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
  affordances: () => {
    const port = fromEnv().affordances;
    if (port === undefined) throw new Error("unreachable: affordances is always wired");
    return port();
  },
  documentDossiers: () => {
    const port = fromEnv().documentDossiers;
    if (port === undefined) throw new Error("unreachable: document dossiers are always wired");
    return port();
  },
  provide: () => fromEnv().provide(),
  subscriptions: () => {
    const port = fromEnv().subscriptions;
    if (port === undefined) throw new Error("unreachable: subscriptions is always wired");
    return port();
  },
});

export default provider;
