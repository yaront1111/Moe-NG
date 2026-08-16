import { DurableStoreError, IdempotencyConflictError, type SqliteEventStore } from "@moe/store";
import type { JsonObject } from "@moe/contracts";

import { ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND,
  EFFECT_ACTIVATE_PAYLOAD_KEYS, type ActivationIngressOutcome }
  from "./activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation/activation-ingress.js";
import { BOOTSTRAP_SCHEMA_VERSION, type BootstrapCommandKind }
  from "./bootstrap/bootstrap-contracts.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap/bootstrap-services.js";
import type { HandlerTable, ServiceOutcome } from "./bootstrap/bootstrap-ledger.js";
import { GOAL_HANDLERS } from "./goals/goal-services.js";
import { SESSION_SCHEMA_VERSION, type SessionCommandKind } from "./identity/session-contracts.js";
import type { SessionOutcome } from "./identity/session-ledger.js";
import { createSessionAuthority } from "./identity/session-authority.js";
import { runSessionCommand } from "./identity/session-services.js";
import { PLANNING_HANDLERS } from "./planning/planning-services.js";
import { RECOVERY_COMPLETE_PAYLOAD_KEYS, RECOVERY_COMPLETION_COMMAND_KIND,
  RECOVERY_COMPLETION_SCHEMA_VERSION } from "./recovery/recovery-completion-digest.js";
import { runRecoveryCompleteCommand, type RecoveryCompletionOutcome }
  from "./recovery/recovery-completion.js";
import { createRecoveryCompletionAuthority }
  from "./recovery/recovery-completion-authority.js";
import { REVIEW_SCHEMA_VERSION, type ReviewCommandKind } from "./review/review-contracts.js";
import type { ReviewOutcome } from "./review/review-ledger.js";
import { runReviewCommand } from "./review/review-services.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "./review/verifier-receipt-ledger.js";
import { WORK_CLAIM_SCHEMA_VERSION, type WorkClaimCommandKind }
  from "./work/work-claim-contracts.js";
import { runWorkClaimCommand, type WorkClaimOutcome } from "./work/work-claim-services.js";
import { buildCommandRegistry, type CommandDecisionPort, type CommandHandler,
  type CommandRegistry, type CommandRegistryEntry, type DecisionPortResult,
  type DurableDecision } from "./http/http-contract.js";

/**
 * The daemon's command registry and durable decision port. Everything command-specific
 * lives here: the capability a kind demands, the exact payload keys it admits, the
 * service family that answers it, and how a family refusal becomes a port refusal. The
 * HTTP seam reads only the registry, so a command is added by registering an entry here
 * rather than by editing the boundary or the composition root.
 */

const CAPABILITIES = {
  ADMIN: "project.admin", GOAL: "goal.write", PLANNING: "planning.write",
  REVIEW: "review.write", WORK: "work.write",
} as const;

const BOOTSTRAP_FAMILY: Readonly<Record<BootstrapCommandKind, string>> = Object.freeze({
  "approval.decide": CAPABILITIES.PLANNING, "goal.close": CAPABILITIES.GOAL,
  "goal.create": CAPABILITIES.GOAL, "plan.propose": CAPABILITIES.PLANNING,
  "policy.install": CAPABILITIES.ADMIN, "policy.validate": CAPABILITIES.ADMIN,
  "project.activate": CAPABILITIES.ADMIN, "project.bind_repository": CAPABILITIES.ADMIN,
  "project.register": CAPABILITIES.ADMIN, "provider.probe": CAPABILITIES.ADMIN,
});

const REVIEW_FAMILY: Readonly<Record<ReviewCommandKind, string>> = Object.freeze({
  "escalation.decide": CAPABILITIES.REVIEW, "integration.accept_output": CAPABILITIES.REVIEW,
  "qualification.replan": CAPABILITIES.REVIEW, "review.submit": CAPABILITIES.REVIEW,
});

const SESSION_FAMILY: Readonly<Record<SessionCommandKind, string>> = Object.freeze({
  "session.close": CAPABILITIES.ADMIN, "session.open": CAPABILITIES.ADMIN,
  "session.renew": CAPABILITIES.ADMIN,
});

const WORK_FAMILY: Readonly<Record<WorkClaimCommandKind, string>> = Object.freeze({
  "work.claim": CAPABILITIES.WORK, "work.release": CAPABILITIES.WORK,
  "work.renew": CAPABILITIES.WORK,
});

type WiredCommandKind =
  | BootstrapCommandKind | ReviewCommandKind | SessionCommandKind | WorkClaimCommandKind
  | typeof EFFECT_ACTIVATE_COMMAND_KIND | typeof RECOVERY_COMPLETION_COMMAND_KIND;

export function agentCapabilitiesFor(kind: string): readonly string[] | null {
  if (kind === "node.deliver") {
    return Object.freeze([CAPABILITIES.REVIEW, CAPABILITIES.WORK]);
  }
  if (kind === EFFECT_ACTIVATE_COMMAND_KIND) return Object.freeze([CAPABILITIES.WORK]);
  if (kind === RECOVERY_COMPLETION_COMMAND_KIND) {
    return Object.freeze([CAPABILITIES.ADMIN, CAPABILITIES.WORK]);
  }
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

const PAYLOAD_KEYS: Readonly<Record<WiredCommandKind, readonly string[]>> =
  Object.freeze({
    "approval.decide": ["activation", "command", "graphRevisionRef", "record", "runId"],
    [EFFECT_ACTIVATE_COMMAND_KIND]: EFFECT_ACTIVATE_PAYLOAD_KEYS,
    [RECOVERY_COMPLETION_COMMAND_KIND]: RECOVERY_COMPLETE_PAYLOAD_KEYS,
    "escalation.decide": ["escalationRef", "subjectRef"],
    "goal.close": ["closureWitness", "goalId", "zeroAuthorityWitness"],
    "goal.create": ["budgetAccountRef", "goalId", "planningRunRef", "witness"],
    "integration.accept_output": ["receiptId", "subjectRef"],
    "plan.propose": ["commands", "runId"],
    "policy.install": ["slice"], "policy.validate": ["input"],
    "project.activate": ["witness"], "project.bind_repository": ["observation"],
    "project.register": ["owner"], "provider.probe": ["observation"],
    "qualification.replan": [
      "nodes", "subjectRef", "successorPlanRef", "supportedCanonicalizerVersions",
    ],
    "review.submit": ["findings", "packageItems", "round", "subjectRef"],
    "session.close": ["sessionId"],
    "session.open": ["capabilities", "credentialSha256", "expiresAt", "sessionId"],
    "session.renew": ["expiresAt", "sessionId"],
    "work.claim": ["expiresAt", "workItemId"], "work.release": ["workItemId"],
    "work.renew": ["expiresAt", "workItemId"],
  });

export const OPERATOR_CAPABILITIES: readonly string[] = Object.freeze([
  CAPABILITIES.ADMIN, CAPABILITIES.GOAL, CAPABILITIES.PLANNING,
  CAPABILITIES.REVIEW, CAPABILITIES.WORK,
]);

const encoder = new TextEncoder();

class DomainRefusal extends Error {
  public readonly code: string;
  public readonly detail: string;
  public readonly httpStatus: number;
  public readonly layer: string;

  public constructor(code: string, layer: string, detail: string, httpStatus = 422) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.httpStatus = httpStatus;
    this.layer = layer;
  }
}

const OPERATOR_PRINCIPAL_KINDS: ReadonlySet<WiredCommandKind> = new Set([
  "approval.decide",
  "goal.close",
  "integration.accept_output",
  "session.open",
]);

function decisionOf(
  outcome: ActivationIngressOutcome | RecoveryCompletionOutcome | ReviewOutcome | ServiceOutcome
    | SessionOutcome | WorkClaimOutcome,
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

export interface DaemonCommandPortOptions {
  readonly clock: () => string;
  /** The operator principal id: a session id may not collide with it. */
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface DaemonCommandPorts {
  readonly decisions: CommandDecisionPort;
  readonly registry: CommandRegistry;
}

/**
 * Builds the registry and the durable decision port over one open store. The request the
 * services see is ASSEMBLED here, never copied from the caller: project, principal, kind,
 * schema version and decision time are server facts, and a payload carrying them is
 * refused by the seam's allow-list rather than trusted.
 */
export function createDaemonCommandPorts(options: DaemonCommandPortOptions): DaemonCommandPorts {
  const { clock, operatorPrincipalId, projectId, store } = options;
  if (operatorPrincipalId === NODE_VERIFIER_PRINCIPAL_ID) {
    throw new Error("OPERATOR_PRINCIPAL_RESERVED");
  }
  const authorityClock = (): number => Date.parse(clock());
  const recoveryAuthority = createRecoveryCompletionAuthority({
    clock: authorityClock,
    projectId,
    sessions: createSessionAuthority(store, { clock: authorityClock, projectId }),
  });

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
    projectId,
    schemaVersion,
  }));

  const bootstrapTable: HandlerTable = Object.freeze({
    ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS,
  });

  const entryOf = (kind: WiredCommandKind): CommandRegistryEntry => {
    const activation = kind === EFFECT_ACTIVATE_COMMAND_KIND;
    const recovery = kind === RECOVERY_COMPLETION_COMMAND_KIND;
    const review = kind in REVIEW_FAMILY;
    const session = kind in SESSION_FAMILY;
    const work = kind in WORK_FAMILY;
    const schemaVersion = activation
      ? ACTIVATION_INGRESS_SCHEMA_VERSION
      : recovery
        ? RECOVERY_COMPLETION_SCHEMA_VERSION
        : review
          ? REVIEW_SCHEMA_VERSION
          : session
            ? SESSION_SCHEMA_VERSION
            : work ? WORK_CLAIM_SCHEMA_VERSION : BOOTSTRAP_SCHEMA_VERSION;
    const handler: CommandHandler = ({ envelope, principal }) => {
      if (OPERATOR_PRINCIPAL_KINDS.has(kind)
        && principal.principalId !== operatorPrincipalId) {
        throw new DomainRefusal(
          "OPERATOR_PRINCIPAL_REQUIRED",
          "DAEMON_AUTHORIZATION",
          "this command requires the configured operator principal",
          403,
        );
      }
      const bytes = requestOf(kind, schemaVersion, envelope, principal.principalId);
      if (activation) return decisionOf(runEffectActivateCommand(store, bytes));
      if (recovery) {
        return decisionOf(runRecoveryCompleteCommand(store, bytes, recoveryAuthority));
      }
      if (review) return decisionOf(runReviewCommand(store, bytes));
      if (session) {
        return decisionOf(runSessionCommand(
          store,
          bytes,
          undefined,
          [operatorPrincipalId, NODE_VERIFIER_PRINCIPAL_ID],
        ));
      }
      if (work) return decisionOf(runWorkClaimCommand(store, bytes));
      return decisionOf(runBootstrapCommand(store, bytes, bootstrapTable));
    };
    // ADMIN is the reach fence, NOT the human-only fence. `recovery.complete`
    // is human-only because its concrete session authority authenticates a
    // signed, single-use HUMAN R3 step-up; an AGENT holding ADMIN reaches that
    // gate and is refused there. A reader who mistakes
    // this line for the R3 fence will later weaken the approval check.
    const requiredCapability = activation
      ? CAPABILITIES.WORK
      : recovery
        ? CAPABILITIES.ADMIN
        : review
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
          return refusal(error.code, error.httpStatus, error.detail, error.layer);
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

  return Object.freeze({ decisions, registry });
}
