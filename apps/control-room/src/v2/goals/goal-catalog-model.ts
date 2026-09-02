import type {
  GoalCatalogFrame, LiveGoalCatalogEntry,
} from "../../live/live-goal-catalog.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type {
  ComingOnlineFact, GoalCardModel, GoalFact, GoalsData,
} from "./goal-model.js";

/**
 * Turns the authenticated project's durable /goals/read answer into cards.
 *
 * The catalog supplies identity, the planning-run ref, and only the exact brief
 * and source-binding provenance it returned. It does not borrow task state from
 * the project affordance surface or invent progress, spend, timestamps,
 * acceptance, or human-attention state.
 */

const SOURCE_ROW = Object.freeze({ k: "SOURCE", v: "POST /goals/read" });

function expandedCatalogFact(
  goalId: string,
  suffix: string,
  label: string,
  field: string,
  value: string,
  note: string,
  truthClass: LiveGoalCatalogEntry["truthClass"],
): GoalFact {
  return Object.freeze({
    factId: `catalog.${goalId}.${suffix}`,
    label,
    note,
    rows: Object.freeze([SOURCE_ROW, Object.freeze({ k: field, v: value })]),
    truthClass,
    value,
  });
}

const GOAL_TITLE_COMING_ONLINE: ComingOnlineFact = Object.freeze({
  label: "Goal title",
  reason: "The durable catalog carries identity, not advisory goal prose; the goal id is shown verbatim.",
});

const COMING_ONLINE: readonly ComingOnlineFact[] = Object.freeze([
  Object.freeze({
    label: "Acceptance progress",
    reason: "Node acceptance is not joined to the goal catalog yet.",
  }),
  Object.freeze({
    label: "Budget and spend",
    reason: "No budget read is joined to the goal catalog yet.",
  }),
  Object.freeze({
    label: "Last event",
    reason: "The catalog does not carry a last-event timestamp.",
  }),
]);

const LEGACY_COMING_ONLINE: readonly ComingOnlineFact[] = Object.freeze([
  GOAL_TITLE_COMING_ONLINE, ...COMING_ONLINE,
]);

function empty(label: string, note: string): GoalsData {
  return Object.freeze({
    comingOnlineNote: note,
    goalCountLabel: label,
    goals: Object.freeze([]),
    source: "live",
    triage: Object.freeze([]),
  });
}

function goalCard(entry: LiveGoalCatalogEntry): GoalCardModel {
  const identityFact: GoalFact = Object.freeze({
    factId: `catalog.${entry.goalId}.identity`,
    label: "Goal",
    note: "A durable GoalCreated record in the authenticated project's ledger.",
    rows: Object.freeze([SOURCE_ROW, Object.freeze({ k: "GOAL", v: entry.goalId })]),
    truthClass: entry.truthClass,
    value: entry.goalId,
  });
  const runFact: GoalFact = Object.freeze({
    factId: `catalog.${entry.goalId}.planning-run`,
    label: "Planning run",
    note: "The planning-run reference stored with GoalCreated; opening this goal reads this exact ref.",
    rows: Object.freeze([SOURCE_ROW, Object.freeze({ k: "RUN", v: entry.planningRunRef })]),
    truthClass: entry.truthClass,
    value: entry.planningRunRef,
  });
  const expandedFacts: GoalFact[] = [];
  if (entry.brief !== null) {
    expandedFacts.push(expandedCatalogFact(
      entry.goalId,
      "brief.instructions",
      "Brief instructions",
      "brief.instructions",
      entry.brief.instructions,
      "The normalized brief instructions stored with GoalCreated and returned by the durable catalog.",
      entry.truthClass,
    ));
  }
  if (entry.binding !== null) {
    const note = "The source binding stored with GoalCreated and returned by the durable catalog.";
    expandedFacts.push(
      expandedCatalogFact(
        entry.goalId,
        "binding.byteLength",
        "PRD byte length",
        "binding.byteLength",
        String(entry.binding.byteLength),
        note,
        entry.truthClass,
      ),
      expandedCatalogFact(
        entry.goalId,
        "binding.contentSha256",
        "PRD content SHA-256",
        "binding.contentSha256",
        entry.binding.contentSha256,
        note,
        entry.truthClass,
      ),
      expandedCatalogFact(
        entry.goalId,
        "binding.sourceAggregateId",
        "PRD source aggregate",
        "binding.sourceAggregateId",
        entry.binding.sourceAggregateId,
        note,
        entry.truthClass,
      ),
      expandedCatalogFact(
        entry.goalId,
        "binding.sourceRef",
        "PRD source ref",
        "binding.sourceRef",
        entry.binding.sourceRef,
        note,
        entry.truthClass,
      ),
    );
  }
  const facts = Object.freeze([identityFact, runFact, ...expandedFacts]);

  return Object.freeze({
    budgetComingOnline: "No budget read is joined to the goal catalog yet.",
    comingOnlineFacts: entry.brief === null ? LEGACY_COMING_ONLINE : COMING_ONLINE,
    facts,
    goalId: entry.goalId,
    headline: `Durable GoalCreated record \u00b7 planning run ${entry.planningRunRef}`,
    headlineFacts: Object.freeze([identityFact, runFact]),
    headlineTone: "verified",
    needsYou: false,
    progressComingOnline: "Node acceptance is not joined to the goal catalog yet.",
    planningRunRef: entry.planningRunRef,
    state: "DRAFT",
    title: entry.brief?.title ?? entry.goalId,
    titleIsIdentifier: entry.brief === null,
  });
}

/**
 * Overlays the daemon PRD coverage read onto a catalog card. The card progress slot said
 * "coming online" because node acceptance was not joined to the catalog; the coverage read IS
 * that join, so its totals become the bar and its facts become the headline. Nothing is
 * computed locally: verified/criteria are the daemon counts, and "needs you" is exactly "a
 * contract citing this goal PRD still awaits Gate 1".
 */
function withCoverage(
  card: GoalCardModel, outcome: DocumentCoverageOutcome | undefined,
): GoalCardModel {
  if (outcome === undefined) return card;
  if (outcome.status !== "COVERAGE") {
    return outcome.status === "REFUSED" && outcome.code === "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND"
      ? Object.freeze({ ...card, progressComingOnline: "No PRD is bound to this goal." })
      : card;
  }
  const { contracts, criteria, verified } = outcome.totals;
  if (contracts === 0) {
    return Object.freeze({
      ...card, progressComingOnline: "No Product Contract cites this goal PRD yet.",
    });
  }
  const pending = outcome.contracts.some((contract) => contract.gate1 === "PENDING");
  const complete = criteria > 0 && verified === criteria && !pending;
  const gate = pending ? "Gate 1 pending" : "contract approved";
  // The lifecycle is the daemon fold of the goal aggregate; DONE is exactly COMPLETED.
  const lifecycle = outcome.goals.find((goal) => goal.goalId === card.goalId)?.lifecycle ?? null;
  const state: GoalCardModel["state"] = lifecycle === "COMPLETED" ? "DONE"
    : lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING" ? "ACTIVE" : card.state;
  return Object.freeze({
    ...card,
    headline: complete
      ? `All ${String(criteria)} acceptance criteria verified \u00b7 ${gate}`
      : `${String(verified)} of ${String(criteria)} acceptance criteria verified \u00b7 ${gate}`,
    headlineTone: complete ? "verified" : "accent",
    needsYou: pending,
    progress: criteria === 0 ? undefined : Object.freeze({
      done: verified, noun: "acceptance criteria verified", total: criteria,
    }),
    progressComingOnline: criteria === 0
      ? "The contract carries no acceptance criteria yet." : undefined,
    state,
  });
}

export function deriveGoalCatalog(
  frame: GoalCatalogFrame | null,
  coverage?: ReadonlyMap<string, DocumentCoverageOutcome>,
): GoalsData {
  if (frame === null) {
    return empty(
      "GOAL CATALOG COMING ONLINE",
      "Waiting for the daemon's durable goal catalog. Nothing is shown until it answers.",
    );
  }
  if (frame.connection === "DISCONNECTED") {
    return empty(
      `DISCONNECTED \u00b7 ${frame.detail}`,
      `The durable goal catalog was not delivered: ${frame.detail}.`,
    );
  }
  if (frame.outcome !== "GOALS") {
    return empty(
      `${frame.outcome} \u00b7 ${frame.detail}`,
      `The durable goal catalog answered ${frame.outcome}: ${frame.detail}.`,
    );
  }

  const goals = Object.freeze(frame.goals.map(
    (entry) => withCoverage(goalCard(entry), coverage?.get(entry.goalId)),
  ));
  return Object.freeze({
    comingOnlineNote: goals.length === 0 ? "This project has no durable goals yet." : undefined,
    goalCountLabel: `${String(goals.length)} GOAL${goals.length === 1 ? "" : "S"} \u00b7 DURABLE CATALOG`,
    goals,
    source: "live",
    triage: Object.freeze([]),
  });
}
