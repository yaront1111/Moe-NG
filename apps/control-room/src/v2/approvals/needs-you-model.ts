import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame, LiveGoalCatalogEntry } from "../../live/live-goal-catalog.js";
import type { PreviewReadOutcome } from "../../live/live-preview.js";
import type { ReleaseOutcome } from "../../live/live-release.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { MIDDOT } from "../glyphs.js";
import { currentRunOf, planSentBack } from "../goals/plan-run-resolution.js";
import { escalationItems } from "./needs-you-escalation.js";
import { previewOfferFor } from "./needs-you-preview.js";
import type { PreviewFacts } from "./needs-you-preview.js";
import { releaseOfferFor } from "./needs-you-release.js";
import type { ReleaseFacts } from "./needs-you-release.js";

/**
 * NEEDS YOU: every decision across the project that is waiting on a human, derived only
 * from things the daemon already states. Seven kinds of item:
 *
 *  - PLAN_APPROVAL: the affordance surface OFFERS `approval.decide_intent` for a goal's
 *    planning run. The offer is the daemon's own statement that the run is in review and
 *    this session may approve it; nothing here infers "reviewable" from a lifecycle word.
 *  - PLAN_REJECTED: the operator sent a plan back and the daemon has moved the goal onto a
 *    SUCCESSOR run it is not yet offering for approval (`planSentBack`). It is listed so a
 *    reject does not vanish from the operator's queue between the click and the re-plan,
 *    and it CLEARS on the same frame that offers the successor - at which point the
 *    PLAN_APPROVAL item above takes its place. The two are mutually exclusive by
 *    construction: `planSentBack` is false exactly when that offer exists.
 *  - ESCALATION: the surface OFFERS `escalation.decide` for a node, which the daemon does
 *    only when three review rounds failed and the kernel refuses more until a human decides.
 *    The runs read names the goal the node belongs to.
 *  - PREVIEW: the surface OFFERS `preview.decide` for a goal whose preview receipt says
 *    STARTED. That is Gate 2 - the operator looks at their product actually running and
 *    says whether it is good enough. `needs-you-preview.ts` states the four facts that
 *    must all hold; a goal with no receipt yields NO item rather than a dead control.
 *  - RELEASE: the surface OFFERS `release.decide` for a goal whose release read has no
 *    RELEASED receipt. That is Gate 3 - the operator says whether the evidence is strong
 *    enough to expose the work to users. `needs-you-release.ts` states which facts must
 *    hold, and why the RECEIPT rather than the offer is what clears the item.
 *  - GATE_1: the coverage read says a Product Contract citing the goal's PRD is still
 *    PENDING at Gate 1 (the same fact the goal card's "Needs you" flag rests on).
 *  - READY_TO_CLOSE: every criterion the contract states is VERIFIED, every citing contract
 *    is past Gate 1, and the goal is still open. Closing stays the operator's call; when the
 *    surface OFFERS `goal.close` for the goal the card carries that decision inline.
 *
 * Every item routes to the goal, where the plan, the contract and the evidence live. An
 * inline decision exists only where the daemon offered the command for it.
 */

export const NEEDS_YOU_KINDS = [
  "PLAN_APPROVAL", "PLAN_REJECTED", "PREVIEW", "RELEASE", "ESCALATION", "GATE_1",
  "READY_TO_CLOSE",
] as const;
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
  /** Present only for a PREVIEW item: the running url, its captures and the offer. */
  readonly preview?: PreviewFacts | undefined;
  /** Present only for a RELEASE item: the evidence counts and the offer. */
  readonly release?: ReleaseFacts | undefined;
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
  /** One preview read per goal, keyed by goalId; absent means the read has not answered. */
  readonly previews?: ReadonlyMap<string, PreviewReadOutcome> | undefined;
  /** One release evidence read per goal, keyed by goalId; absent means it has not answered. */
  readonly releases?: ReadonlyMap<string, ReleaseOutcome> | undefined;
  readonly runs?: RunsOutcome | null | undefined;
  readonly surface: SurfaceFrame | null;
}

const KIND_ORDER: Readonly<Record<NeedsYouKind, number>> = Object.freeze({
  PLAN_APPROVAL: 0, PLAN_REJECTED: 1, PREVIEW: 2, RELEASE: 3, ESCALATION: 4, GATE_1: 5,
  READY_TO_CLOSE: 6,
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
  previews: NeedsYouInput["previews"],
  releases: NeedsYouInput["releases"],
  runs: RunsOutcome | null | undefined,
): NeedsYouItem[] {
  const title = entry.brief?.title ?? entry.goalId;
  const base = { goalId: entry.goalId, planningRunRef: entry.planningRunRef, title };
  const items: NeedsYouItem[] = [];
  // THE CURRENT RUN, not the catalog's frozen one. `planningRunRef` is immutable and after a
  // reject it still names the run the operator sent back, so looking the offer up under it
  // would drop the approval item entirely once the successor is compiled - the queue would
  // go empty while a plan sat waiting for a decision nobody was told about.
  const currentRun = currentRunOf(surface, entry.goalId, entry.planningRunRef);
  if (offerFor(surface, "approval.decide_intent", currentRun) !== undefined) {
    items.push(Object.freeze({
      ...base,
      actionLabel: "Review the plan",
      detail: "Read the plan and its acceptance criteria before approving.",
      headline: "A plan is waiting for your approval",
      kind: "PLAN_APPROVAL",
    }));
  } else if (planSentBack(surface, entry.goalId, entry.planningRunRef)) {
    items.push(Object.freeze({
      ...base,
      actionLabel: "Open the goal",
      // NO REASON TEXT HERE, and that is measured rather than an oversight: no daemon read
      // this browser can decode carries it. `/activity/read` entries are an exact SEVEN-key
      // shape (commandKind, decidedAt, disposition, principalId, targetAggregateId, verdict,
      // version) with a verdict word and no reason, and the plan-review read carries none
      // either. Inventing one here would put words in the operator's mouth.
      detail: "The daemon is compiling a new plan from the reason you gave."
        + " Nothing needs you until it is offered for approval.",
      headline: "The plan you sent back is being re-planned",
      kind: "PLAN_REJECTED",
    }));
  }
  const preview = previewOfferFor(entry.goalId, previews?.get(entry.goalId), surface, runs);
  if (preview !== null) {
    items.push(Object.freeze({
      ...base, actionLabel: preview.actionLabel, detail: preview.detail,
      headline: preview.headline, kind: "PREVIEW", preview: preview.facts,
    }));
  }
  const release = releaseOfferFor(entry.goalId, releases?.get(entry.goalId), surface);
  if (release !== null) {
    items.push(Object.freeze({
      ...base, actionLabel: release.actionLabel, detail: release.detail,
      headline: release.headline, kind: "RELEASE", release: release.facts,
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

export function deriveNeedsYou(input: NeedsYouInput): NeedsYouData {
  const { catalog, coverage, previews, releases, runs, surface } = input;
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
    ...catalog.goals.flatMap((entry) =>
      itemsFor(entry, coverage.get(entry.goalId), surface, previews, releases, runs)),
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
