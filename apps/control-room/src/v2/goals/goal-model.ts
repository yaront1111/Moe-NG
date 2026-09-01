import type { GoalSource } from "@moe/contracts";

import type { ProofRow } from "../shell/proof-context.js";

/**
 * Shared goals-home presentation and goal-creation contracts. Production readers
 * derive these values from daemon-owned durable sources; the presentation never
 * gains authority by filling a missing fact itself.
 */

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
