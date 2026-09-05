import type { SqliteEventStore } from "@moe/store";
import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { PLANNING_HANDLERS } from "./planning-services.js";
import type { CompiledContractBinding } from "./compiled-contract-binding.js";
import type { SubmitDecompositionInput } from "./compile-dispatcher.js";

export function dispatchCompiledPlanning(
  store: SqliteEventStore, input: SubmitDecompositionInput, commandId: string, runId: string,
  commands: readonly Record<string, unknown>[], compiledContractBinding?: CompiledContractBinding,
): ReturnType<typeof runBootstrapCommand> {
  return runBootstrapCommand(store, new TextEncoder().encode(JSON.stringify({
    commandId, correlationId: input.correlationId, decidedAt: input.decidedAt,
    expectedVersion: 0, kind: "plan.propose", payload: { commands, runId },
    principalId: input.principalId, projectId: input.projectId, schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  })), { ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS,
    "plan.propose": (context) => PLANNING_HANDLERS["plan.propose"]!({ ...context,
      ...(compiledContractBinding === undefined ? {} : { compiledContractBinding }),
    }),
  });
}
