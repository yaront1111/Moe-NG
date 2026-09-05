import type { SqliteEventStore } from "@moe/store";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { readCommandTransportOrigin } from "../http/http-adapter.js";
import type { CommandRegistryEntry, CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { foundationSyncHandler } from "../daemon-foundation-command.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
export interface RepositoryRecoveryCommandPort {
  recover(input: { readonly principalId: string; readonly operatorPrincipalId: string; readonly commandId: string;
    readonly correlationId: string; readonly expectedVersion: number; readonly targetAggregateId: string; readonly payload: unknown }):
    Promise<RepositoryRecoveryResult<{ readonly commandId: string; readonly disposition: "COMMITTED" | "REPLAYED"; readonly resultCode: "REPOSITORY_RECOVERY_RELEASED" }>>;
}
export function createRepositoryRecoveryCommandEntry(options: { readonly store: SqliteEventStore;
  readonly projectId: string; readonly operatorPrincipalId: string; readonly port: RepositoryRecoveryCommandPort | undefined;
  readonly assertAuthority: () => void }): CommandRegistryEntry {
  const refuse = (code: string, status = 422): never => { throw new DomainRefusal(code, "REPOSITORY_RECOVERY", code, status); };
  return Object.freeze({ kind: "repository.recover", requiredCapability: "project.admin",
    payloadKeys: ["action", "decision", "expectedReservationRevision", "nodeRef", "reason"], handler: foundationSyncHandler,
    asyncHandler: async (input: CommandHandlerInput): Promise<DurableDecision> => {
      options.assertAuthority();
      if (input.principal.projectId !== options.projectId) return refuse("REPOSITORY_RECOVERY_PROJECT_MISMATCH", 403);
      if (!isDurableHumanPrincipal(options.store, input.principal.principalId)) return refuse("REPOSITORY_RECOVERY_HUMAN_REQUIRED", 403);
      const origin = readCommandTransportOrigin(input);
      if (origin === "MCP_HTTP" || origin === "MCP_STDIO" || origin === "AGENT_WRAPPER" || origin === "NODE_VERIFIER") return refuse("REPOSITORY_RECOVERY_TRANSPORT_DENIED", 403);
      if (options.port === undefined) return refuse("REPOSITORY_RECOVERY_UNCONFIGURED");
      const { envelope } = input;
      const result = await options.port.recover({ principalId: input.principal.principalId, operatorPrincipalId: options.operatorPrincipalId,
        commandId: envelope.commandId, correlationId: envelope.correlationId, expectedVersion: envelope.expectedVersion,
        targetAggregateId: envelope.targetAggregateId, payload: envelope.payload });
      if (!result.ok) throw new DomainRefusal(result.code, result.layer, result.detail);
      return { commandId: result.commandId, disposition: result.disposition === "COMMITTED" ? "DECIDED" : "REPLAYED", effectId: null, resultCode: result.resultCode };
    },
  });
}
