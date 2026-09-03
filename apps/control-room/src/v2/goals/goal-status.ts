import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";

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
  | "READY_TO_CLOSE"
  | "UNKNOWN"
  | "WORKING";

export interface GoalNext {
  /** Where on the page the step lives; the strip links to it. */
  readonly anchor: "activity" | "board" | "contract" | "needs-you" | "plan" | null;
  readonly detail: string;
  readonly label: string;
}

export interface GoalStatus {
  readonly agents: { readonly accepted: number; readonly blocked: number; readonly total: number; readonly working: number } | null;
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

function agentsOf(steps: readonly SurfaceStep[]): GoalStatus["agents"] {
  if (steps.length === 0) return null;
  return Object.freeze({
    accepted: steps.filter((step) => step.status === "COMMITTED").length,
    blocked: steps.filter((step) => step.status === "BLOCKED" && step.missing.includes("escalation")).length,
    total: steps.length,
    working: steps.filter((step) => step.status !== "COMMITTED" && step.claim !== null).length,
  });
}

function status(stage: GoalStage, headline: string, next: GoalNext, extra: {
  readonly agents?: GoalStatus["agents"]; readonly progress?: GoalStatus["progress"];
} = {}): GoalStatus {
  return Object.freeze({ agents: extra.agents ?? null, headline, next, progress: extra.progress ?? null, stage });
}

export function deriveGoalStatus(input: {
  readonly coverage: DocumentCoverageOutcome | null;
  readonly goalId: string;
  readonly runId: string;
  readonly surface: SurfaceFrame | null;
}): GoalStatus {
  const { coverage, goalId, runId, surface } = input;
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
  if (agents !== null && agents.blocked > 0 && offered(surface, "escalation.decide", null)) {
    return status("ESCALATION", `${String(agents.blocked)} ${agents.blocked === 1 ? "node has" : "nodes have"} used every review attempt.`, {
      anchor: "needs-you", detail: "Allow more attempts from Needs you, or read the findings on the board to see what kept failing.", label: "Decide the escalation",
    }, { agents, progress });
  }
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
    const remaining = agents.total - agents.accepted;
    return status("WORKING", `Agents are working: ${String(agents.accepted)} of ${String(agents.total)} nodes accepted.`, {
      anchor: "board",
      detail: remaining === 0
        ? "Every node is accepted; the verifier's last acceptance is on the board."
        : `${String(agents.working)} ${agents.working === 1 ? "node is" : "nodes are"} claimed right now. Nothing needs you until a review is exhausted.`,
      label: "Watch the board",
    }, { agents, progress });
  }
  return status("UNKNOWN", "Waiting for the daemon to say where this goal stands.", {
    anchor: null, detail: "The coverage and the board are still being read.", label: "Wait",
  }, { progress });
}
