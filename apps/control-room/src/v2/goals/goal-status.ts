import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { PreviewReadOutcome } from "../../live/live-preview.js";
import { pauseResetWords } from "../shell/pause-context.js";
import type { ProviderPause } from "../shell/pause-context.js";
import { previewStage } from "./goal-status-preview.js";
import { planSentBack } from "./plan-run-resolution.js";
import { DEPENDS_TOKEN_PREFIX } from "./work-labels.js";

/**
 * WHERE A GOAL STANDS, in one line, and THE ONE THING TO DO NEXT. Derived from two daemon
 * answers the opened goal already reads - the PRD coverage (contracts, Gate 1 state,
 * verified criteria, lifecycle) and the affordance surface (what this session is offered,
 * which nodes are accepted, claimed or blocked) - and nothing else. The order below is the
 * order a goal moves through: a contract question or approval, the plan approval, agents
 * delivering, an exhausted review, closing, closed. The first stage whose facts hold wins.
 */

export type GoalStage =
  | "CLOSED"
  | "CONTRACT"
  | "ESCALATION"
  | "NO_PRD"
  | "PLAN"
  | "PLAN_REJECTED"
  | "PREVIEW"
  | "READY_TO_CLOSE"
  | "REPLANNED"
  | "UNKNOWN"
  | "WORKING";

export interface GoalNext {
  /** Where on the page the step lives; the strip links to it. */
  readonly anchor: "activity" | "board" | "contract" | "needs-you" | "plan" | null;
  readonly detail: string;
  readonly label: string;
}

export interface GoalStatus {
  readonly agents: {
    readonly accepted: number; readonly blocked: number; readonly replanned: number; readonly total: number;
    /** Nodes the daemon is holding until a dependency is accepted; never idle, never claimed. */
    readonly waiting: number;
    /** The distinct nodes they are held behind, in the order the surface listed them. */
    readonly waitingOn: readonly string[];
    readonly working: number;
  } | null;
  readonly headline: string;
  readonly next: GoalNext;
  readonly progress: { readonly criteria: number; readonly verified: number } | null;
  readonly stage: GoalStage;
}

const NODE_DELIVER = "node.deliver";
const OPEN_LIFECYCLES: readonly string[] = Object.freeze(["EXECUTION_ENABLED", "CLOSING"]);

function offered(surface: SurfaceFrame | null, commandKind: string, target: string | null): boolean {
  if (surface === null || surface.outcome !== "SURFACE") return false;
  return surface.offers.some((offer) =>
    offer["commandKind"] === commandKind && (target === null || offer["targetAggregateId"] === target));
}

/**
 * The surface is project-wide, so node steps are scoped to THIS goal by the node keys its
 * contract's criteria name. Without a readable contract the scope cannot be known, and no
 * node is counted rather than another goal's.
 */
function nodeSteps(surface: SurfaceFrame | null, nodeKeys: ReadonlySet<string> | null): readonly SurfaceStep[] {
  if (surface === null || surface.outcome !== "SURFACE" || nodeKeys === null) return [];
  return surface.steps.filter((step) => step.kind === NODE_DELIVER && step.aggregateId !== null && nodeKeys.has(step.aggregateId));
}

function nodeKeysOf(coverage: DocumentCoverageOutcome | null): ReadonlySet<string> | null {
  if (coverage === null || coverage.status !== "COVERAGE") return null;
  const keys = new Set<string>();
  for (const contract of coverage.contracts) {
    for (const requirement of contract.requirements) {
      for (const criterion of requirement.criteria) if (criterion.nodeKey !== null) keys.add(criterion.nodeKey);
    }
  }
  return keys;
}

/**
 * The nodes this one is held behind. The daemon spells the token `depends:<nodeKey>`, so it is
 * read by PREFIX - an exact match on the bare word would never fire and the count would be a
 * permanent zero. A prefix carrying no key names no node and is left to the raw-token path.
 */
function blockersOf(step: SurfaceStep): readonly string[] {
  if (step.status !== "BLOCKED") return [];
  return step.missing
    .filter((token) => token.startsWith(DEPENDS_TOKEN_PREFIX))
    .map((token) => token.slice(DEPENDS_TOKEN_PREFIX.length))
    .filter((nodeKey) => nodeKey.length > 0);
}

function agentsOf(steps: readonly SurfaceStep[]): GoalStatus["agents"] {
  if (steps.length === 0) return null;
  // Folded once per step, so the count of waiting NODES and the list of blocking NODES can never
  // disagree about which steps are held: a node waiting on two parents is ONE waiting node, and
  // two nodes behind one parent name that parent once.
  const blockers = steps.map(blockersOf);
  return Object.freeze({
    accepted: steps.filter((step) => step.status === "COMMITTED").length,
    blocked: steps.filter((step) => step.status === "BLOCKED" && step.missing.includes("escalation")).length,
    replanned: steps.filter((step) => step.status === "BLOCKED" && step.missing.includes("replan")).length,
    total: steps.length,
    waiting: blockers.filter((held) => held.length > 0).length,
    waitingOn: Object.freeze([...new Set(blockers.flat())]),
    working: steps.filter((step) => step.status !== "COMMITTED" && step.claim !== null).length,
  });
}

/**
 * A node list an operator reads aloud: "n1", "n1 and n2", "n1, n2 and n3". A wide graph is
 * summarised rather than recited - "n1, n2, n3 and 4 more" - because a sentence naming twelve
 * node keys is a sentence nobody finishes, and the board below carries the full build order.
 */
const NAMED_BLOCKERS = 3;

function nodeWords(keys: readonly string[]): string {
  const named = keys.slice(0, NAMED_BLOCKERS);
  const rest = keys.length - named.length;
  const tail = rest > 0 ? `${String(rest)} more` : named[named.length - 1] ?? "";
  const lead = rest > 0 ? named : named.slice(0, -1);
  if (lead.length === 0) return tail;
  return `${lead.join(", ")} and ${tail}`;
}

/**
 * What the board is doing, for a goal that is neither waiting on a person nor finished. Nodes
 * held behind build order are NOT idle, so they are named before the claimed count - otherwise
 * a three-node goal with two nodes queued reads as "0 nodes are claimed right now", which an
 * operator can only read as a stalled goal.
 */
function workingDetail(agents: NonNullable<GoalStatus["agents"]>): string {
  if (agents.total - agents.accepted === 0) return "Every node is accepted; the verifier's last acceptance is on the board.";
  const claimed = `${String(agents.working)} ${agents.working === 1 ? "node is" : "nodes are"} claimed right now.`;
  if (agents.waiting === 0) return `${claimed} Nothing needs you until a review is exhausted.`;
  const queued = `${String(agents.waiting)} ${agents.waiting === 1 ? "node is" : "nodes are"} waiting for ${nodeWords(agents.waitingOn)} to be accepted first`;
  return `${queued}; ${claimed[0]?.toLowerCase() ?? ""}${claimed.slice(1)} Nothing needs you until a review is exhausted.`;
}

function status(stage: GoalStage, headline: string, next: GoalNext, extra: {
  readonly agents?: GoalStatus["agents"]; readonly progress?: GoalStatus["progress"];
} = {}): GoalStatus {
  return Object.freeze({ agents: extra.agents ?? null, headline, next, progress: extra.progress ?? null, stage });
}

/**
 * The one thing to do while the provider is paused: nothing, until the limit resets. Only
 * the WORKING stage asks it - a goal waiting on a contract, an escalation or a close is
 * waiting on a PERSON, and a paused wrapper does not change what that person should do.
 * The wrapper serves one provider, so a pause raised on another goal's node still stops
 * this goal's agents; the detail names the item that hit the limit so that is visible.
 */
function pausedNext(paused: ProviderPause): GoalNext {
  return {
    anchor: "board",
    detail: `The ${paused.provider} seat hit its limit on ${paused.workItemId}; the wrapper staffs again at ${paused.resetAt}.`,
    label: `Waiting for the provider limit to reset at ${pauseResetWords(paused)}`,
  };
}

export function deriveGoalStatus(input: {
  readonly coverage: DocumentCoverageOutcome | null;
  readonly goalId: string;
  /** The shell-wide provider pause, or null when none is known. Only WORKING reads it. */
  readonly paused?: ProviderPause | null | undefined;
  /** This goal's preview receipt read, or null/absent when it has not answered. */
  readonly preview?: PreviewReadOutcome | null | undefined;
  readonly runId: string;
  readonly surface: SurfaceFrame | null;
}): GoalStatus {
  const { coverage, goalId, runId, surface } = input;
  const paused = input.paused ?? null;
  const steps = nodeSteps(surface, nodeKeysOf(coverage));
  const agents = agentsOf(steps);

  if (coverage !== null && coverage.status === "REFUSED" && coverage.code === "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND") {
    return status("NO_PRD", "This goal was created without a PRD.", {
      anchor: "plan", detail: "There is no contract to verify against; the plan below is what the daemon holds.", label: "Read the plan",
    }, { agents });
  }
  const covered = coverage !== null && coverage.status === "COVERAGE" ? coverage : null;
  const goal = covered?.goals.find((row) => row.goalId === goalId);
  const lifecycle = goal?.lifecycle ?? null;
  const progress = covered === null || covered.totals.criteria === 0
    ? null : Object.freeze({ criteria: covered.totals.criteria, verified: covered.totals.verified });

  if (lifecycle === "COMPLETED") {
    return status("CLOSED", "This goal is closed.", {
      anchor: "activity", detail: "Everything below is the record of what was decided and delivered.", label: "Read the record",
    }, { agents, progress });
  }
  if (covered !== null && covered.contracts.some((contract) => contract.gate1 === "PENDING")) {
    return status("CONTRACT", "The Product Contract is waiting at Gate 1.", {
      anchor: "contract",
      detail: "Answer any open question and approve the contract; the daemon compiles the plan from it.",
      label: "Review the contract",
    }, { agents, progress });
  }
  if (offered(surface, "approval.decide_intent", runId)) {
    return status("PLAN", "The plan is waiting for your approval.", {
      anchor: "plan", detail: "Read the steps and the acceptance criteria, then approve to start the agents.", label: "Review the plan",
    }, { agents, progress });
  }
  // AFTER the PLAN branch, never before it: the frame that offers the successor for approval
  // is the same frame on which `planSentBack` goes false, so checking this first would only
  // ever shadow a decision the operator can actually make.
  if (planSentBack(surface, goalId, runId)) {
    return status("PLAN_REJECTED", "You sent this plan back; the daemon is compiling a new one.", {
      anchor: "plan",
      detail: "The successor run is being compiled from your reason. Nothing needs you until it"
        + " is offered for approval.",
      label: "Waiting for a new plan",
    }, { agents, progress });
  }
  if (agents !== null && agents.replanned > 0 && agents.replanned + agents.accepted === agents.total) {
    return status("REPLANNED", `${String(agents.replanned)} ${agents.replanned === 1 ? "node was" : "nodes were"} replanned into a successor goal.`, {
      anchor: "board",
      detail: "The findings that led here are on the board. Close this goal once the successor's work is verified.",
      label: "Read the findings",
    }, { agents, progress });
  }
  if (agents !== null && agents.blocked > 0 && offered(surface, "escalation.decide", null)) {
    return status("ESCALATION", `${String(agents.blocked)} ${agents.blocked === 1 ? "node has" : "nodes have"} used every review attempt.`, {
      anchor: "needs-you", detail: "Allow more attempts from Needs you, or read the findings on the board to see what kept failing.", label: "Decide the escalation",
    }, { agents, progress });
  }
  // BEFORE READY_TO_CLOSE on purpose: a product that is up and waiting for a verdict is what
  // the operator should look at, even once every criterion is verified.
  const gate2 = previewStage(input.preview);
  if (gate2 !== null) return status(gate2.stage, gate2.headline, gate2.next, { agents, progress });
  const complete = progress !== null && progress.verified === progress.criteria
    && covered !== null && covered.contracts.length > 0;
  if (complete && OPEN_LIFECYCLES.includes(lifecycle ?? "")) {
    const canClose = offered(surface, "goal.close", goalId);
    return status("READY_TO_CLOSE", `All ${String(progress.criteria)} acceptance criteria are verified.`, {
      anchor: canClose ? "needs-you" : "board",
      detail: canClose
        ? "Close the goal from Needs you when you are satisfied with the evidence."
        : "The daemon is not offering to close it yet; the board says why.",
      label: canClose ? "Close the goal" : "Read the board",
    }, { agents, progress });
  }
  if (agents !== null) {
    return status("WORKING", `Agents are working: ${String(agents.accepted)} of ${String(agents.total)} nodes accepted.`, paused !== null ? pausedNext(paused) : {
      anchor: "board",
      detail: workingDetail(agents),
      label: "Watch the board",
    }, { agents, progress });
  }
  return status("UNKNOWN", "Waiting for the daemon to say where this goal stands.", {
    anchor: null, detail: "The coverage and the board are still being read.", label: "Wait",
  }, { progress });
}
