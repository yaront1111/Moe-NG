import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { ROUTE_WORDS } from "../board/board-columns.js";
import type { NeedsYouItem } from "./needs-you-model.js";

/**
 * THE EXHAUSTED-REVIEW ITEMS, lifted out of `needs-you-model.ts` verbatim when Gate 3 joined
 * the queue and that file reached its line cap. Nothing here changed: the same offer walk,
 * the same words, the same facts. It sits beside `needs-you-preview.ts` and
 * `needs-you-release.ts`, which is where a kind's own derivation belongs.
 *
 * The `NeedsYouItem` import is TYPE-ONLY and therefore erased: there is no runtime cycle
 * between this module and the model that calls it.
 */

/** One item per escalation.decide the daemon offers, joined to its goal through the runs read. */
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
    const rounds = node?.review.unsuccessfulRounds ?? null;
    const route = node?.review.latestRoute ?? null;
    items.push(Object.freeze({
      actionLabel: "Open the goal",
      detail: `${node?.objective === undefined || node.objective === "" ? "This work" : node.objective} failed review ${rounds === null ? "three or more" : String(rounds)} times`
        + (route === null ? "" : ` (last: ${ROUTE_WORDS[route] ?? route})`)
        + ". Allow more attempts, or replan the work into a successor goal that carries these findings.",
      escalation: Object.freeze({ affordance: offer, latestRoute: route, nodeKey, unsuccessfulRounds: rounds }),
      goalId: goal?.goalId ?? "",
      headline: "A node's review is exhausted",
      kind: "ESCALATION",
      planningRunRef: entry?.planningRunRef ?? goal?.run?.runId ?? "",
      title: goal?.title ?? entry?.brief?.title ?? `node ${nodeKey}`,
    }));
  }
  return items;
}
