import { admitGoalBrief } from "@moe/contracts";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { briefOfDraft } from "../goals/live-goal-create.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import type { ReplanIntent } from "./replan-successor-journal.js";
import { replanInstructions } from "./replan-successor-port.js";
import { replanDigest } from "./replan-successor-commands.js";

export function replanItem(intent: ReplanIntent): NeedsYouItem {
  return { actionLabel: "Open the goal", detail: "A saved replacement request needs checking against the daemon.",
    goalId: intent.predecessorGoalId, headline: "Replan outcome needs checking", kind: "ESCALATION",
    planningRunRef: intent.planningRunRef, title: intent.title, escalation: { affordance: { ...intent.escalationOffer },
      findings: [], findingsState: "MISSING", latestRoute: null, nodeKey: intent.nodeKey, unsuccessfulRounds: null } };
}
export interface ReplanEvidence { readonly committed: boolean; readonly successorExists: boolean }
/** Browser data proposes an intent. Fresh daemon reads must reconstruct the same source and brief. */
export async function replanEvidence(intent: ReplanIntent, runs: RunsOutcome, source: GoalSourceOutcome,
  catalog: GoalCatalogFrame): Promise<ReplanEvidence | null> {
  if (runs.status !== "RUNS" || source.status !== "GOAL_SOURCE" || catalog.connection !== "CONNECTED" || catalog.outcome !== "GOALS") return null;
  const goals = runs.goals.filter((goal) => goal.goalId === intent.predecessorGoalId);
  const goal = goals.length === 1 ? goals[0] : undefined;
  const oldCatalog = catalog.goals.filter((entry) => entry.goalId === intent.predecessorGoalId);
  if (goal?.run?.approval !== "BOUND" || goal.run.runId !== intent.planningRunRef || oldCatalog.length !== 1
    || oldCatalog[0]?.brief?.title !== intent.title || oldCatalog[0].planningRunRef !== intent.planningRunRef) return null;
  const nodes = goal.nodes.filter((node) => node.nodeRef === intent.nodeRef);
  const node = nodes.length === 1 ? nodes[0] : undefined;
  if (node === undefined || node.nodeKey !== intent.nodeKey || node.review.unreadable || node.accepted !== null || node.landing !== null) return null;
  const committed = node.status === "REPLANNED" && node.review.escalated && node.review.version === intent.reviewVersion + 1;
  if (!committed && (node.status !== "ESCALATION_REQUIRED" || node.review.version !== intent.reviewVersion)) return null;
  const prd = intent.draft.prd;
  if (prd === undefined || prd.text !== source.text || prd.name !== source.displayPath || prd.mediaType !== source.mediaType
    || prd.size !== source.byteLength || prd.localSha256 !== source.contentSha256
    || new TextEncoder().encode(source.text).byteLength !== source.byteLength
    || await replanDigest(source.text) !== source.contentSha256
    || oldCatalog[0].binding?.contentSha256 !== source.contentSha256 || oldCatalog[0].binding.byteLength !== source.byteLength) return null;
  const before: RunsOutcome = { ...runs, goals: [{ ...goal, nodes: [{ ...node, review: { ...node.review, version: intent.reviewVersion } }] }] };
  const expected = { acceptanceCriteria: [], budgetEnvelope: "", outcome: replanInstructions(replanItem(intent), before),
    title: `${intent.title} · replan`, prd };
  const wanted = admitGoalBrief(briefOfDraft(expected)), saved = admitGoalBrief(briefOfDraft(intent.draft));
  if (!wanted.ok || !saved.ok || wanted.brief.instructions !== saved.brief.instructions || wanted.brief.title !== saved.brief.title) return null;
  const successors = catalog.goals.filter((entry) => entry.goalId === `goal-${intent.createOffer.commandId}`);
  if (successors.length > 1) return null;
  const successor = successors[0];
  if (successor !== undefined && (!committed || successor.brief?.title !== saved.brief.title
    || successor.brief.instructions !== saved.brief.instructions || successor.binding?.contentSha256 !== source.contentSha256
    || successor.binding.byteLength !== source.byteLength)) return null;
  return { committed, successorExists: successor !== undefined };
}
