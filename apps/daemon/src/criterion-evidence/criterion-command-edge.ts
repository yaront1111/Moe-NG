import type { SqliteEventStore } from "@moe/store";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { readCommandTransportOrigin } from "../http/http-adapter.js";
import type { CommandHandlerInput, DurableDecision } from "../http/http-contract.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { CRITERION_APPROVE } from "./criterion-contracts.js";
import type { CriterionCommandInput, CriterionCommandResult } from "./criterion-contracts.js";
import { criterionCatalogId, criterionRunsId } from "./criterion-storage.js";

export interface CriterionCommandPort {
  approve(input: CriterionCommandInput): CriterionCommandResult;
  verify(input: CriterionCommandInput): CriterionCommandResult;
}
export function runCriterionCommandEdge(store: SqliteEventStore, input: CommandHandlerInput,
  port: CriterionCommandPort | undefined,
): DurableDecision {
  const { envelope, principal } = input;
  if (!isDurableHumanPrincipal(store, principal.principalId)) {
    throw new DomainRefusal("CRITERION_CHECK_HUMAN_REQUIRED", "CRITERION_EVIDENCE", "a durable human principal is required", 403);
  }
  const origin = readCommandTransportOrigin(input);
  if (origin === "MCP_HTTP" || origin === "MCP_STDIO" || origin === "AGENT_WRAPPER") {
    throw new DomainRefusal("CRITERION_CHECK_TRANSPORT_DENIED", "CRITERION_EVIDENCE", "criterion approval is an operator action", 403);
  }
  if (port === undefined) throw new DomainRefusal("CRITERION_CHECK_UNCONFIGURED", "CRITERION_EVIDENCE", "criterion evidence is not configured");
  const { goalRef, planningRunRef } = envelope.payload;
  if (typeof goalRef === "string" && typeof planningRunRef === "string") {
    const target = (envelope.commandKind === CRITERION_APPROVE ? criterionCatalogId : criterionRunsId)(principal.projectId, goalRef, planningRunRef);
    if (envelope.targetAggregateId !== target) throw new DomainRefusal(
      "CRITERION_CHECK_TARGET_MISMATCH", "CRITERION_EVIDENCE", "criterion command target does not match its bound scope");
  }
  const request: CriterionCommandInput = { commandId: envelope.commandId, correlationId: envelope.correlationId,
    expectedVersion: envelope.expectedVersion, principalId: principal.principalId, payload: envelope.payload };
  const result = envelope.commandKind === CRITERION_APPROVE ? port.approve(request) : port.verify(request);
  if (!result.ok) throw new DomainRefusal(result.code, result.layer, result.code);
  return { commandId: result.commandId, disposition: result.disposition, effectId: null, resultCode: result.resultCode };
}
