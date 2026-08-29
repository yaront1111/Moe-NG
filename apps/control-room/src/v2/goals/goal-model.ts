import type { GoalSource } from "@moe/contracts";

import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import type { ProofRow } from "../shell/proof-context.js";

/**
 * The goals-home data model (UI-3), kept pure so every arm can be asserted by
 * value and the presentation stays dumb.
 *
 * The daemon stays the authority. `deriveLiveGoals` reads ONLY what the live
 * affordance surface (POST /affordances/read) actually carries - step statuses,
 * missing prerequisites, and durable claims - and derives the one goal that
 * surface stands for. Everything the surface does NOT carry (a goal's budget and
 * spend, node acceptance, SUSPECT-lease detection, the 16-fact bundle, any second
 * goal) is returned as an explicit "coming online" marker, never as a fabricated
 * number. The frozen three-goal design view lives in `goals-fixtures.ts` and is
 * only ever shown in fixtures mode.
 */

/** The single dev goal the live affordance surface stands for. */
export const LIVE_GOAL_ID = "goal-live-1";

export type GoalStateLabel = "ACTIVE" | "BLOCKED" | "DRAFT";

/** The coloured status dot beside a goal's one-line headline. */
export type HeadlineTone = "accent" | "agent" | "danger" | "verified";

export type TriageTone = "info" | "danger" | "agent" | "accent" | "verified";

/** A single claimed fact: a value carrying the class it was supplied with. */
export interface GoalFact {
  readonly factId: string;
  readonly label: string;
  readonly value: string;
  /** A daemon truth-class token, or undefined for a value with no class. */
  readonly truthClass?: unknown;
  readonly note?: string | undefined;
  /** The receipt rows the proof drawer shows behind this claim. */
  readonly rows?: readonly ProofRow[] | undefined;
}

/** A field the live surface cannot source yet: named plainly, never a zero. */
export interface ComingOnlineFact {
  readonly label: string;
  readonly reason: string;
}

/** Progress carries its own noun so "accepted" (goal) and "committed" (surface) never blur. */
export interface GoalProgress {
  readonly done: number;
  readonly total: number;
  readonly noun: string;
}

export interface GoalCardModel {
  readonly goalId: string;
  /** The durable planning-run ref stored with GoalCreated, when this card came from the catalog. */
  readonly planningRunRef?: string | undefined;
  readonly title: string;
  /** true when `title` is the raw goal id (no durable prose exists yet). */
  readonly titleIsIdentifier: boolean;
  readonly state: GoalStateLabel;
  /** true when the goal has something waiting on a human decision. */
  readonly needsYou: boolean;
  readonly headline: string;
  readonly headlineTone: HeadlineTone;
  /** undefined means acceptance progress is coming online (see progressComingOnline). */
  readonly progress?: GoalProgress | undefined;
  readonly progressComingOnline?: string | undefined;
  /** undefined means the last-event time is coming online. */
  readonly lastEventLabel?: string | undefined;
  /** undefined means budget/spend is coming online (see budgetComingOnline). */
  readonly budgetLabel?: string | undefined;
  readonly budgetTruthClass?: unknown;
  readonly budgetComingOnline?: string | undefined;
  readonly headlineFacts: readonly GoalFact[];
  readonly facts: readonly GoalFact[];
  readonly comingOnlineFacts: readonly ComingOnlineFact[];
}

export interface TriageStrip {
  readonly id: string;
  readonly count: string;
  readonly label: string;
  readonly sub: string;
  readonly tone: TriageTone;
  /** When set, selecting the strip opens this goal's board. */
  readonly openGoalId?: string | undefined;
}

export interface GoalsData {
  readonly source: "live" | "fixtures";
  readonly goals: readonly GoalCardModel[];
  readonly triage: readonly TriageStrip[];
  readonly goalCountLabel: string;
  /** Shown as an honest empty state when no goals can be listed. */
  readonly comingOnlineNote?: string | undefined;
}

/* ---------------------------------------------------------- live derivation --- */

const SURFACE_SOURCE_ROW: ProofRow = Object.freeze({ k: "SOURCE", v: "POST /affordances/read" });

function surfaceRows(extra: readonly ProofRow[]): readonly ProofRow[] {
  return Object.freeze([SURFACE_SOURCE_ROW, ...extra]);
}

/** The coming-online fields every live goal carries: the surface simply lacks them. */
const LIVE_COMING_ONLINE: readonly ComingOnlineFact[] = Object.freeze([
  Object.freeze({
    label: "Budget envelope",
    reason: "No budget route answers the goals surface yet; spend is not on /affordances/read.",
  }),
  Object.freeze({
    label: "Time spent",
    reason: "Spend is derived from receipt intervals the affordance surface does not carry.",
  }),
  Object.freeze({
    label: "Node acceptance",
    reason: "Goal completion (nodes accepted) is not reported by the affordance surface.",
  }),
  Object.freeze({
    label: "SUSPECT leases",
    reason: "Activity-vs-renewal silence is a per-lease read the goals surface does not carry.",
  }),
  Object.freeze({
    label: "Supplied-facts bundle",
    reason: "The 16-fact goal bundle is a later route; only surface-derived facts show here.",
  }),
]);

function emptyLive(goalCountLabel: string, comingOnlineNote: string): GoalsData {
  return Object.freeze({
    source: "live",
    goals: Object.freeze([]),
    triage: Object.freeze([]),
    goalCountLabel,
    comingOnlineNote,
  });
}

function stateOf(readyCount: number, claimedCount: number, blockedCount: number): GoalStateLabel {
  if (readyCount === 0 && claimedCount === 0 && blockedCount > 0) return "BLOCKED";
  return "ACTIVE";
}

function headlineOf(
  readyNoClaim: number, claimed: number, blocked: number, committed: number, total: number,
): { readonly text: string; readonly tone: HeadlineTone } {
  const parts: string[] = [];
  if (readyNoClaim > 0) parts.push(`${String(readyNoClaim)} ready to dispatch`);
  if (claimed > 0) parts.push(`${String(claimed)} in progress`);
  if (blocked > 0) parts.push(`${String(blocked)} waiting on prerequisites`);
  if (parts.length === 0) {
    const text = committed === total && total > 0
      ? "Every step on the surface is committed"
      : "Nothing is offered on the surface right now";
    return { text, tone: committed === total && total > 0 ? "verified" : "accent" };
  }
  const tone: HeadlineTone = blocked > 0 && readyNoClaim === 0 && claimed === 0
    ? "danger"
    : claimed > 0 ? "agent" : "accent";
  // Separator U+00B7 kept as an escape so the source stays ASCII.
  return { text: parts.join(" \u00b7 "), tone };
}

function claimFactsOf(claimed: readonly SurfaceStep[]): readonly GoalFact[] {
  return claimed.map((step, index) => {
    const claim = step.claim;
    const holder = claim === null ? "unknown" : claim.claimedBy;
    return Object.freeze({
      factId: `live.claim.${String(index)}`,
      label: `Holding ${step.kind}`,
      value: holder,
      truthClass: "OBSERVED",
      note: "A durable claim on the affordance surface: dispatching this step would race its holder.",
      rows: surfaceRows([
        { k: "STEP", v: step.kind },
        { k: "TARGET", v: step.aggregateId ?? "\u2014" },
        { k: "CLAIMED BY", v: holder },
        { k: "EXPIRES", v: claim === null ? "\u2014" : claim.expiresAt },
      ]),
    });
  });
}

/**
 * Derive the one goal the live affordance surface stands for. Never invents a
 * second goal, a budget, or an acceptance count; the fields the surface cannot
 * source are carried as coming-online markers on the card.
 */
export function deriveLiveGoals(frame: SurfaceFrame | null): GoalsData {
  if (frame === null) {
    return emptyLive(
      "AFFORDANCE SURFACE COMING ONLINE",
      "Waiting for the daemon's first affordance surface. Nothing is shown until it answers.",
    );
  }
  if (frame.connection === "DISCONNECTED") {
    return emptyLive(
      "DISCONNECTED",
      "Disconnected from the daemon. The goals surface shows nothing it cannot currently read.",
    );
  }
  if (frame.outcome !== "SURFACE") {
    const code = frame.detail === "" ? frame.outcome : frame.detail;
    return emptyLive(
      code,
      `The affordance surface answered ${frame.outcome}. Its code renders verbatim: ${code}.`,
    );
  }

  const steps = frame.steps;
  if (steps.length === 0) {
    return emptyLive(
      "0 GOALS \u00b7 SURFACE EMPTY",
      "The affordance surface answered but offers no steps yet. Nothing is fabricated.",
    );
  }

  const ready = steps.filter((step) => step.status === "READY");
  const readyNoClaim = ready.filter((step) => step.claim === null);
  const blocked = steps.filter((step) => step.status === "BLOCKED");
  const committed = steps.filter((step) => step.status === "COMMITTED");
  const claimed = steps.filter((step) => step.claim !== null);

  const state = stateOf(ready.length, claimed.length, blocked.length);
  const headline = headlineOf(
    readyNoClaim.length, claimed.length, blocked.length, committed.length, steps.length,
  );

  const headlineFacts: GoalFact[] = [
    {
      factId: "live.ready",
      label: "Ready",
      value: `${String(ready.length)} step${ready.length === 1 ? "" : "s"}`,
      truthClass: "DAEMON_VERIFIED",
      note: "Readiness is computed by the daemon from the durable ledger.",
      rows: surfaceRows([{ k: "OUTCOME", v: "SURFACE" }, { k: "READY", v: String(ready.length) }]),
    },
    {
      factId: "live.blocked",
      label: "Blocked",
      value: `${String(blocked.length)} step${blocked.length === 1 ? "" : "s"}`,
      truthClass: "OBSERVED",
      note: "Steps the surface reports as waiting on a prerequisite.",
      rows: surfaceRows([{ k: "BLOCKED", v: String(blocked.length) }]),
    },
    {
      factId: "live.committed",
      label: "Committed",
      value: `${String(committed.length)} step${committed.length === 1 ? "" : "s"}`,
      truthClass: "DAEMON_VERIFIED",
      note: "Steps the ledger has already committed.",
      rows: surfaceRows([{ k: "COMMITTED", v: String(committed.length) }]),
    },
  ];

  const facts: GoalFact[] = [
    {
      factId: "live.state",
      label: "State",
      value: state,
      truthClass: "OBSERVED",
      rows: surfaceRows([{ k: "READY", v: String(ready.length) }, { k: "BLOCKED", v: String(blocked.length) }]),
    },
    ...headlineFacts,
    {
      factId: "live.total",
      label: "Steps on surface",
      value: String(steps.length),
      truthClass: "OBSERVED",
      rows: surfaceRows([{ k: "STEPS", v: String(steps.length) }]),
    },
    ...claimFactsOf(claimed),
  ];

  const triage: TriageStrip[] = [];
  if (readyNoClaim.length > 0) {
    triage.push({
      id: "ready",
      count: String(readyNoClaim.length),
      label: "Ready to dispatch",
      sub: "steps the daemon marks READY with no active claim",
      tone: "accent",
      openGoalId: LIVE_GOAL_ID,
    });
  }
  if (blocked.length > 0) {
    const missing = blocked[0]?.missing ?? [];
    triage.push({
      id: "blocked",
      count: String(blocked.length),
      label: "Waiting on prerequisites",
      sub: missing.length === 0 ? "prerequisites not yet met" : `needs ${missing.join(", ")}`,
      tone: "danger",
      openGoalId: LIVE_GOAL_ID,
    });
  }
  if (claimed.length > 0) {
    const claim = claimed[0]?.claim ?? null;
    triage.push({
      id: "claimed",
      count: String(claimed.length),
      label: "Agents holding work",
      sub: claim === null ? "a durable claim is active" : `${claim.claimedBy} until ${claim.expiresAt}`,
      tone: "info",
      openGoalId: LIVE_GOAL_ID,
    });
  }

  const goal: GoalCardModel = {
    goalId: LIVE_GOAL_ID,
    title: LIVE_GOAL_ID,
    titleIsIdentifier: true,
    state,
    needsYou: state === "BLOCKED",
    headline: headline.text,
    headlineTone: headline.tone,
    progress: { done: committed.length, total: steps.length, noun: "committed" },
    progressComingOnline: "Node acceptance is not on the affordance surface; the bar counts committed steps.",
    lastEventLabel: undefined,
    budgetLabel: undefined,
    budgetComingOnline: "No budget route answers the goals surface yet.",
    headlineFacts,
    facts,
    comingOnlineFacts: LIVE_COMING_ONLINE,
  };

  return Object.freeze({
    source: "live",
    goals: Object.freeze([Object.freeze(goal)]),
    triage: Object.freeze(triage),
    goalCountLabel: `1 GOAL \u00b7 ${String(steps.length)} STEP${steps.length === 1 ? "" : "S"} ON SURFACE`,
  });
}

export type AdvisoryRiskClass = "STANDARD" | "ELEVATED" | "RESTRICTED";

/**
 * A PRD the operator selected and the BROWSER read. `localSha256` is computed
 * here over the bytes this page loaded - it is not a daemon ingest receipt and
 * carries no authority. A file the browser could not read is absent entirely
 * rather than represented as an empty or failed member.
 *
 * `text` is the PAYLOAD, not a preview: the source travels INSIDE the
 * goal-creation command as one atomic write, so the bytes must survive to the
 * dispatcher. They are already resident in this page, so carrying them here
 * publishes nothing new. `mediaType` is DERIVED from the name this browser read,
 * never the `type` the platform claimed, and is narrowed to the shared admitted
 * roster so a draft cannot carry one the daemon's contract would refuse.
 */
export interface GoalDraftPrd {
  readonly localSha256: string;
  readonly mediaType: GoalSource["mediaType"];
  readonly name: string;
  readonly size: number;
  readonly text: string;
}

/**
 * A goal draft the form records before goal.create. The prose members are
 * ADVISORY project intake, but `prd.text` is not: it is the source payload the
 * create command carries, so a draft is no longer an advisory record alone.
 */
export interface GoalDraft {
  readonly outcome: string;
  /** The operator's own goal title; the shared brief contract requires one. */
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
  readonly budgetEnvelope: string;
  readonly riskClass?: AdvisoryRiskClass | undefined;
  /** A PRD this browser read, bytes included; present only when a read succeeded. */
  readonly prd?: GoalDraftPrd | undefined;
}

/** A create attempt report; only ok=true permits the form to discard its draft. */
export interface GoalCreateResult {
  /** The accepted command's id, present only on ok; a LOOKUP KEY, never a rendered goal. */
  readonly commandId?: string | undefined;
  readonly ok: boolean;
  readonly report: string;
}
