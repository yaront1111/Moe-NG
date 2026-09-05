import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame, LiveGoalCatalogEntry } from "../../live/live-goal-catalog.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { ROUTE_WORDS } from "../board/board-columns.js";
import { MIDDOT } from "../glyphs.js";

/**
 * NEEDS YOU: every decision across the project that is waiting on a human, derived only
 * from things the daemon already states. Four kinds of item:
 *
 *  - PLAN_APPROVAL: the affordance surface OFFERS `approval.decide_intent` for a goal's
 *    planning run. The offer is the daemon's own statement that the run is in review and
 *    this session may approve it; nothing here infers "reviewable" from a lifecycle word.
 *  - ESCALATION: the surface OFFERS `escalation.decide` for a node, which the daemon does
 *    only when three review rounds failed and the kernel refuses more until a human decides.
 *    The runs read names the goal the node belongs to.
 *  - GATE_1: the coverage read says a Product Contract citing the goal's PRD is still
 *    PENDING at Gate 1 (the same fact the goal card's "Needs you" flag rests on).
 *  - READY_TO_CLOSE: every criterion the contract states is VERIFIED, every citing contract
 *    is past Gate 1, and the goal is still open. Closing stays the operator's call; when the
 *    surface OFFERS `goal.close` for the goal the card carries that decision inline.
 *
 * Every item routes to the goal, where the plan, the contract and the evidence live. An
 * inline decision exists only where the daemon offered the command for it.
 */

export const NEEDS_YOU_KINDS = ["PLAN_APPROVAL", "ESCALATION", "GATE_1", "READY_TO_CLOSE"] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

export interface EscalationFacts {
  /** The daemon's offer, spent verbatim by the escalation port. */
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly latestRoute: string | null;
  readonly nodeKey: string;
  readonly unsuccessfulRounds: number | null;
}

export interface CloseFacts {
  /** The daemon's `goal.close` offer for this goal, spent verbatim by the close port. */
  readonly affordance: Readonly<Record<string, unknown>>;
}

export interface NeedsYouItem {
  readonly actionLabel: string;
  /** Present only for a READY_TO_CLOSE item the daemon offers goal.close for. */
  readonly close?: CloseFacts | undefined;
  readonly detail: string;
  /** Present only for an ESCALATION item: the inline decision it carries. */
  readonly escalation?: EscalationFacts | undefined;
  readonly goalId: string;
  readonly headline: string;
  readonly kind: NeedsYouKind;
  readonly planningRunRef: string;
  readonly title: string;
}

export interface NeedsYouData {
  readonly countLabel: string;
  readonly items: readonly NeedsYouItem[];
  /** Why the list may be incomplete or empty, stated as the daemon stated it. */
  readonly note: string | null;
}

export interface NeedsYouInput {
  readonly catalog: GoalCatalogFrame | null;
  readonly coverage: ReadonlyMap<string, DocumentCoverageOutcome>;
  readonly runs?: RunsOutcome | null | undefined;
  readonly surface: SurfaceFrame | null;
}

const KIND_ORDER: Readonly<Record<NeedsYouKind, number>> = Object.freeze({
  PLAN_APPROVAL: 0, ESCALATION: 1, GATE_1: 2, READY_TO_CLOSE: 3,
});
const OPEN_LIFECYCLES: readonly string[] = Object.freeze(["EXECUTION_ENABLED", "CLOSING"]);

function offerFor(
  surface: SurfaceFrame | null, commandKind: string, target: string,
): Readonly<Record<string, unknown>> | undefined {
  if (surface === null || surface.outcome !== "SURFACE") return undefined;
  return surface.offers.find((offer) =>
    offer["commandKind"] === commandKind && offer["targetAggregateId"] === target);
}

function itemsFor(
  entry: LiveGoalCatalogEntry,
  coverage: DocumentCoverageOutcome | undefined,
  surface: SurfaceFrame | null,
): NeedsYouItem[] {
  const title = entry.brief?.title ?? entry.goalId;
  const base = { goalId: entry.goalId, planningRunRef: entry.planningRunRef, title };
  const items: NeedsYouItem[] = [];
  if (offerFor(surface, "approval.decide_intent", entry.planningRunRef) !== undefined) {
    items.push(Object.freeze({
      ...base,
      actionLabel: "Review the plan",
      detail: "Read the plan and its acceptance criteria before approving.",
      headline: "A plan is waiting for your approval",
      kind: "PLAN_APPROVAL",
    }));
  }
  if (coverage?.status === "COVERAGE") {
    const pending = coverage.contracts.filter((contract) => contract.gate1 === "PENDING");
    for (const contract of pending) {
      const criteria = contract.requirements.reduce((sum, row) => sum + row.criteria.length, 0);
      items.push(Object.freeze({
        ...base,
        actionLabel: "Review the contract",
        detail: `${String(contract.requirements.length)} requirements`
          + ` ${MIDDOT} ${String(criteria)} acceptance criteria. Approving it lets agents start.`,
        headline: "A Product Contract is waiting for your approval",
        kind: "GATE_1",
      }));
    }
    const { criteria, verified } = coverage.totals;
    const goal = coverage.goals.find((row) => row.goalId === entry.goalId);
    const complete = criteria > 0 && verified === criteria && pending.length === 0
      && coverage.contracts.length > 0;
    if (complete && goal !== undefined && OPEN_LIFECYCLES.includes(goal.lifecycle ?? "")) {
      const closeOffer = offerFor(surface, "goal.close", entry.goalId);
      items.push(Object.freeze({
        ...base,
        actionLabel: "Open the goal",
        ...(closeOffer === undefined ? {} : { close: Object.freeze({ affordance: closeOffer }) }),
        detail: `All ${String(criteria)} acceptance criteria verified by the daemon's verifier.`
          + (closeOffer === undefined
            ? " The daemon is not offering to close it yet; open the goal to see why."
            : " Close the goal when you are satisfied with the evidence."),
        headline: "Everything the contract states is verified",
        kind: "READY_TO_CLOSE",
      }));
    }
  }
  return items;
}

/** One item per escalation.decide the daemon offers, joined to its goal through the runs read. */
function escalationItems(
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

export function deriveNeedsYou(input: NeedsYouInput): NeedsYouData {
  const { catalog, coverage, runs, surface } = input;
  if (catalog === null) {
    return Object.freeze({
      countLabel: "Waiting for goals", items: Object.freeze([]),
      note: "Nothing is listed until the daemon's durable goal catalog answers.",
    });
  }
  if (catalog.outcome !== "GOALS") {
    return Object.freeze({
      countLabel: "The goals could not be read", items: Object.freeze([]),
      note: `The goal catalog answered ${catalog.outcome}: ${catalog.detail}.`,
    });
  }
  const items = [
    ...catalog.goals.flatMap((entry) => itemsFor(entry, coverage.get(entry.goalId), surface)),
    ...escalationItems(surface, runs, catalog),
  ].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || left.title.localeCompare(right.title) || left.goalId.localeCompare(right.goalId));
  const count = items.length;
  return Object.freeze({
    countLabel: `${String(count)} decision${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you`,
    items: Object.freeze(items),
    note: surface === null
      ? "The daemon's offers have not arrived yet; plan approvals appear once they do."
      : surface.outcome !== "SURFACE"
        ? `The daemon's offer surface answered ${surface.outcome}: ${surface.detail}.`
        : null,
  });
}
