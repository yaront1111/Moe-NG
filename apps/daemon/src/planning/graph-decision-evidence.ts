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
  EffectsCommittedDecision,
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

/** The decision this trace names is the one that committed, and it is this project's. */
function decisionAgrees(
  trace: Trace,
  decision: CommandDecisionRecord,
  projectId: string,
): decision is EffectsCommittedDecision {
  return decision.effectDisposition === "EFFECTS_COMMITTED" &&
    trace.projectId === projectId && decision.commandKind === trace.commandKind &&
    decision.key.commandId === trace.commandId && decision.key.principalId === trace.principalId &&
    decision.key.projectId === projectId && decision.requestSha256 === trace.requestSha256 &&
    decision.requestIdentityVersion === trace.requestIdentityVersion;
}

/**
 * This event group IS its own receipt's effect: same aggregate, same command, contiguous
 * sequences from the receipt's fence, same commit instant, same request, same trace throughout.
 * True of EVERY leg, primary or not, so it is the whole check for a secondary one.
 */
function receiptAgrees(
  events: readonly StoredEvent[],
  trace: Trace,
  receipt: CommandReceipt,
): boolean {
  const first = events[0];
  if (first === undefined || receipt.aggregateId !== first.aggregateId) return false;
  return sameStrings(receipt.eventIds, events.map((event) => event.eventId)) &&
    events.every((event, index) =>
      event.aggregateId === first.aggregateId && event.commandId === receipt.commandId &&
      event.aggregateSequence === receipt.previousVersion + index + 1 &&
      event.committedAt === receipt.committedAt && event.requestSha256 === receipt.requestSha256 &&
      event.decisionTrace !== undefined && sameTrace(event.decisionTrace, trace));
}

/**
 * The equalities that hold ONLY on the primary leg, because the decision record carries the
 * primary's fence, effect digest and business event ids and no other leg's.
 *
 * WHY THIS SPLIT EXISTS. A multi-aggregate decision commits `legs[0]` plus fenced extras, and the
 * store links EVERY leg's events back to the SAME decision through
 * `command_decision_legs.receipt_command_id` (read-page-queries.ts:13-31) - which is the only
 * reason a secondary leg's events carry a `decisionTrace` at all. Demanding the primary's numbers
 * of a secondary leg therefore failed closed on correct histories, and the failure was
 * unreachable until a graph revision was first written by a real command instead of a test
 * fixture: the initial active-graph transition rides the approval's decision as an extra leg, and
 * the projection answered ACTIVE_GRAPH_EVIDENCE_UNAVAILABLE for a perfectly committed activation.
 * Membership stays PROVEN rather than assumed - the store's own leg roster produced the join, and
 * `receiptAgrees` still ties every byte of the group to that leg's own receipt and aggregate.
 */
function primaryAgrees(
  events: readonly StoredEvent[],
  decision: EffectsCommittedDecision,
  receipt: CommandReceipt,
): boolean {
  return decision.expectedVersion === receipt.previousVersion &&
    decision.observedVersion === receipt.previousVersion &&
    decision.previousVersion === receipt.previousVersion &&
    decision.currentVersion === receipt.currentVersion &&
    decision.effectSha256 === receipt.effectSha256 &&
    sameStrings(decision.businessEventIds, events.map((event) => event.eventId)) &&
    sameStrings(decision.outboxMessageIds, receipt.outboxMessageIds);
}

function groupAgrees(
  events: readonly StoredEvent[],
  trace: Trace,
  decision: CommandDecisionRecord,
  receipt: CommandReceipt,
  projectId: string,
): boolean {
  const first = events[0];
  if (first === undefined || !decisionAgrees(trace, decision, projectId)) return false;
  if (!receiptAgrees(events, trace, receipt)) return false;
  return decision.targetAggregateId === first.aggregateId
    ? primaryAgrees(events, decision, receipt)
    : true;
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
