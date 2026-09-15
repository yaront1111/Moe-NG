import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { RunNodeFindingView, RunsOutcome } from "../../live/live-runs.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { ROUTE_WORDS } from "../board/board-columns.js";
import type { NeedsYouItem } from "./needs-you-model.js";

export interface EscalationFacts {
  /** The daemon's offer, spent verbatim by the escalation port. */
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly findings: readonly RunNodeFindingView[];
  readonly findingsState: "CURRENT" | "MISSING" | "STALE" | "UNREADABLE";
  readonly latestRoute: string | null;
  readonly nodeKey: string;
  /** Rounds that repeated the same findings on an unchanged workspace; empty or absent when not stalled. */
  readonly stalledRounds?: readonly number[];
  readonly unsuccessfulRounds: number | null;
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
        + (stalled.length > 0
          ? `. Rounds ${stalled.join(", ")} repeated the same findings on an unchanged workspace, so another attempt without new`
            + " instructions would repeat them. Replan the work into a successor goal, or write guidance for one more attempt."
          : ". Allow one more attempt, or replan the work into a successor goal that carries these findings."),
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
