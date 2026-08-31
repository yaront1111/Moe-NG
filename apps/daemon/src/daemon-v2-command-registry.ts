/**
 * The `/2` command table. It is deliberately separate from the v1 registry even where
 * the public intent spelling is shared: transport version chooses the authority plane,
 * and the `/2` handler cannot run until the durable cutover marker binds current readiness.
 */
import type { SqliteEventStore } from "@moe/store";

import { admitV2AuthoritativeCommand } from "./cutover/cutover-v2-authority.js";
import { CAPABILITIES } from "./daemon-command-vocabulary.js";
import { createCommandDecisionPort } from "./daemon-command-decision-port.js";
import { DomainRefusal } from "./daemon-command-dispatch.js";
import {
  buildCommandRegistry,
  type CommandDecisionPort,
  type CommandHandler,
  type CommandRegistry,
} from "./http/http-contract.js";
import {
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
  runProductContractProposeRevisionV2,
} from "./product-contract/product-contract-v2-propose-service.js";

export interface DaemonV2CommandPortOptions {
  readonly clock: () => string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface DaemonV2CommandPorts {
  readonly decisions: CommandDecisionPort;
  readonly registry: CommandRegistry;
}

export function createDaemonV2CommandPorts(
  options: DaemonV2CommandPortOptions,
): DaemonV2CommandPorts {
  const handler: CommandHandler = ({ envelope, principal }) => {
    const authority = admitV2AuthoritativeCommand(options.store, {
      commandKind: envelope.commandKind,
      projectId: options.projectId,
    });
    if (!authority.ok) {
      throw new DomainRefusal(authority.code, authority.layer, authority.code);
    }

    const outcome = runProductContractProposeRevisionV2(options.store, {
      correlationId: envelope.correlationId,
      decidedAt: options.clock(),
      payload: envelope.payload,
      principalId: principal.principalId,
      projectId: options.projectId,
      targetAggregateId: envelope.targetAggregateId,
    });
    if (!outcome.ok) throw new DomainRefusal(outcome.code, outcome.layer, outcome.code);
    return Object.freeze({
      commandId: envelope.commandId,
      disposition: outcome.disposition,
      effectId: outcome.revision.revisionDigest,
      resultCode: "PRODUCT_CONTRACT_REVISION_V2",
    });
  };

  return Object.freeze({
    decisions: createCommandDecisionPort(),
    registry: buildCommandRegistry([Object.freeze({
      handler,
      kind: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_COMMAND_KIND,
      payloadKeys: PRODUCT_CONTRACT_PROPOSE_REVISION_V2_PAYLOAD_KEYS,
      requiredCapability: CAPABILITIES.PLANNING,
    })]),
  });
}
