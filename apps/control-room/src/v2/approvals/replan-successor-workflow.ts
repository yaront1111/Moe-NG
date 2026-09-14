import type { NextAllowedCommand } from "@moe/contracts";
import type { LiveSetup } from "../../live/live-config.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { readGoalCatalog } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { readGoalSource } from "../../live/live-goal-source.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import { readRuns } from "../../live/live-runs.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { readSurfaceOnce } from "../ops/policy-install-port.js";
import { createReplanSuccessorPort } from "./replan-successor-port.js";
import type { PreparedReplanSuccessor, ReplanProgress, ReplanSuccessorPort } from "./replan-successor-port.js";
import { createReplanSuccessorJournal, replanIntentKey } from "./replan-successor-journal.js";
import type { ReplanIntent } from "./replan-successor-journal.js";
import { replanEnvelope, replanEqual, replanRefused, sendReplanCommand } from "./replan-successor-commands.js";
import { replanEvidence, replanItem } from "./replan-successor-evidence.js";

export interface ReplanWorkflowEffects {
  readonly origin?: string;
  readonly getStorage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  readonly readSource?: (goalRef: string) => Promise<GoalSourceOutcome>;
  readonly readRuns?: () => Promise<RunsOutcome>;
  readonly readCatalog?: () => Promise<GoalCatalogFrame>;
  readonly readSurface?: () => Promise<SurfaceFrame>;
}
/** Durable local intent is never approval; every manual resume rejoins daemon authority. */
export function createReplanWorkflowPort(setup: LiveSetup, getFrame: () => SurfaceFrame | null,
  effects: ReplanWorkflowEffects = {}): ReplanSuccessorPort {
  const origin = effects.origin ?? globalThis.location.origin;
  const journal = createReplanSuccessorJournal({ origin, projectId: setup.projectId ?? "",
    getStorage: effects.getStorage ?? (() => globalThis.sessionStorage) });
  const sourceRead = effects.readSource ?? ((goalRef: string) => readGoalSource(setup.headers, goalRef));
  const base = createReplanSuccessorPort(setup, getFrame, { readSource: sourceRead });
  const known = new WeakMap<PreparedReplanSuccessor, ReplanIntent>();
  const preparedOf = (intent: ReplanIntent): PreparedReplanSuccessor => {
    const prepared = Object.freeze({ draft: intent.draft, createOffer: { ...intent.createOffer } });
    known.set(prepared, intent); return prepared;
  };
  const resume = async (prepared: PreparedReplanSuccessor): Promise<ReplanProgress> => {
    let committed = false;
    try {
      const captured = known.get(prepared), stored = journal.read();
      const current = captured === undefined || stored.status !== "PRESENT" ? undefined
        : stored.intents.find((row) => replanIntentKey(row) === replanIntentKey(captured));
      if (captured === undefined || current === undefined || !replanEqual({ ...current, phase: captured.phase }, captured)) {
        return { committed, outcome: replanRefused("REPLAN_JOURNAL_BINDING_MISMATCH") };
      }
      const [runs, source, catalog] = await Promise.all([
        (effects.readRuns ?? (() => readRuns(setup.headers)))(), sourceRead(current.predecessorGoalId),
        (effects.readCatalog ?? (() => readGoalCatalog({ headers: setup.headers })))(),
      ]);
      const evidence = await replanEvidence(current, runs, source, catalog);
      if (evidence === null) return { committed, outcome: replanRefused("REPLAN_RECOVERY_EVIDENCE_UNAVAILABLE") };
      committed = evidence.committed;
      if (!committed) {
        const surface = await (effects.readSurface ?? (() => readSurfaceOnce(setup.headers)))();
        if (surface.connection !== "CONNECTED" || surface.outcome !== "SURFACE"
          || !surface.offers.some((offer) => replanEqual(offer, current.escalationOffer))) {
          return { committed, outcome: replanRefused("REPLAN_CURRENT_OFFER_UNAVAILABLE") };
        }
        const envelope = await replanEnvelope(setup, current, "decision");
        if ("ok" in envelope) return { committed, outcome: envelope };
        const outcome = await sendReplanCommand(setup, envelope);
        if (!outcome.ok) return { committed, outcome };
        committed = true;
      }
      const updated = journal.put({ ...current, phase: "CREATE_PENDING" });
      if (!updated.ok) return { committed, outcome: replanRefused(updated.code) };
      if (!evidence.successorExists) {
        const envelope = await replanEnvelope(setup, current, "create");
        if ("ok" in envelope) return { committed, outcome: envelope };
        const outcome = await sendReplanCommand(setup, envelope);
        if (!outcome.ok) return { committed, outcome };
      }
      const removed = journal.remove(replanIntentKey(current));
      return { committed, outcome: removed.ok ? { ok: true, commandId: current.createOffer.commandId } : replanRefused(removed.code) };
    } catch { return { committed, outcome: replanRefused("REPLAN_RECOVERY_EVIDENCE_UNAVAILABLE") }; }
  };
  return {
    prepare: async (item, runs) => {
      if (typeof setup.projectId !== "string" || setup.projectId === "") return replanRefused("REPLAN_PROJECT_UNBOUND");
      const snapshot = structuredClone(item);
      const prepared = await base.prepare(snapshot, runs);
      if (!prepared.ok) return prepared;
      const escalation = snapshot.escalation;
      if (escalation === undefined || prepared.prepared.createOffer === undefined) return replanRefused("REPLAN_PREPARATION_INVALID");
      const intent: ReplanIntent = { version: "moe-replan-intent/1", projectId: setup.projectId, origin,
        phase: "DECISION_UNCERTAIN", predecessorGoalId: snapshot.goalId, nodeRef: String(escalation.affordance["targetAggregateId"]),
        reviewVersion: Number(escalation.affordance["expectedVersion"]), planningRunRef: snapshot.planningRunRef,
        nodeKey: escalation.nodeKey, title: snapshot.title, escalationOffer: { ...escalation.affordance } as unknown as NextAllowedCommand,
        createOffer: { ...prepared.prepared.createOffer } as unknown as NextAllowedCommand, draft: prepared.prepared.draft };
      for (const kind of ["decision", "create"] as const) {
        const built = await replanEnvelope(setup, intent, kind);
        if ("ok" in built) return built;
      }
      return { ok: true, prepared: preparedOf(intent) };
    },
    remember: (prepared) => {
      const intent = known.get(prepared);
      if (intent === undefined) return replanRefused("REPLAN_PREPARATION_INVALID");
      const saved = journal.put(intent);
      return saved.ok ? { ok: true, commandId: intent.escalationOffer.commandId } : replanRefused(saved.code);
    },
    restore: () => {
      const stored = journal.read();
      return { error: stored.status === "INVALID" || stored.status === "UNAVAILABLE" ? stored.code : null,
        records: stored.status === "PRESENT" ? stored.intents.map((intent) => ({ item: replanItem(intent), prepared: preparedOf(intent) })) : [] };
    },
    resume,
    createPrepared: async (prepared) => (await resume(prepared)).outcome,
  };
}
