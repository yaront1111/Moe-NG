import type { SqliteEventStore } from "@moe/store";
import type { JsonObject } from "@moe/contracts";

import { runEffectActivateCommand } from "./activation/activation-ingress.js";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "./bootstrap/bootstrap-services.js";
import { humanReviewWitness, type HandlerTable } from "./bootstrap/bootstrap-ledger.js";
import { GOAL_HANDLERS } from "./goals/goal-services.js";
import { runJournalAppendCommand } from "./journal/journal-append.js";
import { createSessionAuthority } from "./identity/session-authority.js";
import { runSessionCommand } from "./identity/session-services.js";
import { PLANNING_HANDLERS } from "./planning/planning-services.js";
import { createProductContractGate1Authority, runProductContractGate1Command }
  from "./product-contract/product-contract-gate-1-command.js";
import { runRecoveryCompleteCommand } from "./recovery/recovery-completion.js";
import { createRecoveryCompletionAuthority }
  from "./recovery/recovery-completion-authority.js";
import { runReviewCommand } from "./review/review-services.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "./review/verifier-receipt-ledger.js";
import type { FoundationCaptureLifecycle } from "./work/foundation-capture-lifecycle.js";
import type { FoundationContextSealPort } from "./work/foundation-context-record.js";
import { runStepLifecycleCommand } from "./work/step-lifecycle-command.js";
import { runWorkClaimCommand } from "./work/work-claim-services.js";
import { buildCommandRegistry, type CommandDecisionPort, type CommandHandler,
  type CommandRegistry, type CommandRegistryEntry }
  from "./http/http-contract.js";
import { DomainRefusal, decisionOf, encoder } from "./daemon-command-dispatch.js";
import { OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS, type GraphMutationCommandKind,
  type WiredCommandKind } from "./daemon-command-vocabulary.js";
import { createAsyncCommandEntries } from "./daemon-command-async-entries.js";
import { createCommandDecisionPort } from "./daemon-command-decision-port.js";
import {
  runContinuationEdge, runEventResumeEdge, runResourceConfirmReleasedEdge,
  runApprovalIntentEdge, runResourceReconcileEdge, type CommandEdgeContext,
} from "./daemon-command-edges.js";
import { commandFamilyFacts } from "./daemon-command-families.js";
import { runGraphEdge } from "./daemon-command-graph-edges.js";

/**
 * The daemon's command registry. The command-specific TABLES -- the capability a kind
 * demands, the exact payload keys it admits, the family that answers it and the
 * operator-only set -- live in `./daemon-command-vocabulary.js`; the classification those
 * tables imply lives in `./daemon-command-families.js`; the commands assembled at their
 * own edge live in `./daemon-command-edges.js`; the async entries live in
 * `./daemon-command-async-entries.js`; and the durable decision port lives in
 * `./daemon-command-decision-port.js`. This module only COMPOSES them into registry
 * entries. The five graph MUTATION kinds are assembled and delegated by
 * `./daemon-command-graph-edges.js`. The HTTP seam reads only the registry, so a command is
 * still added by registering an entry in the vocabulary rather than by editing the boundary or
 * the composition root.
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
  /** Daemon-owned event reader bound to authenticated WORK principals. An absent
   *  binding leaves events.resume registered but fail-closed. */
  readonly eventSubscriberId?: string;
  /** The prepare-before-launch workspace authority. OPTIONAL, and its absence is
   *  a refusing state rather than a skipped one: an unsupplied lifecycle becomes
   *  one with no configured catalog, so Foundation preparation refuses and no
   *  provider process starts. */
  /** The daemon-startup workspace catalog, shared with the capture lifecycle so the
   *  dispatch-time derivation resolves the SAME repository scope authority. */
  readonly foundationCatalogSource?: () => unknown;
  readonly foundationContextSeal?: FoundationContextSealPort;
  readonly foundationLifecycle?: FoundationCaptureLifecycle;
  /** The operator principal id: a session id may not collide with it. */
  readonly operatorPrincipalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  /** The daemon-startup VERIFICATION catalog: the host-scoped argv authority the
   *  recipe seal derives its command from. OPTIONAL on the same terms as the
   *  workspace catalog above — an unsupplied source is a refusing state, not a
   *  skipped one, so sealing refuses and no unconfigured command is ever run. */
  readonly verificationCatalogSource?: () => unknown;
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
  // ONE session authority, shared. It is a stateless facade over the same store, so a
  // second instance would only give two readers of one aggregate the chance to drift.
  const sessions = createSessionAuthority(store, { clock: authorityClock, projectId });
  const recoveryAuthority = createRecoveryCompletionAuthority({
    clock: authorityClock,
    projectId,
    sessions,
  });
  // Takes NO clock: the only moment a Gate 1 grant carries is the `decidedAt`
  // `requestOf` stamps below, so the authority cannot read one even by accident.
  const gate1Authority = createProductContractGate1Authority({ projectId, sessions, store });

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

  const asyncEntries: Partial<Record<WiredCommandKind, CommandRegistryEntry>> =
    createAsyncCommandEntries({
      projectId, store,
      ...(options.foundationCatalogSource === undefined
        ? {} : { foundationCatalogSource: options.foundationCatalogSource }),
      ...(options.foundationContextSeal === undefined
        ? {} : { foundationContextSeal: options.foundationContextSeal }),
      ...(options.foundationLifecycle === undefined
        ? {} : { foundationLifecycle: options.foundationLifecycle }),
      ...(options.verificationCatalogSource === undefined
        ? {} : { verificationCatalogSource: options.verificationCatalogSource }),
    });

  const entryOf = (kind: WiredCommandKind): CommandRegistryEntry => {
    // Answered first and returned whole: these kinds' services are asynchronous, so each
    // carries an async handler and none of the synchronous wiring below applies to it. The
    // sync handler they share refuses; the seam refuses above it before it can be called.
    const asyncEntry = asyncEntries[kind];
    if (asyncEntry !== undefined) return asyncEntry;
    const { activation, approvalIntent, confirmReleased, continuation, eventResume, graph,
      journal, productContractGate1, reconcile, recovery, requiredCapability, review,
      schemaVersion, session, step, work } = commandFamilyFacts(kind);
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
      // goal.create carried a `goalId` comparison here while the payload could still name one.
      // It cannot: the kind's allow-list is prose only, so `prepareCommand` refuses `goalId`
      // INPUT_INVALID at PAYLOAD_SHAPE in BOTH entries before any dispatch, and the goal
      // aggregate is derived from the authenticated command identity inside the handler. The
      // comparison was therefore unreachable, and unreachable ingress code with an assertion
      // that can never red is worse than none.
      // The five graph MUTATION kinds. Each is answered by its OWN durable planning service, so
      // none of them is a `BootstrapCommandKind` and none reaches `runBootstrapCommand` below;
      // the service's code and layer travel back unrestamped. The witness is minted on exactly
      // the same terms as the bootstrap path's, and for `graph.approve` and `graph.supersede`
      // the OPERATOR_PRINCIPAL_KINDS check above has already refused every non-operator.
      //
      // WHY THE WITNESS IS TRUSTWORTHY, and what it depends on (task-4c9b1d85, ruling
      // comment-4d026de3fc24449d927f9eee28da6114). `humanReview` is minted on operator
      // PRINCIPAL IDENTITY alone and is trustworthy as a human-act witness for
      // `approval.decide` and `graph.approve` BECAUSE neither kind is reachable over MCP --
      // the daemon's MCP roster excludes both (`mcp-tool-allowlist.ts`,
      // `MCP_EXCLUDED_COMMAND_KINDS`) and the transport refuses CAPABILITY_DENIED before
      // authentication; re-admitting either kind to that roster invalidates this contract
      // and requires a server-set transport-origin field first.
      //
      // Concretely, this mint carries NO transport fact. `mcp-dispatch-port.ts` authenticates
      // with the operator bootstrap credential as `fallbackCredential` (`mcp-main.ts:112-127`),
      // so an MCP caller holding that credential would authenticate AS the operator here and
      // receive a witness indistinguishable from a browser operator's. The roster exclusion,
      // not this comparison, is what keeps that call from ever arriving.
      if (graph) {
        return runGraphEdge({
          clock,
          envelope,
          humanReview: principal.principalId === operatorPrincipalId
            ? humanReviewWitness(principal.principalId, envelope.commandId)
            : undefined,
          kind: kind as GraphMutationCommandKind,
          principalId: principal.principalId,
          projectId,
          store,
        });
      }
      // The kinds whose request shape is exact and disjoint from `requestOf`'s envelope
      // record are assembled by their own edge rather than trimmed here.
      if (approvalIntent || continuation || eventResume || reconcile || confirmReleased) {
        const context: CommandEdgeContext = {
          decidedAt: clock(),
          envelope,
          eventSubscriberId: options.eventSubscriberId,
          operatorPrincipalId,
          principal,
          projectId,
          store,
        };
        if (approvalIntent) return runApprovalIntentEdge(context);
        if (continuation) return runContinuationEdge(context);
        if (eventResume) return runEventResumeEdge(context);
        if (reconcile) return runResourceReconcileEdge(context);
        return runResourceConfirmReleasedEdge(context);
      }
      const bytes = requestOf(kind, schemaVersion, envelope, principal.principalId);
      if (activation) return decisionOf(runEffectActivateCommand(store, bytes));
      if (journal) return decisionOf(runJournalAppendCommand(store, bytes));
      if (productContractGate1) {
        // This witness is the ingress-authenticated principal (a paired session's id),
        // assembled here like humanReview and never read from the command payload.
        return decisionOf(runProductContractGate1Command(
          store, bytes, gate1Authority, Object.freeze({ sessionId: principal.principalId }),
        ));
      }
      if (recovery) {
        return decisionOf(runRecoveryCompleteCommand(store, bytes, recoveryAuthority));
      }
      if (review) return decisionOf(runReviewCommand(store, bytes));
      if (step) return decisionOf(runStepLifecycleCommand(store, bytes));
      if (session) {
        return decisionOf(runSessionCommand(
          store,
          bytes,
          undefined,
          [operatorPrincipalId, NODE_VERIFIER_PRINCIPAL_ID],
        ));
      }
      if (work) return decisionOf(runWorkClaimCommand(store, bytes));
      // The human-review witness is minted HERE and only here, because this is
      // the one seam that holds both the AUTHENTICATED principal and the
      // configured operator. The operator credential is the human seat — the
      // same identity OPERATOR_PRINCIPAL_KINDS reserves approval.decide for —
      // so an operator-authenticated dispatch carries the witness and a scoped
      // agent session never does, whatever its capabilities say.
      return decisionOf(runBootstrapCommand(
        store,
        bytes,
        bootstrapTable,
        principal.principalId === operatorPrincipalId
          ? humanReviewWitness(principal.principalId, envelope.commandId)
          : undefined,
      ));
    };
    return Object.freeze({
      handler, kind, payloadKeys: PAYLOAD_KEYS[kind], requiredCapability,
    });
  };

  const registry = buildCommandRegistry(
    (Object.keys(PAYLOAD_KEYS) as readonly WiredCommandKind[]).map(entryOf),
  );

  return Object.freeze({ decisions: createCommandDecisionPort(), registry });
}
