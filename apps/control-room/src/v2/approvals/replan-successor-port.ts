import { readGoalSource } from "../../live/live-goal-source.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { createGoalDispatcher } from "../goals/live-goal-create.js";
import type { GoalCreateResult, GoalDraft, GoalDraftPrd } from "../goals/goal-model.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import type { OfferOutcome } from "./offer-wire.js";

/**
 * The second half of REPLAN: once the daemon recorded the decision on the exhausted node, a
 * SUCCESSOR goal is created over the same PRD. Its instructions carry the findings that
 * exhausted the previous attempt, so the planning seat that decomposes it plans against them
 * (the wrapper hands a goal's instructions to the compiler mission). Gate 1 is keyed by the
 * PRD's content sha, so the approved contract carries over and the successor goes straight to
 * decomposition.
 *
 * Nothing here decides: the PRD comes from the daemon's own source read, the goal from the
 * same dispatcher the New goal form uses, and every refusal is the daemon's, verbatim.
 */

const REPLAN_LAYER = "CONTROL_ROOM_REPLAN" as const;
const MAX_FINDINGS = 8;
const MAX_DETAIL_CHARS = 600;

export interface ReplanSuccessorPort {
  create(item: NeedsYouItem, runs: RunsOutcome | null): Promise<OfferOutcome>;
}

/** The operator instructions a successor goal is minted with: what failed, and what to change. */
export function replanInstructions(item: NeedsYouItem, runs: RunsOutcome | null): string {
  const nodeKey = item.escalation?.nodeKey ?? "?";
  const node = runs?.status === "RUNS"
    ? runs.goals.flatMap((goal) => goal.nodes).find((row) => row.nodeKey === nodeKey) : undefined;
  const rounds = node?.review.unsuccessfulRounds ?? item.escalation?.unsuccessfulRounds ?? null;
  const lines = [
    `REPLAN of goal ${item.goalId}: node ${nodeKey} failed review`
      + ` ${rounds === null ? "three or more" : String(rounds)} times and was retired.`,
    "Plan a different decomposition that addresses the findings below, under new node keys;",
    "do not repeat the retired node's approach.",
  ];
  const findings = node?.review.findings.slice(0, MAX_FINDINGS) ?? [];
  if (findings.length > 0) {
    lines.push("Findings from the last review round:");
    for (const finding of findings) {
      lines.push(`- [${finding.severity} ${finding.ruleId}] ${finding.detail.slice(0, MAX_DETAIL_CHARS)}`);
    }
  }
  if (node?.objective !== undefined && node.objective !== "") {
    lines.push(`The retired node's objective was: ${node.objective}`);
  }
  return lines.join("\n");
}

export interface ReplanSuccessorEffects {
  /** Creates the goal; the New goal form's own dispatcher by default. */
  readonly dispatch?: ((draft: GoalDraft) => Promise<GoalCreateResult>) | undefined;
  /** Reads the predecessor's PRD; the session's own source read by default. */
  readonly readSource?: ((goalRef: string) => Promise<GoalSourceOutcome>) | undefined;
}

export function createReplanSuccessorPort(
  setup: LiveSetup, getFrame: () => SurfaceFrame | null, effects: ReplanSuccessorEffects = {},
): ReplanSuccessorPort {
  const dispatch = effects.dispatch ?? createGoalDispatcher(setup, getFrame);
  const readSource = effects.readSource
    ?? ((goalRef: string): Promise<GoalSourceOutcome> => readGoalSource(setup.headers, goalRef));
  return Object.freeze({
    create: async (item: NeedsYouItem, runs: RunsOutcome | null): Promise<OfferOutcome> => {
      const source = await readSource(item.goalId);
      if (source.status !== "GOAL_SOURCE") {
        return Object.freeze({ code: source.code, layer: source.layer, ok: false as const });
      }
      const prd: GoalDraftPrd = Object.freeze({
        localSha256: source.contentSha256,
        mediaType: source.mediaType as GoalDraftPrd["mediaType"],
        name: source.displayPath,
        size: source.byteLength,
        text: source.text,
      });
      const draft: GoalDraft = Object.freeze({
        acceptanceCriteria: [],
        budgetEnvelope: "",
        outcome: replanInstructions(item, runs),
        prd,
        title: `${item.title} · replan`,
      });
      const created = await dispatch(draft);
      return created.ok
        ? Object.freeze({ commandId: created.commandId ?? "", ok: true as const })
        : Object.freeze({ code: created.report, layer: REPLAN_LAYER, ok: false as const });
    },
  });
}
