import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type {
  GoalCatalogFrame, LiveGoalCatalogEntry,
} from "../../live/live-goal-catalog.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { RunGoalView, RunsOutcome } from "../../live/live-runs.js";
import { deriveGoalGlance } from "./goal-glance.js";
import type {
  ComingOnlineFact, GoalCardModel, GoalFact, GoalsData, TriageStrip,
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
/** "Last activity 3 min ago" from an ISO instant; undefined when it does not parse. */
export function relativeActivityLabel(iso: string | null, nowMs: number): string | undefined {
  if (iso === null) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return "Last activity just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last activity ${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last activity ${String(hours)} h ago`;
  return `Last activity ${String(Math.round(hours / 24))} d ago`;
}

function withCoverage(
  card: GoalCardModel, outcome: DocumentCoverageOutcome | undefined, nowMs: number,
): GoalCardModel {
  if (outcome === undefined) return card;
  if (outcome.status !== "COVERAGE") {
    return outcome.status === "REFUSED" && outcome.code === "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND"
      ? Object.freeze({
        ...card, progressComingOnline: "No PRD is bound to this goal.",
        progressNote: "No PRD bound to this goal",
      })
      : card;
  }
  const { contracts, criteria, verified } = outcome.totals;
  const lastEventLabel = relativeActivityLabel(
    outcome.goals.find((goal) => goal.goalId === card.goalId)?.lastActivityAt ?? null, nowMs,
  );
  if (contracts === 0) {
    return Object.freeze({
      ...card, lastEventLabel, progressComingOnline: "No Product Contract cites this goal PRD yet.",
      progressNote: "No contract cites the PRD yet",
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
    lastEventLabel,
    needsYou: pending,
    progress: criteria === 0 ? undefined : Object.freeze({
      done: verified, noun: "acceptance criteria verified", total: criteria,
    }),
    progressComingOnline: criteria === 0
      ? "The contract carries no acceptance criteria yet." : undefined,
    state,
  });
}

/**
 * The runs read and the daemon's offers, when the live page holds them. With both, every
 * card says where its goal stands in the board's own words and the triage strips carry real
 * counts; without them (fixtures, tests, an unattached page) the coverage overlay stands.
 */
export interface GoalCatalogLive {
  /** The Needs-you items, so the strip counts DECISIONS exactly as the nav badge does. */
  readonly needsYou?: readonly { readonly goalId: string }[] | undefined;
  readonly runs: RunsOutcome | null;
  readonly surface: SurfaceFrame | null;
}

function runOf(runs: RunsOutcome | null, goalId: string): RunGoalView | undefined {
  if (runs === null || runs.status !== "RUNS") return undefined;
  return runs.goals.find((goal) => goal.goalId === goalId);
}

/** The glance overlay: the board's headline, state and node counts on the list card. */
function withGlance(
  card: GoalCardModel, entry: LiveGoalCatalogEntry, coverage: DocumentCoverageOutcome | undefined,
  live: GoalCatalogLive, nowMs: number,
): GoalCardModel {
  const glance = deriveGoalGlance({ coverage, entry, nowMs, run: runOf(live.runs, entry.goalId), surface: live.surface });
  // Before the daemon says anything about the goal the coverage overlay's words stand.
  if (glance.stage === "UNKNOWN") {
    return Object.freeze({ ...card, rank: glance.rank });
  }
  return Object.freeze({
    ...card,
    headline: glance.headline,
    headlineTone: glance.tone,
    needsYou: glance.needsYou,
    needsYouLabels: glance.needsYouLabels,
    nodesLine: glance.nodesLine ?? undefined,
    rank: glance.rank,
    state: glance.state,
  });
}

/** What needs a person now, as strips with counts; none when nothing does. */
function triageOf(goals: readonly GoalCardModel[], live: GoalCatalogLive): readonly TriageStrip[] {
  const strips: TriageStrip[] = [];
  // One count for "what needs you": the Needs-you items when the page holds them (a goal can
  // carry several), else the goals whose stage waits on a person.
  const items = live.needsYou ?? goals.filter((goal) => goal.needsYou).map((goal) => ({ goalId: goal.goalId }));
  if (items.length > 0) {
    const goalIds = [...new Set(items.map((item) => item.goalId))];
    const one = goalIds.length === 1 ? goals.find((goal) => goal.goalId === goalIds[0]) : undefined;
    strips.push(Object.freeze({
      count: String(items.length),
      id: "needs-you",
      label: items.length === 1 ? "Decision waiting on you" : "Decisions waiting on you",
      openGoalId: one?.goalId,
      sub: one === undefined
        ? "Plans, contracts, exhausted reviews, goals to close"
        : items.length === 1 ? one.needsYouLabels?.[0] ?? "" : `${String(items.length)} decisions on ${one.title}`,
      tone: "info",
    }));
  }
  const stuck = goals.filter((goal) => goal.state === "BLOCKED" || (goal.nodesLine ?? "").includes("stuck"));
  if (stuck.length > 0) {
    const one = stuck.length === 1 ? stuck[0] : undefined;
    strips.push(Object.freeze({
      count: String(stuck.length),
      id: "stuck",
      label: one === undefined ? "Goals with stuck work" : "Goal with stuck work",
      openGoalId: one?.goalId,
      sub: "A node sent back or blocked on a decision",
      tone: "danger",
    }));
  }
  const working = live.runs !== null && live.runs.status === "RUNS"
    ? live.runs.totals.IN_PROGRESS + live.runs.totals.DELIVERED : 0;
  if (working > 0) {
    strips.push(Object.freeze({
      count: String(working),
      id: "working",
      label: working === 1 ? "Node in progress" : "Nodes in progress",
      sub: "Agents working or awaiting the verifier",
      tone: "accent",
    }));
  }
  return Object.freeze(strips);
}

export function deriveGoalCatalog(
  frame: GoalCatalogFrame | null,
  coverage?: ReadonlyMap<string, DocumentCoverageOutcome>,
  nowMs: number = Date.now(),
  live?: GoalCatalogLive,
): GoalsData {
  if (frame === null) {
    return empty(
      "Waiting for goals",
      "Waiting for the daemon's durable goal catalog. Nothing is shown until it answers.",
    );
  }
  if (frame.connection === "DISCONNECTED") {
    return empty(
      "Could not reach the daemon",
      `The durable goal catalog was not delivered: ${frame.detail}.`,
    );
  }
  if (frame.outcome !== "GOALS") {
    return empty(
      "The goals could not be read",
      `The durable goal catalog answered ${frame.outcome}: ${frame.detail}.`,
    );
  }

  const goals = Object.freeze(frame.goals.map((entry) => {
    const card = withCoverage(goalCard(entry), coverage?.get(entry.goalId), nowMs);
    return live === undefined ? card : withGlance(card, entry, coverage?.get(entry.goalId), live, nowMs);
  }));
  return Object.freeze({
    comingOnlineNote: goals.length === 0 ? "This project has no durable goals yet." : undefined,
    goalCountLabel: `${String(goals.length)} goal${goals.length === 1 ? "" : "s"}`,
    goals,
    source: "live",
    triage: live === undefined ? Object.freeze([]) : triageOf(goals, live),
  });
}
