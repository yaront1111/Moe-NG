import { identifyReplayRequest } from "@moe/store";
import type { ExpectedVersionDecisionLeg, SqliteEventStore, StoredEvent } from "@moe/store";
import { criterionBytes, criterionHash } from "./criterion-codec.js";
import { CRITERION_APPROVE, CRITERION_PRINCIPAL, CRITERION_VERIFY, criterionRefused } from "./criterion-contracts.js";
import type { CriterionCommandInput, CriterionCommandResult } from "./criterion-contracts.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";

const scope = (projectId: string, goalRef: string, runId: string): string => criterionHash([projectId, goalRef, runId]);
export const criterionCatalogId = (projectId: string, goalRef: string, runId: string): string =>
  `compiled-criterion-catalog/${scope(projectId, goalRef, runId)}`;
export const criterionRunsId = (projectId: string, goalRef: string, runId: string): string =>
  `compiled-criterion-runs/${scope(projectId, goalRef, runId)}`;
export const criterionReceiptId = (runRef: string, criterionId: string): string => `criterion-receipt/${criterionHash([runRef, criterionId])}`;
const requestBytes = (kind: string, input: CriterionCommandInput): Uint8Array => criterionBytes({
  kind, commandId: input.commandId, correlationId: input.correlationId, expectedVersion: input.expectedVersion,
  principalId: input.principalId, payload: input.payload,
});
export function criterionReplay(store: SqliteEventStore, projectId: string, kind: string, input: CriterionCommandInput): CriterionCommandResult | null {
  const decision = store.getCommandDecision({ projectId, principalId: input.principalId, commandId: input.commandId });
  if (decision === null) return null;
  if (decision.commandKind !== kind || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || identifyReplayRequest(decision, requestBytes(kind, input)) !== decision.replayRequestSha256) {
    return criterionRefused("CRITERION_CHECK_REPLAY_CONFLICT");
  }
  return { ok: true, commandId: input.commandId, disposition: "REPLAYED", resultCode: kind === CRITERION_APPROVE ? "CRITERION_CHECK_APPROVED" : "CRITERION_CHECK_QUEUED" };
}
export function commitCriterionRecord(store: SqliteEventStore, projectId: string, kind: string,
  input: CriterionCommandInput, targetAggregateId: string, eventType: string, record: unknown, decidedAt: string,
  extraLegs: readonly ExpectedVersionDecisionLeg[] = [],
): CriterionCommandResult {
  const bytes = criterionBytes(record);
  const base = { commandKind: kind,
    committedResultBytes: bytes, correlationId: input.correlationId, decidedAt,
    key: { projectId, principalId: input.principalId, commandId: input.commandId }, requestBytes: requestBytes(kind, input) };
  const events = [{ eventId: `${input.commandId}-${eventType}`, eventType, payload: bytes }];
  const committed = extraLegs.length === 0 ? store.commitExpectedVersionDecision({ ...base,
    events, expectedVersion: input.expectedVersion, targetAggregateId,
  }) : store.commitExpectedVersionDecisionLegs({ ...base,
    legs: [{ aggregateId: targetAggregateId, events, expectedVersion: input.expectedVersion }, ...extraLegs] });
  return committed.decision.effectDisposition !== "EFFECTS_COMMITTED" ? criterionRefused("CRITERION_CHECK_VERSION_CONFLICT")
    : { ok: true, commandId: input.commandId, disposition: committed.disposition,
      resultCode: kind === CRITERION_APPROVE ? "CRITERION_CHECK_APPROVED" : "CRITERION_CHECK_QUEUED" };
}
export interface CriterionStored { readonly event: StoredEvent; readonly value: unknown; }
/** Every row must re-prove its originating committed decision, including service-only writers. */
export function readCriterionRecords(store: SqliteEventStore, projectId: string, aggregateId: string): readonly CriterionStored[] | null {
  try {
    const page = store.readAggregateEvents(aggregateId, 0, 1000);
    if (page.hasMore) return null;
    const records: CriterionStored[] = [];
    for (const event of page.items) {
      const trace = event.decisionTrace;
      if (trace === undefined || trace.projectId !== projectId) return null;
      const decision = store.getCommandDecision({ projectId, principalId: trace.principalId, commandId: trace.commandId });
      if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED" || decision.targetAggregateId !== aggregateId
        || decision.commandKind !== trace.commandKind || decision.requestSha256 !== trace.requestSha256
        || !Buffer.from(event.payload).equals(Buffer.from(decision.resultBytes))) return null;
      if (trace.commandKind === CRITERION_APPROVE || trace.commandKind === CRITERION_VERIFY) {
        if (!isDurableHumanPrincipal(store, trace.principalId)) return null;
      } else if (!trace.commandKind.startsWith("internal.criterion.") || trace.principalId !== CRITERION_PRINCIPAL) return null;
      records.push({ event, value: JSON.parse(Buffer.from(event.payload).toString("utf8")) });
    }
    return records;
  } catch { return null; }
}
