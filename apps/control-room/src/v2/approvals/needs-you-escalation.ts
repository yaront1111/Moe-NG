import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { RunNodeFindingView, RunsOutcome } from "../../live/live-runs.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { ROUTE_WORDS } from "../board/board-columns.js";
import type { NeedsYouItem } from "./needs-you-model.js";

export interface EscalationFacts {
  /** The daemon's offer, spent verbatim by the escalation port. */
  readonly affordance: Readonly<Record<string, unknown>>;
  /** Empty unless CURRENT; `blockingFindingsOf` says how many of them block acceptance. */
  readonly findings: readonly RunNodeFindingView[];
  readonly findingsState: "CURRENT" | "MISSING" | "STALE" | "UNREADABLE";
  readonly latestRoute: string | null;
  readonly nodeKey: string;
  /** Rounds that repeated the same findings on an unchanged workspace; empty or absent when not stalled. */
  readonly stalledRounds?: readonly number[];
  readonly unsuccessfulRounds: number | null;
}

/** Only the node's own CRITICAL or MAJOR findings block a round; the kernel states the rule. */
export function blocksAcceptance(finding: RunNodeFindingView): boolean {
  return (finding.attributedTo === undefined || finding.attributedTo === null) && finding.severity !== "MINOR";
}

/**
 * How many listed findings block acceptance: this node's own CRITICAL or MAJOR ones. A MINOR
 * finding is informational and a finding attributed to another node never charges this one
 * (`@moe/review` review-findings.ts), so an all-MINOR list is 0 and one more attempt on it is
 * accepted.
 */
export function blockingFindingsOf(findings: readonly RunNodeFindingView[]): number {
  return findings.filter(blocksAcceptance).length;
}

/** The plain-words rule every card states; an all-MINOR list must read as what it is. */
export const MINOR_NEVER_BLOCKS = "one more attempt is accepted unless a CRITICAL or MAJOR finding appears";

/**
 * The daemon lists at most this many findings of the latest round (`apps/daemon/src/http/
 * runs-read.ts` MAX_FINDINGS) and carries no total, so a list at the cap may hide a blocking
 * finding past it. Such a list never earns the all-MINOR words: the card cannot know.
 */
export const REVIEW_SUMMARY_FINDINGS_CAP = 8;
export function findingsListCapped(findings: readonly RunNodeFindingView[]): boolean {
  return findings.length >= REVIEW_SUMMARY_FINDINGS_CAP;
}

/** Whether the listed findings prove a non-blocking round: some listed, none blocks, none hidden. */
export function listedFindingsBlockNothing(findings: readonly RunNodeFindingView[]): boolean {
  return findings.length > 0 && blockingFindingsOf(findings) === 0 && !findingsListCapped(findings);
}

function attemptWords(stalled: readonly number[], findings: readonly RunNodeFindingView[]): string {
  if (stalled.length === 0) return ". Allow one more attempt, or replan the work into a successor goal that carries these findings.";
  // UnAI 2026-09-17/18: this line said "would repeat them" while every round carried only MINOR
  // notes, which never block; the operator clicked "Allow one more attempt" without knowing what
  // it rescued. A stall on non-blocking findings is not a stall the next attempt can repeat.
  if (listedFindingsBlockNothing(findings)) {
    return `. Rounds ${stalled.join(", ")} repeated the same MINOR notes on an unchanged workspace. MINOR notes never block, so ${MINOR_NEVER_BLOCKS}.`
      + " Allow one more attempt, or replan the work into a successor goal.";
  }
  return `. Rounds ${stalled.join(", ")} repeated the same findings on an unchanged workspace, so another attempt without new`
    + " instructions would repeat them. Replan the work into a successor goal, or write guidance for one more attempt.";
}

/** Each daemon offer joins its exact node and review version; unavailable summaries stay explicit. */
export function escalationItems(
  surface: SurfaceFrame | null, runs: RunsOutcome | null | undefined, catalog: GoalCatalogFrame,
): NeedsYouItem[] {
  if (surface === null || surface.outcome !== "SURFACE") return [];
  const items: NeedsYouItem[] = [];
  for (const offer of surface.offers) {
    if (offer["commandKind"] !== "escalation.decide" || typeof offer["targetAggregateId"] !== "string") continue;
    const nodeRef = offer["targetAggregateId"];
    const goal = runs?.status === "RUNS"
      ? runs.goals.find((row) => row.nodes.some((node) => node.nodeRef === nodeRef)) : undefined;
    const node = goal?.nodes.find((row) => row.nodeRef === nodeRef);
    const nodeKey = node?.nodeKey ?? nodeRef;
    const entry = goal === undefined ? undefined : catalog.goals.find((row) => row.goalId === goal.goalId);
    const version = offer["expectedVersion"];
    const findingsState: EscalationFacts["findingsState"] = runs != null && runs.status !== "RUNS" ? "UNREADABLE"
      : node === undefined ? "MISSING" : node.review.unreadable ? "UNREADABLE"
      : typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 || node.review.version !== version ? "STALE" : "CURRENT";
    const findings = findingsState === "CURRENT" ? Object.freeze([...node!.review.findings]) : Object.freeze([]);
    const rounds = findingsState === "CURRENT" ? node!.review.unsuccessfulRounds : null;
    const route = findingsState === "CURRENT" ? node!.review.latestRoute : null;
    const stalled = findingsState === "CURRENT" ? Object.freeze([...(node!.review.stalledRounds ?? [])]) : Object.freeze([]);
    items.push(Object.freeze({
      actionLabel: "Open the goal",
      detail: `${node?.objective === undefined || node.objective === "" ? "This work" : node.objective} failed review ${rounds === null ? "three or more" : String(rounds)} times`
        + (route === null ? "" : ` (last: ${ROUTE_WORDS[route] ?? route})`)
        + attemptWords(stalled, findings),
      escalation: Object.freeze({ affordance: offer, findings, findingsState, latestRoute: route, nodeKey,
        stalledRounds: stalled, unsuccessfulRounds: rounds }),
      goalId: goal?.goalId ?? "",
      headline: "A node's review is exhausted",
      kind: "ESCALATION",
      planningRunRef: entry?.planningRunRef ?? goal?.run?.runId ?? "",
      title: goal?.title ?? entry?.brief?.title ?? `node ${nodeKey}`,
    }));
  }
  return items;
}
