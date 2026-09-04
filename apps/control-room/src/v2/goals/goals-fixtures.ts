import type {
  ComingOnlineFact,
  GoalCardModel,
  GoalFact,
  GoalStateLabel,
  GoalsData,
  HeadlineTone,
  TriageStrip,
} from "./goal-model.js";

/**
 * The frozen three-goal design dataset, transcribed from the product owner's
 * export ("Moe Control Room.dc.html", goalData/attention). It is shown ONLY in
 * fixtures mode (?v2=1&fixtures=1) so the screen reproduces his design; the live
 * path never renders it. Nothing here is inferred - every value, class, and note
 * is copied from the design so the fixture and the picture agree.
 *
 * Non-ASCII punctuation is written as \uXXXX escapes to keep the source ASCII.
 */

/** A design fact tuple: [label, value, truthClass, note?]. */
type FactSpec = readonly [string, string, string, string?];

const NO_COMING_ONLINE: readonly ComingOnlineFact[] = Object.freeze([]);

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function factsFrom(prefix: string, specs: readonly FactSpec[]): readonly GoalFact[] {
  return specs.map(([label, value, truthClass, note], index) => Object.freeze({
    factId: `${prefix}.${String(index)}.${slug(label)}`,
    label,
    value,
    truthClass,
    note,
  }));
}

interface GoalSpec {
  readonly goalId: string;
  readonly title: string;
  readonly state: GoalStateLabel;
  readonly needsYou: boolean;
  readonly last: string;
  readonly headline: string;
  readonly tone: HeadlineTone;
  readonly done: number;
  readonly total: number;
  readonly budget: string;
  readonly budgetClass: string;
  readonly headlineFacts: readonly FactSpec[];
  readonly facts: readonly FactSpec[];
}

const GOAL_SPECS: readonly GoalSpec[] = [
  {
    goalId: "goal-j1",
    title: "Ship the J1 vertical slice",
    state: "ACTIVE",
    needsYou: true,
    last: "42s ago",
    headline: "1 approval waiting on you \u00b7 1 lease went SUSPECT",
    tone: "agent",
    done: 2,
    total: 3,
    budget: "48 min spent \u00b7 12 min unknown",
    budgetClass: "UNKNOWN",
    headlineFacts: [
      ["Ready", "1 node", "DAEMON_VERIFIED"],
      ["Approvals", "1 pending", "HUMAN_APPROVED"],
      ["SUSPECT", "1 lease", "OBSERVED"],
    ],
    facts: [
      ["State", "ACTIVE", "OBSERVED"],
      ["Phases", "2 plan / 1 exec / 1 review", "OBSERVED"],
      ["Provider capacity", "1 of 2 sessions", "DAEMON_VERIFIED"],
      ["Ready width", "1 node", "DAEMON_VERIFIED"],
      ["Frontier", "1 ready, 1 blocked", "OBSERVED"],
      ["Spent", "48 min", "DAEMON_VERIFIED"],
      ["Reserved", "30 min", "DAEMON_VERIFIED"],
      ["Quarantined", "0 min", "DAEMON_VERIFIED"],
      ["Budget unknown", "12 min", "UNKNOWN",
        "Two attempt records carry no effort interval; the daemon refuses to impute one."],
      ["Basis", "receipt intervals", "DAEMON_VERIFIED"],
      ["Approvals", "1 pending", "HUMAN_APPROVED"],
      ["Held", "0", "OBSERVED"],
      ["SUSPECT leases", "1", "OBSERVED"],
      ["Reconciliation", "clean at seq 8412", "DAEMON_VERIFIED"],
      ["Last event", "42s ago", "OBSERVED"],
      ["Completion", "2 of 3 nodes accepted", "DAEMON_VERIFIED"],
    ],
  },
  {
    goalId: "goal-import",
    title: "Deterministic read-only legacy import",
    state: "ACTIVE",
    needsYou: false,
    last: "6m ago",
    headline: "Both nodes waiting on capacity \u00b7 nothing needs you",
    tone: "accent",
    done: 0,
    total: 2,
    budget: "112 min spent \u00b7 9 min quarantined",
    budgetClass: "DAEMON_VERIFIED",
    headlineFacts: [
      ["Ready", "0 nodes", "DAEMON_VERIFIED"],
      ["Held", "1 output", "OBSERVED"],
      ["Reconciliation", "UNKNOWN", "UNKNOWN"],
    ],
    facts: [
      ["State", "ACTIVE", "OBSERVED"],
      ["Phases", "1 plan / 1 exec", "OBSERVED"],
      ["Provider capacity", "2 of 2 sessions", "DAEMON_VERIFIED"],
      ["Ready width", "0 nodes", "DAEMON_VERIFIED"],
      ["Frontier", "0 ready, 2 waiting", "OBSERVED"],
      ["Spent", "112 min", "DAEMON_VERIFIED"],
      ["Reserved", "0 min", "DAEMON_VERIFIED"],
      ["Quarantined", "9 min", "DAEMON_VERIFIED"],
      ["Budget unknown", "0 min", "DAEMON_VERIFIED"],
      ["Basis", "receipt intervals", "DAEMON_VERIFIED"],
      ["Approvals", "0 pending", "OBSERVED"],
      ["Held", "1", "OBSERVED"],
      ["SUSPECT leases", "0", "OBSERVED"],
      ["Reconciliation", "UNKNOWN", "UNKNOWN",
        "The reconciliation sweep has not run at this cursor. Absence is not cleanliness."],
      ["Last event", "6m ago", "OBSERVED"],
      ["Completion", "0 of 2 nodes accepted", "DAEMON_VERIFIED"],
    ],
  },
  {
    goalId: "goal-recovery",
    title: "Genesis recovery binding on a fresh store",
    state: "BLOCKED",
    needsYou: true,
    last: "31m ago",
    headline: "Blocked 31m on a human decision \u00b7 no agent can proceed",
    tone: "danger",
    done: 0,
    total: 1,
    budget: "27 min spent \u00b7 0 min unknown",
    budgetClass: "DAEMON_VERIFIED",
    headlineFacts: [
      ["Approvals", "1 pending 31m", "HUMAN_APPROVED"],
      ["Capacity", "0 of 2", "DAEMON_VERIFIED"],
      ["Held", "1 output", "OBSERVED"],
    ],
    facts: [
      ["State", "BLOCKED", "OBSERVED"],
      ["Phases", "1 review", "OBSERVED"],
      ["Provider capacity", "0 of 2 sessions", "DAEMON_VERIFIED"],
      ["Ready width", "0 nodes", "DAEMON_VERIFIED"],
      ["Frontier", "blocked on human decision", "OBSERVED"],
      ["Spent", "27 min", "DAEMON_VERIFIED"],
      ["Reserved", "0 min", "DAEMON_VERIFIED"],
      ["Quarantined", "0 min", "DAEMON_VERIFIED"],
      ["Budget unknown", "0 min", "DAEMON_VERIFIED"],
      ["Basis", "receipt intervals", "DAEMON_VERIFIED"],
      ["Approvals", "1 pending 31m", "HUMAN_APPROVED"],
      ["Held", "1", "OBSERVED"],
      ["SUSPECT leases", "0", "OBSERVED"],
      ["Reconciliation", "clean at seq 8390", "DAEMON_VERIFIED"],
      ["Last event", "31m ago", "OBSERVED"],
      ["Completion", "0 of 1 nodes accepted", "AGENT_REPORTED"],
    ],
  },
];

function goalFrom(spec: GoalSpec): GoalCardModel {
  return Object.freeze({
    goalId: spec.goalId,
    title: spec.title,
    titleIsIdentifier: false,
    state: spec.state,
    needsYou: spec.needsYou,
    headline: spec.headline,
    headlineTone: spec.tone,
    progress: { done: spec.done, total: spec.total, noun: "accepted" },
    lastEventLabel: spec.last,
    budgetLabel: spec.budget,
    budgetTruthClass: spec.budgetClass,
    headlineFacts: factsFrom(`goal.${spec.goalId}.h`, spec.headlineFacts),
    facts: factsFrom(`goal.${spec.goalId}.f`, spec.facts),
    comingOnlineFacts: NO_COMING_ONLINE,
  });
}

const FIXTURE_TRIAGE: readonly TriageStrip[] = Object.freeze([
  Object.freeze({
    id: "approvals",
    count: "2",
    label: "Approvals waiting on you",
    sub: "oldest 31m \u00b7 both block a goal",
    tone: "info",
  }),
  Object.freeze({
    id: "suspect",
    count: "1",
    label: "SUSPECT lease",
    sub: "node-31 quiet 41m while renewing",
    tone: "danger",
    openGoalId: "goal-j1",
  }),
  Object.freeze({
    id: "capacity",
    count: "1",
    label: "Ready, no capacity",
    sub: "node-21 rechecks in 30s",
    tone: "agent",
    openGoalId: "goal-j1",
  }),
]);

/** The frozen design view, shown only under ?v2=1&fixtures=1. */
export const FIXTURE_GOALS_DATA: GoalsData = Object.freeze({
  source: "fixtures",
  goals: Object.freeze(GOAL_SPECS.map(goalFrom)),
  triage: FIXTURE_TRIAGE,
  goalCountLabel: "3 GOALS \u00b7 CURSOR SEQ 8412",
});
