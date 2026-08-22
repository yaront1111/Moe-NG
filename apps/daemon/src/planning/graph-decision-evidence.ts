/**
 * Verifies the durable decision and effect receipt behind graph-revision events.
 * The graph reducer owns lifecycle meaning; this seam only proves that traced
 * event bytes still belong to the decision and receipt that committed them.
 * Legacy direct commits have no decision trace and remain readable, but once a
 * trace exists it is evidence, not decoration: missing, unreadable, or
 * disagreeing evidence fails closed.
 */
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  CommandReceipt,
  StoredEvent,
} from "@moe/store";

const EVIDENCE_LAYER = "GRAPH_DECISION_EVIDENCE" as const;
export type GraphDecisionEvidenceCode = "GRAPH_DECISION_EVIDENCE_UNVERIFIABLE";

export interface GraphDecisionEvidenceStore {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
}

export type GraphDecisionEvidenceResult = Readonly<{ readonly ok: true }> | Readonly<{
  readonly code: GraphDecisionEvidenceCode;
  readonly layer: typeof EVIDENCE_LAYER;
  readonly ok: false;
}>;

type Trace = NonNullable<StoredEvent["decisionTrace"]>;
type Loaded = Readonly<{ decision: CommandDecisionRecord; receipt: CommandReceipt }>;

const accepted: GraphDecisionEvidenceResult = Object.freeze({ ok: true as const });
const REFUSAL: GraphDecisionEvidenceResult = Object.freeze({
  code: "GRAPH_DECISION_EVIDENCE_UNVERIFIABLE" as const,
  layer: EVIDENCE_LAYER,
  ok: false as const,
});

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameTrace(left: Trace, right: Trace): boolean {
  return left.commandId === right.commandId && left.commandKind === right.commandKind &&
    left.principalId === right.principalId && left.projectId === right.projectId &&
    left.requestIdentityVersion === right.requestIdentityVersion &&
    left.requestSha256 === right.requestSha256;
}

function loadEvidence(
  store: GraphDecisionEvidenceStore,
  event: StoredEvent,
  trace: Trace,
): GraphDecisionEvidenceResult | Loaded {
  try {
    const decision = store.getCommandDecision({
      commandId: trace.commandId, principalId: trace.principalId, projectId: trace.projectId,
    });
    const receipt = store.getCommandReceipt(event.commandId);
    if (decision === null || receipt === null) return REFUSAL;
    return { decision, receipt };
  } catch {
    return REFUSAL;
  }
}

function groupAgrees(
  events: readonly StoredEvent[],
  trace: Trace,
  decision: CommandDecisionRecord,
  receipt: CommandReceipt,
  projectId: string,
): boolean {
  const first = events[0];
  if (first === undefined || decision.effectDisposition !== "EFFECTS_COMMITTED") return false;
  const eventIds = events.map((event) => event.eventId);
  return trace.projectId === projectId && decision.commandKind === trace.commandKind &&
    decision.key.commandId === trace.commandId && decision.key.principalId === trace.principalId &&
    decision.key.projectId === projectId && decision.requestSha256 === trace.requestSha256 &&
    decision.requestIdentityVersion === trace.requestIdentityVersion &&
    decision.targetAggregateId === first.aggregateId &&
    decision.expectedVersion === receipt.previousVersion &&
    decision.observedVersion === receipt.previousVersion &&
    decision.previousVersion === receipt.previousVersion &&
    decision.currentVersion === receipt.currentVersion &&
    decision.effectSha256 === receipt.effectSha256 &&
    decision.effectIdentityVersion === receipt.effectIdentityVersion &&
    sameStrings(decision.businessEventIds, eventIds) &&
    sameStrings(decision.outboxMessageIds, receipt.outboxMessageIds) &&
    sameStrings(receipt.eventIds, eventIds) && events.every((event, index) =>
      event.aggregateId === first.aggregateId && event.commandId === receipt.commandId &&
      event.aggregateSequence === receipt.previousVersion + index + 1 &&
      event.committedAt === receipt.committedAt && event.requestSha256 === receipt.requestSha256 &&
      event.decisionTrace !== undefined && sameTrace(event.decisionTrace, trace));
}

/** Verify every traced command group without interpreting graph event payloads. */
export function verifyGraphDecisionEvidence(
  store: GraphDecisionEvidenceStore,
  events: readonly StoredEvent[],
  projectId: string,
): GraphDecisionEvidenceResult {
  const groups = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const group = groups.get(event.commandId) ?? [];
    group.push(event);
    groups.set(event.commandId, group);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined || group.every((event) => event.decisionTrace === undefined)) continue;
    const trace = first.decisionTrace;
    if (trace === undefined || group.some((event) => event.decisionTrace === undefined)) {
      return REFUSAL;
    }
    const loaded = loadEvidence(store, first, trace);
    if ("ok" in loaded) return loaded;
    if (!groupAgrees(group, trace, loaded.decision, loaded.receipt, projectId)) {
      return REFUSAL;
    }
  }
  return accepted;
}
