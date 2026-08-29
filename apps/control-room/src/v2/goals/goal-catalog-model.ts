import type {
  GoalCatalogFrame, LiveGoalCatalogEntry,
} from "../../live/live-goal-catalog.js";
import type {
  ComingOnlineFact, GoalCardModel, GoalFact, GoalsData,
} from "./goal-model.js";

/**
 * Turns the authenticated project's durable /goals/read answer into cards.
 *
 * The catalog supplies durable identity, Goal Brief prose, an optional PRD
 * binding, and the planning-run ref. It does not borrow task state from the
 * project affordance surface or invent progress, spend, timestamps,
 * acceptance, or human-attention state.
 */

const SOURCE_ROW = Object.freeze({ k: "SOURCE", v: "POST /goals/read" });

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
    truthClass: "DAEMON_VERIFIED",
    value: entry.goalId,
  });
  const runFact: GoalFact = Object.freeze({
    factId: `catalog.${entry.goalId}.planning-run`,
    label: "Planning run",
    note: "The planning-run reference stored with GoalCreated; opening this goal reads this exact ref.",
    rows: Object.freeze([SOURCE_ROW, Object.freeze({ k: "RUN", v: entry.planningRunRef })]),
    truthClass: "DAEMON_VERIFIED",
    value: entry.planningRunRef,
  });
  const briefFact: GoalFact | null = entry.brief === null ? null : Object.freeze({
    factId: `catalog.${entry.goalId}.brief`,
    label: "Goal brief",
    note: "Operator-authored instructions committed inside the GoalCreated decision.",
    rows: Object.freeze([SOURCE_ROW, Object.freeze({ k: "TITLE", v: entry.brief.title })]),
    truthClass: "DAEMON_VERIFIED",
    value: entry.brief.instructions,
  });
  const prdFact: GoalFact | null = entry.prd === null ? null : Object.freeze({
    factId: `catalog.${entry.goalId}.prd`,
    label: "PRD",
    note: "Goal-bound source text committed atomically with GoalCreated.",
    rows: Object.freeze([
      SOURCE_ROW,
      Object.freeze({ k: "SHA-256", v: entry.prd.contentSha256 }),
      Object.freeze({ k: "SOURCE", v: entry.prd.sourceRef }),
    ]),
    truthClass: "DAEMON_VERIFIED",
    value: `${entry.prd.displayPath} (${String(entry.prd.byteLength)} B)`,
  });
  const facts = Object.freeze([
    identityFact, runFact,
    ...(briefFact === null ? [] : [briefFact]),
    ...(prdFact === null ? [] : [prdFact]),
  ]);
  const comingOnlineFacts = entry.brief === null
    ? Object.freeze([Object.freeze({
      label: "Goal title",
      reason: "This legacy GoalCreated record predates durable Goal Brief prose; its id is shown verbatim.",
    }), ...COMING_ONLINE])
    : COMING_ONLINE;

  return Object.freeze({
    budgetComingOnline: "No budget read is joined to the goal catalog yet.",
    comingOnlineFacts,
    facts,
    goalId: entry.goalId,
    headline: `${entry.brief === null ? "Durable legacy goal" : "Durable goal brief"} \u00b7 planning run ${entry.planningRunRef}`,
    headlineFacts: facts,
    headlineTone: "verified",
    needsYou: false,
    progressComingOnline: "Node acceptance is not joined to the goal catalog yet.",
    planningRunRef: entry.planningRunRef,
    state: "DRAFT",
    title: entry.brief?.title ?? entry.goalId,
    titleIsIdentifier: entry.brief === null,
  });
}

export function deriveGoalCatalog(frame: GoalCatalogFrame | null): GoalsData {
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

  const goals = Object.freeze(frame.goals.map(goalCard));
  return Object.freeze({
    comingOnlineNote: goals.length === 0 ? "This project has no durable goals yet." : undefined,
    goalCountLabel: `${String(goals.length)} GOAL${goals.length === 1 ? "" : "S"} \u00b7 CURRENT PAGE`,
    goals,
    source: "live",
    triage: Object.freeze([]),
  });
}
