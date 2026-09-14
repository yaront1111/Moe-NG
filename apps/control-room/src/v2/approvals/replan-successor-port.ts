import { admitGoalBrief, admitGoalSource, decodeRuntimeCommandEnvelopeBytes } from "@moe/contracts";
import { buildGoalWithSourceCommand } from "@moe/control-room-client";
import type { CommandAffordance } from "@moe/control-room-client";
import { readGoalSource } from "../../live/live-goal-source.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { briefOfDraft, createGoalDispatcher, goalCreateOffer, goalCreateRefusal } from "../goals/live-goal-create.js";
import type { GoalCreateResult, GoalDraft } from "../goals/goal-model.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import type { OfferOutcome } from "./offer-wire.js";

const REPLAN_LAYER = "CONTROL_ROOM_REPLAN" as const;
type Refusal = Extract<OfferOutcome, { readonly ok: false }>;
const refused = (code: string): Refusal => Object.freeze({ code, layer: REPLAN_LAYER, ok: false });
const utf8 = new TextEncoder();

export interface PreparedReplanSuccessor {
  readonly draft: GoalDraft;
  readonly createOffer?: Readonly<Record<string, unknown>>;
}
export interface ReplanProgress { readonly committed: boolean; readonly outcome: OfferOutcome }
export interface RestoredReplan { readonly item: NeedsYouItem; readonly prepared: PreparedReplanSuccessor }
export type ReplanPreparation = { readonly ok: true; readonly prepared: PreparedReplanSuccessor } | Refusal;
export interface ReplanSuccessorPort {
  /** All source reads and payload checks happen before the caller records REPLAN. */
  prepare(item: NeedsYouItem, runs: RunsOutcome | null): Promise<ReplanPreparation>;
  /** Reuses the prepared snapshot after REPLAN; no source re-read or second decision. */
  createPrepared(prepared: PreparedReplanSuccessor): Promise<OfferOutcome>;
  remember?(prepared: PreparedReplanSuccessor): OfferOutcome;
  restore?(): { readonly records: readonly RestoredReplan[]; readonly error: string | null };
  resume?(prepared: PreparedReplanSuccessor): Promise<ReplanProgress>;
}

function exactNode(item: NeedsYouItem, runs: RunsOutcome | null): RunNodeView | null {
  const escalation = item.escalation;
  if (escalation === undefined || runs?.status !== "RUNS" || item.goalId === "" || item.planningRunRef === "") return null;
  const goals = runs.goals.filter((goal) => goal.goalId === item.goalId);
  const goal = goals.length === 1 ? goals[0] : undefined;
  if (goal?.run?.runId !== item.planningRunRef || goal.run.approval !== "BOUND") return null;
  const nodes = goal.nodes.filter((node) => node.nodeRef === escalation.affordance["targetAggregateId"]);
  const node = nodes.length === 1 ? nodes[0] : undefined;
  const version = escalation.affordance["expectedVersion"];
  return node !== undefined && node.nodeKey === escalation.nodeKey && !node.review.unreadable
    && typeof version === "number" && Number.isSafeInteger(version) && version >= 0 && node.review.version === version
    ? node : null;
}

/** Diagnostics remain literal prose; the daemon resolves complete review context from the pointer. */
export function replanInstructions(item: NeedsYouItem, runs: RunsOutcome | null): string {
  const node = runs?.status === "RUNS"
    ? runs.goals.find((goal) => goal.goalId === item.goalId)?.nodes
      .find((row) => row.nodeRef === item.escalation?.affordance["targetAggregateId"]) : undefined;
  const nodeKey = item.escalation?.nodeKey ?? "?";
  const rounds = node?.review.unsuccessfulRounds ?? item.escalation?.unsuccessfulRounds ?? null;
  const lines = [
    `REPLAN of goal ${item.goalId}: node ${nodeKey} failed review`
      + ` ${rounds === null ? "three or more" : String(rounds)} times and was retired.`,
    `Replan context: ${JSON.stringify({ predecessorGoalId: item.goalId,
      nodeRef: item.escalation?.affordance["targetAggregateId"], reviewVersion: node?.review.version })}`,
    "Plan a different decomposition that addresses the findings below, under new node keys;",
    "do not repeat the retired node's approach.",
    "Review findings visible in this read (may be incomplete). Use the bound durable review for complete context:",
  ];
  for (const finding of node?.review.findings ?? []) {
    lines.push(`- [${finding.severity} ${finding.ruleId}; ${finding.subject}] ${finding.detail}`);
  }
  if (node?.objective !== undefined && node.objective !== "") lines.push(`The retired node's objective was: ${node.objective}`);
  return lines.join("\n");
}

export interface ReplanSuccessorEffects {
  readonly dispatch?: ((draft: GoalDraft) => Promise<GoalCreateResult>) | undefined;
  readonly readSource?: ((goalRef: string) => Promise<GoalSourceOutcome>) | undefined;
}

export function createReplanSuccessorPort(
  setup: LiveSetup, getFrame: () => SurfaceFrame | null, effects: ReplanSuccessorEffects = {},
): ReplanSuccessorPort {
  const dispatch = effects.dispatch ?? createGoalDispatcher(setup, getFrame);
  const readSource = effects.readSource ?? ((goalRef: string) => readGoalSource(setup.headers, goalRef));
  const preparedHere = new WeakSet<PreparedReplanSuccessor>();
  const attempts = new WeakMap<PreparedReplanSuccessor, Promise<OfferOutcome>>();
  return Object.freeze({
    prepare: async (item: NeedsYouItem, runs: RunsOutcome | null): Promise<ReplanPreparation> => {
      if (exactNode(item, runs) === null) return refused("REPLAN_CONTEXT_UNAVAILABLE");
      // Capture prose before awaiting a read; later polling cannot alter this review's draft.
      const outcome = replanInstructions(item, runs), title = `${item.title} · replan`;
      let source: GoalSourceOutcome;
      try { source = await readSource(item.goalId); } catch { return refused("REPLAN_SOURCE_READ_FAILED"); }
      if (source.status !== "GOAL_SOURCE") return Object.freeze({ code: source.code, layer: source.layer, ok: false });
      const admittedSource = admitGoalSource({ displayPath: source.displayPath, mediaType: source.mediaType, text: source.text });
      if (!admittedSource.ok) return admittedSource;
      const sourceBytes = utf8.encode(source.text);
      const sourceDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", sourceBytes))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (source.byteLength !== sourceBytes.byteLength || source.contentSha256 !== sourceDigest) return refused("REPLAN_SOURCE_BINDING_MISMATCH");
      const draft: GoalDraft = Object.freeze({ acceptanceCriteria: Object.freeze([]), budgetEnvelope: "", outcome, title,
        prd: Object.freeze({ localSha256: source.contentSha256, mediaType: admittedSource.source.mediaType,
          name: source.displayPath, size: source.byteLength, text: source.text }) });
      const brief = admitGoalBrief(briefOfDraft(draft));
      if (!brief.ok) return brief;
      const frame = getFrame();
      const offer = frame?.connection === "CONNECTED" ? goalCreateOffer(frame, "goal.create_with_source") : null;
      if (offer === null) return refused(goalCreateRefusal(frame, "goal.create_with_source"));
      const built = buildGoalWithSourceCommand({ affordance: offer as unknown as CommandAffordance<"goal.create_with_source">,
        correlationId: "ui-replan-preflight", requestDigest: sourceDigest, sessionCredential: setup.sessionCredential,
        source: admittedSource.source, ...brief.brief });
      if (!built.ok) return "error" in built ? refused(built.error.code) : built;
      const wire = decodeRuntimeCommandEnvelopeBytes(utf8.encode(JSON.stringify(built.envelope)));
      if (!wire.ok) return refused(wire.error.code);
      const prepared = Object.freeze({ draft, createOffer: Object.freeze({ ...offer }) });
      preparedHere.add(prepared);
      return Object.freeze({ ok: true, prepared });
    },
    createPrepared: (prepared: PreparedReplanSuccessor): Promise<OfferOutcome> => {
      if (!preparedHere.has(prepared)) return Promise.resolve(refused("REPLAN_PREPARATION_INVALID"));
      const existing = attempts.get(prepared);
      if (existing !== undefined) return existing;
      const attempt = Promise.resolve().then(() => dispatch(prepared.draft)).then((created): OfferOutcome => created.ok
        ? Object.freeze({ commandId: created.commandId ?? "", ok: true }) : refused(created.report),
      (): OfferOutcome => refused("REPLAN_SUCCESSOR_DISPATCH_FAILED"));
      attempts.set(prepared, attempt);
      void attempt.then((result) => { if (!result.ok) attempts.delete(prepared); });
      return attempt;
    },
  });
}
