import type { ExpectedVersionDecisionLeg } from "@moe/store";
import type { HandlerContext } from "../bootstrap/bootstrap-ledger.js";
import { compiledContractAggregateId, compiledContractBytes, decodeCompiledContractBinding } from "./compiled-contract-binding.js";

/** Only the compiler injects this context member; command payloads never populate it. */
export function compiledContractBindingLeg(
  context: HandlerContext, runId: string, goalRef: string, submissionHash: string,
): Readonly<{ ok: true; legs: readonly ExpectedVersionDecisionLeg[] }>
  | Readonly<{ ok: false; code: "COMPILED_CONTRACT_BINDING_INVALID" }> {
  const binding = context.compiledContractBinding;
  if (binding === undefined) return { ok: true, legs: [] };
  if (decodeCompiledContractBinding(compiledContractBytes(binding)) === null
    || binding.projectId !== context.request.projectId || binding.planningRunRef !== runId
    || binding.goalRef !== goalRef || binding.submissionHash !== submissionHash) {
    return { ok: false, code: "COMPILED_CONTRACT_BINDING_INVALID" };
  }
  const aggregateId = compiledContractAggregateId(binding.projectId, runId);
  return { ok: true, legs: [{ aggregateId, expectedVersion: 0, events: [{
    eventId: `${aggregateId}-bound`, eventType: "CompiledContractBound", payload: compiledContractBytes(binding),
  }] }] };
}
