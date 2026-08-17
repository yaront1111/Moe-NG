import { DurableStoreError, IdempotencyConflictError, type SqliteEventStore } from "@moe/store";
import type { JsonObject } from "@moe/contracts";

import { ACTIVATION_INGRESS_SCHEMA_VERSION, EFFECT_ACTIVATE_COMMAND_KIND }
  from "./activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation/activation-ingress.js";
import { BOOTSTRAP_SCHEMA_VERSION, type BootstrapCommandKind }
  from "./bootstrap/bootstrap-contracts.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap/bootstrap-services.js";
import type { HandlerTable } from "./bootstrap/bootstrap-ledger.js";
import { GOAL_HANDLERS } from "./goals/goal-services.js";
import { SESSION_SCHEMA_VERSION, type SessionCommandKind } from "./identity/session-contracts.js";
import { JOURNAL_APPEND_COMMAND_KIND, JOURNAL_APPEND_SCHEMA_VERSION }
  from "./journal/journal-contracts.js";
import { runJournalAppendCommand } from "./journal/journal-append.js";
import { createSessionAuthority } from "./identity/session-authority.js";
import { runSessionCommand } from "./identity/session-services.js";
import { PLANNING_HANDLERS } from "./planning/planning-services.js";
import { CONTINUATION_COMMAND_KIND, runContinuationCommand }
  from "./recovery/continuation-command.js";
import { RECOVERY_COMPLETION_COMMAND_KIND, RECOVERY_COMPLETION_SCHEMA_VERSION }
  from "./recovery/recovery-completion-digest.js";
import { runRecoveryCompleteCommand } from "./recovery/recovery-completion.js";
import { createRecoveryCompletionAuthority }
  from "./recovery/recovery-completion-authority.js";
import { REVIEW_SCHEMA_VERSION, type ReviewCommandKind } from "./review/review-contracts.js";
import { runReviewCommand } from "./review/review-services.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "./review/verifier-receipt-ledger.js";
import { WORK_CLAIM_SCHEMA_VERSION, type WorkClaimCommandKind }
  from "./work/work-claim-contracts.js";
import { runWorkClaimCommand } from "./work/work-claim-services.js";
import { buildCommandRegistry, type CommandDecisionPort, type CommandHandler,
  type CommandRegistry, type CommandRegistryEntry, type DecisionPortResult }
  from "./http/http-contract.js";
import { DomainRefusal, decisionOf, encoder, refusal } from "./daemon-command-dispatch.js";
import { BOOTSTRAP_FAMILY, CAPABILITIES, OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS,
  REVIEW_FAMILY, SESSION_FAMILY, WORK_FAMILY, type WiredCommandKind }
  from "./daemon-command-vocabulary.js";

/**
 * The daemon's command registry and durable decision port. The command-specific TABLES
 * -- the capability a kind demands, the exact payload keys it admits, the family that
 * answers it and the operator-only set -- live in `./daemon-command-vocabulary.js`;
 * this module composes them into registry entries and turns a family refusal into a
 * port refusal. The HTTP seam reads only the registry, so a command is still added by
 * registering an entry in the vocabulary rather than by editing the boundary or the
 * composition root.
 */

/**
 * Re-exported on their original path: `./daemon-store-dependencies.js` imports
 * `OPERATOR_CAPABILITIES` from here and re-exports `agentCapabilitiesFor` from here,
 * and the orchestrator's agent wrapper has always read the latter through that module.
 * Moving the definitions must not move any consumer's import.
 */
export { OPERATOR_CAPABILITIES, agentCapabilitiesFor } from "./daemon-command-vocabulary.js";



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
    const continuation = kind === CONTINUATION_COMMAND_KIND;
    const journal = kind === JOURNAL_APPEND_COMMAND_KIND;
    const recovery = kind === RECOVERY_COMPLETION_COMMAND_KIND;
    const review = kind in REVIEW_FAMILY;
    const session = kind in SESSION_FAMILY;
    const work = kind in WORK_FAMILY;
    const schemaVersion = activation
      ? ACTIVATION_INGRESS_SCHEMA_VERSION
      : journal
        ? JOURNAL_APPEND_SCHEMA_VERSION
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
      // Its request shape is exact and disjoint from `requestOf`'s envelope
      // record, so it is assembled by its own edge rather than trimmed here.
      if (continuation) {
        const outcome = runContinuationCommand(store, {
          correlationId: envelope.correlationId,
          decidedAt: clock(),
          payload: envelope.payload,
          principalId: principal.principalId,
          projectId,
        });
        if (!outcome.ok) throw new DomainRefusal(outcome.code, outcome.layer, outcome.message);
        return Object.freeze({
          commandId: envelope.commandId,
          disposition: outcome.replayed ? "REPLAYED" : "DECIDED",
          effectId: outcome.bindingRef,
          resultCode: outcome.resultCode,
        });
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
    const requiredCapability = activation || continuation
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
