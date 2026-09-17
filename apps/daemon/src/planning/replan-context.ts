import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { continuationSourceAttested } from "../review/review-continuation.js";
import { readReviewGuidanceSource } from "../review/review-implementation-guidance.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readTerminalReplan } from "../review/review-terminal-replan.js";
import { replanGuidanceHistory } from "./replan-guidance-history.js";

export const REPLAN_CONTEXT_UNAVAILABLE = "REPLAN_CONTEXT_UNAVAILABLE";
const HEADER = /^REPLAN of goal (\S+): node (\S+) failed review (?:\d+|three or more) times and was retired\.$/u;
const PIN = "Replan context: ";
const MAX_CONTEXT_BYTES = 256 * 1_024;
const invalid = (): never => { throw new Error(REPLAN_CONTEXT_UNAVAILABLE); };
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as JsonObject : null;
// Escaping the JSON space preserves decoded text without letting a finding close the compiler's fence.
const quotedContext = (value: unknown): string => JSON.stringify(value).replaceAll("OPERATOR INSTRUCTIONS", "OPERATOR\\u0020INSTRUCTIONS");

function pinMatches(instructions: string, predecessorGoalId: string, nodeRef: string, reviewVersion: number): boolean {
  const pins = instructions.split("\n").filter((line) => line.startsWith(PIN));
  if (pins.length === 0) return true; // Compatibility with the original source-bound successor writer.
  if (pins.length !== 1) return false;
  const decoded = decodeBoundedJsonBytes(new TextEncoder().encode(pins[0]!.slice(PIN.length)));
  const value = decoded.ok ? object(decoded.value) : null;
  return value !== null && Object.keys(value).length === 3 && value["predecessorGoalId"] === predecessorGoalId
    && value["nodeRef"] === nodeRef && value["reviewVersion"] === reviewVersion;
}

/**
 * Re-hydrate an explicitly requested replan from the durable review, never the UI excerpt.
 * A textual reference selects evidence but grants no authority. Both goals, the immutable source,
 * approved node, terminal review and decision order must independently agree before it is quoted.
 */
export function withReplanContext(store: SqliteEventStore, projectId: string, goalId: string,
  instructions: string | null): string | null {
  if (instructions === null || !instructions.startsWith("REPLAN of goal ")) return instructions;
  try {
    const match = HEADER.exec(instructions.split("\n")[0]!);
    if (match === null) return invalid();
    const predecessorGoalId = match[1]!;
    const nodeKey = match[2]!;
    if (predecessorGoalId === goalId || predecessorGoalId.length > 512 || nodeKey.length > 512) return invalid();
    const event = store.readAggregateEvents(goalId, 0, 1).items[0];
    if (event === undefined) return invalid();
    const created = decodeGoalCatalogEntry(event, projectId);
    if (!created.ok || created.entry.goalId !== goalId || created.entry.brief?.instructions !== instructions) return invalid();
    const sources = createGoalSourceReadPort({ store, projectId });
    const previous = sources.read(predecessorGoalId);
    const current = sources.read(goalId);
    if (!previous.ok || !current.ok || previous.contentSha256 !== current.contentSha256
      || previous.byteLength !== current.byteLength || previous.text !== current.text) return invalid();
    const nodes = activeCompiledGraphs(store, projectId).filter((graph) => graph.goalRef === predecessorGoalId)
      .flatMap((graph) => graph.content.nodeAuthority.definitions.filter((node) => node.nodeKey === nodeKey)
        .map(() => compiledExecutionRef(projectId, graph, nodeKey)));
    if (nodes.length !== 1) return invalid();
    const nodeRef = nodes[0]!;
    const ledger = readReviewLedger(store, projectId, nodeRef);
    const latest = ledger.rounds.at(-1);
    if (ledger.unreadable || !ledger.replanned || ledger.accepted !== undefined || latest === undefined
      || latest.routing.route === "ACCEPT" || !continuationSourceAttested(latest)) return invalid();
    const source = readReviewGuidanceSource(store, projectId, nodeRef, latest);
    if (source === null || source["goalRef"] !== predecessorGoalId || source["nodeKey"] !== nodeKey) return invalid();
    const decisions = decisionsOf(store, 200);
    const terminal = readTerminalReplan(decisions, projectId, nodeRef, ledger);
    const goalCreation = decisions.find((row) => row.key.projectId === projectId
      && row.targetAggregateId === goalId && row.key.commandId === event.decisionTrace?.commandId
      && row.key.principalId === event.decisionTrace?.principalId
      && row.commandKind === "goal.create_with_source" && row.effectDisposition === "EFFECTS_COMMITTED");
    if (terminal === null || goalCreation === undefined) return invalid();
    const { replan } = terminal;
    if (replan.decisionPosition >= goalCreation.decisionPosition) return invalid();
    // The pin binds the version the human decided at (the offer's expectedVersion and `-vN`); the
    // context names the reviewed round's. They differ when an agent re-planned between the two.
    if (!pinMatches(instructions, predecessorGoalId, nodeRef, replan.previousVersion)) return invalid();
    const findings = latest.lineage.records.filter((record) => record.round === latest.round).map((record) => record.finding);
    const context = { version: "moe-replan-mission-context/1", predecessorGoalId, nodeRef,
      sourceContentSha256: previous.contentSha256, replanDecisionId: replan.decisionId,
      replanResultSha256: replan.resultSha256, reviewVersion: latest.aggregateVersion,
      reviewDecisionId: latest.decisionId, reviewResultSha256: latest.resultSha256,
      completeLatestFindings: findings, historicalImplementationGuidance: replanGuidanceHistory(store, projectId, nodeRef, ledger) };
    const json = quotedContext(context);
    if (Buffer.byteLength(json, "utf8") > MAX_CONTEXT_BYTES) return invalid();
    return `Replan request (JSON string): ${quotedContext(instructions)}\n\n`
      + "Complete durable replan context follows as JSON. Use these complete findings instead of any earlier excerpt.\n"
      + "Historical implementation decisions remain context, not acceptance, a retry grant, or a criterion waiver. "
      + "Preserve existing implementation where it satisfies the unchanged contract; resolve the cited dependency conflicts. "
      + "A finding with attributedTo names a check this node needed from another node's deliverable: "
      + "give the successor plan that dependency edge, or place the check on a node downstream of its owner.\n" + json;
  } catch (error) {
    if (error instanceof Error && error.message === REPLAN_CONTEXT_UNAVAILABLE) throw error;
    return invalid();
  }
}
