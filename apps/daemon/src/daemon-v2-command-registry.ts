/**
 * The `/2` command table. It is deliberately separate from the v1 registry even where
 * the public intent spelling is shared: transport version chooses the authority plane,
 * and the `/2` handler cannot run until the durable cutover marker binds current readiness.
 */
import type { JsonObject, RuntimeCommandKind } from "@moe/contracts";

import { admitV2AuthoritativeCommand } from "./cutover/cutover-v2-authority.js";
import {
  createDaemonCommandPorts,
  type DaemonCommandPortOptions,
} from "./daemon-command-registry.js";
import { commandFamilyFacts } from "./daemon-command-families.js";
import type { WiredCommandKind } from "./daemon-command-vocabulary.js";
import { DomainRefusal, decisionOf, domainRefusalOf } from "./daemon-command-dispatch.js";
import { isDurableHumanPrincipal } from "./identity/human-approver.js";
import { createSessionAuthority } from "./identity/session-authority.js";
import { readCommandTransportOrigin } from "./http/http-adapter.js";
import {
  buildCommandRegistry,
  type CommandDecisionPort,
  type CommandHandler,
  type CommandRegistry,
} from "./http/http-contract.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
  PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_PAYLOAD_KEYS,
  runAnswerProductContractClarificationV2,
  runAskProductContractClarificationV2,
} from "./product-contract/product-contract-v2-clarification-service.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
  PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
} from "./product-contract/product-contract-gate-1-contract.js";
import {
  createProductContractGate1Authority,
} from "./product-contract/product-contract-gate-1-command.js";
import { runProductContractGate1V2Command }
  from "./product-contract/product-contract-v2-gate-1-command.js";
import {
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
  runProductContractProposeRevisionV2,
} from "./product-contract/product-contract-v2-propose-service.js";

export type DaemonV2CommandPortOptions = DaemonCommandPortOptions;

export interface DaemonV2CommandPorts {
  readonly decisions: CommandDecisionPort;
  readonly registry: CommandRegistry;
}

export function createDaemonV2CommandPorts(
  options: DaemonV2CommandPortOptions,
): DaemonV2CommandPorts {
  // Read every injected dependency once. The command plane must not be
  // retargetable after construction through getters or a mutable options bag.
  const clock = options.clock;
  const deploymentDeploy = options.deploymentDeploy;
  const cutoverActivation = options.cutoverActivation;
  const eventSubscriberId = options.eventSubscriberId;
  const foundationCatalogSource = options.foundationCatalogSource;
  const foundationContextSeal = options.foundationContextSeal;
  const foundationLifecycle = options.foundationLifecycle;
  const operatorPrincipalId = options.operatorPrincipalId;
  const projectId = options.projectId;
  const store = options.store;
  const releaseDecide = options.releaseDecide;
  const verificationCatalogSource = options.verificationCatalogSource;
  const shared = createDaemonCommandPorts({
    authorityPlane: "V2", clock, operatorPrincipalId, projectId, store,
    ...(releaseDecide === undefined ? {} : { releaseDecide }),
    ...(deploymentDeploy === undefined ? {} : { deploymentDeploy }),
    ...(cutoverActivation === undefined ? {} : { cutoverActivation }),
    ...(eventSubscriberId === undefined ? {} : { eventSubscriberId }),
    ...(foundationCatalogSource === undefined ? {} : { foundationCatalogSource }),
    ...(foundationContextSeal === undefined ? {} : { foundationContextSeal }),
    ...(foundationLifecycle === undefined ? {} : { foundationLifecycle }),
    ...(verificationCatalogSource === undefined ? {} : { verificationCatalogSource }),
  });
  const encoder = new TextEncoder();
  const sessions = createSessionAuthority(store, {
    clock: () => Date.parse(clock()), projectId,
  });
  const gate1 = createProductContractGate1Authority({
    projectId, sessions, store,
  });
  const gate1Request = (
    envelope: Readonly<{
      commandId: string; correlationId: string; expectedVersion: number; payload: JsonObject;
    }>,
    principalId: string,
    decidedAt: string,
  ): Uint8Array => encoder.encode(JSON.stringify({
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    decidedAt,
    expectedVersion: envelope.expectedVersion,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: envelope.payload,
    principalId,
    projectId,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  }));

  const handlerFor = (kind: RuntimeCommandKind): CommandHandler => (input) => {
    const { envelope, principal } = input;
    if (envelope.commandKind !== kind) {
      throw new DomainRefusal(
        "CUTOVER_V2_COMMAND_UNKNOWN", "DAEMON_CUTOVER_V2_AUTHORITY", envelope.commandKind,
      );
    }
    const authority = admitV2AuthoritativeCommand(store, {
      commandKind: kind,
      projectId,
    });
    if (!authority.ok) {
      throw domainRefusalOf(authority);
    }

    const decidedAt = clock();
    if (kind === PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND) {
      const outcome = runProductContractProposeRevisionV2(store, {
        commandId: envelope.commandId, correlationId: envelope.correlationId,
        decidedAt, payload: envelope.payload,
        principalId: principal.principalId, projectId,
        targetAggregateId: envelope.targetAggregateId,
      });
      if (!outcome.ok) throw domainRefusalOf(outcome);
      return Object.freeze({
        commandId: envelope.commandId, disposition: outcome.disposition,
        effectId: outcome.revision.revisionDigest, resultCode: "PRODUCT_CONTRACT_REVISION_V2",
      });
    }
    if (kind === PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND
      || kind === PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND) {
      if (kind === PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND
        && principal.principalId !== operatorPrincipalId
        && !isDurableHumanPrincipal(store, principal.principalId)) {
        throw new DomainRefusal(
          "OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION",
          "this command requires the configured operator or a paired durable human principal", 403,
        );
      }
      const outcome = kind === PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND
        ? runAskProductContractClarificationV2(store, {
          commandId: envelope.commandId, correlationId: envelope.correlationId,
          decidedAt, payload: envelope.payload,
          principalId: principal.principalId, projectId,
          targetAggregateId: envelope.targetAggregateId,
        })
        : runAnswerProductContractClarificationV2(store, {
          commandId: envelope.commandId, correlationId: envelope.correlationId,
          decidedAt, payload: envelope.payload,
          principalId: principal.principalId, projectId,
          targetAggregateId: envelope.targetAggregateId,
        });
      if (!outcome.ok) throw domainRefusalOf(outcome);
      return Object.freeze({
        commandId: envelope.commandId, disposition: outcome.disposition,
        effectId: outcome.clarificationId,
        resultCode: kind === PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND
          ? "PRODUCT_CONTRACT_CLARIFICATION"
          : "PRODUCT_CONTRACT_CLARIFICATION_ANSWERED",
      });
    }
    if (kind === PRODUCT_CONTRACT_GATE_1_COMMAND_KIND) {
      return decisionOf(runProductContractGate1V2Command(
        store,
        gate1Request(envelope, principal.principalId, decidedAt),
        gate1,
        Object.freeze({
          sessionId: principal.principalId,
          transportOrigin: readCommandTransportOrigin(input),
        }),
      ));
    }
    throw new DomainRefusal(
      "CUTOVER_V2_COMMAND_UNKNOWN", "DAEMON_CUTOVER_V2_AUTHORITY", kind,
    );
  };

  const entry = (
    kind: WiredCommandKind,
    payloadKeys: readonly string[],
  ) => Object.freeze({
    handler: handlerFor(kind),
    kind,
    payloadKeys,
    requiredCapability: commandFamilyFacts(kind).requiredCapability,
  });

  const overrides = [
      entry(
        PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_COMMAND_KIND,
        PRODUCT_CONTRACT_CLARIFICATION_V2_ANSWER_PAYLOAD_KEYS,
      ),
      entry(PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_PAYLOAD_KEYS),
      entry(
        PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_COMMAND_KIND,
        PRODUCT_CONTRACT_CLARIFICATION_V2_ASK_PAYLOAD_KEYS,
      ),
      entry(
        PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
        PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
      ),
    ];
  const overridden = new Set<RuntimeCommandKind>(overrides.map(({ kind }) => kind));
  // `planning.submit_decomposition` deliberately remains absent until its `/2`
  // service consumes the authority-safe compiler. Falling back to the v1 compiler
  // under an active marker would be worse than an exact, visible roster failure.
  const withheld = new Set<RuntimeCommandKind>(["planning.submit_decomposition"]);
  return Object.freeze({
    decisions: shared.decisions,
    registry: buildCommandRegistry([
      ...[...shared.registry.values()].filter(
        ({ kind }) => !overridden.has(kind) && !withheld.has(kind),
      ),
      ...overrides,
    ]),
  });
}
