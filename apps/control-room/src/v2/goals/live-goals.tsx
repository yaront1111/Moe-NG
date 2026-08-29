import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { admitGoalBrief } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";

import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { dispatchAffordancePayload } from "../../live/live-command-dispatch.js";
import type { LiveRefused, LiveSetup, LiveSetupResult } from "../../live/live-config.js";
import { createGoalCatalogFeed } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame, GoalCatalogWindow } from "../../live/live-goal-catalog.js";
import { deriveGoalCatalog } from "./goal-catalog-model.js";
import type { GoalCreateResult, GoalDraft, GoalsData } from "./goal-model.js";
import { GoalsHome } from "./goals-home.js";

/**
 * The LIVE goals home reads the durable goal catalog for cards and the
 * affordance surface for a fresh goal.create offer. Create sends the admitted
 * Goal Brief and optional PRD through that daemon-minted offer; a successful
 * decision refreshes the catalog immediately.
 *
 * The two paths stay clearly separated: fixtures render `FIXTURE_GOALS_DATA` from
 * cordum-app; here every card comes from `deriveGoalCatalog`, which fabricates
 * nothing the durable catalog does not carry.
 */

const POLL_INTERVAL_MS = 2_000;
const MAX_PRD_BYTES = 128 * 1_024;
const SINGLE_SLOT_BOUND_REASON =
  "The current daemon-issued planning slot is already bound; this release cannot mint another slot yet.";
const setupRenderKeys = new WeakMap<object, string>();
let nextSetupRenderKey = 0;

function setupRenderKey(setup: LiveSetupResult): string {
  const prior = setupRenderKeys.get(setup);
  if (prior !== undefined) return prior;
  nextSetupRenderKey += 1;
  const key = `live-goals-setup-${String(nextSetupRenderKey)}`;
  setupRenderKeys.set(setup, key);
  return key;
}

interface PreparedGoalCreate {
  readonly affordance: Record<string, unknown>;
  readonly draftKey: string;
  readonly payload: JsonObject;
  readonly prdReader: (() => Promise<string>) | null;
  readonly target: string;
}

function draftKey(draft: GoalDraft): string {
  return JSON.stringify({
    acceptanceCriteria: draft.acceptanceCriteria,
    budgetEnvelope: draft.budgetEnvelope,
    outcome: draft.outcome,
    prd: draft.prd === undefined ? null : {
      mediaType: draft.prd.mediaType, name: draft.prd.name, size: draft.prd.size,
    },
    riskClass: draft.riskClass,
  });
}

function instructionsOf(draft: GoalDraft): string {
  const criteria = draft.acceptanceCriteria.length === 0
    ? "- Not specified by operator"
    : draft.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n");
  return [
    `Outcome:\n${draft.outcome}`,
    `Acceptance criteria:\n${criteria}`,
    `Requested budget envelope:\n${draft.budgetEnvelope === "" ? "Not specified by operator" : draft.budgetEnvelope}`,
    `Advisory risk class:\n${draft.riskClass === "" ? "Not specified by operator" : draft.riskClass}`,
  ].join("\n\n");
}

function goalOffer(frame: SurfaceFrame | null): Record<string, unknown> | null {
  if (frame?.connection !== "CONNECTED" || frame.outcome !== "SURFACE") return null;
  const offers = frame.offers.filter((offer) => offer["commandKind"] === "goal.create"
    && typeof offer["commandId"] === "string" && offer["commandId"] !== ""
    && typeof offer["targetAggregateId"] === "string" && offer["targetAggregateId"] !== ""
    && offer["expectedVersion"] === 0);
  return offers.length === 1 ? offers[0] ?? null : null;
}

/** Explains the intentionally single-slot create lane once its durable owner exists. */
export function goalCreateDisabledReason(frame: SurfaceFrame | null): string | undefined {
  if (frame?.connection !== "CONNECTED" || frame.outcome !== "SURFACE") return undefined;
  return typeof frame.planningGoalRef === "string"
    && frame.planningGoalRef.length > 0
    && (frame.goalCreatePlanningRunRef === null
      || frame.goalCreatePlanningRunRef === undefined)
    && goalOffer(frame) === null
    ? SINGLE_SLOT_BOUND_REASON
    : undefined;
}

/**
 * Builds exactly one goal.create payload from operator input and a daemon offer.
 * Ambiguous delivery retains the same offer and payload so a retry rebuilds the
 * same envelope bytes instead of reading the file or minting identity again.
 */
export function createGoalDispatcher(
  setup: LiveSetup,
  getFrame: () => SurfaceFrame | null,
): (draft: GoalDraft) => Promise<GoalCreateResult> {
  let pending: PreparedGoalCreate | null = null;
  return async (draft: GoalDraft): Promise<GoalCreateResult> => {
    const key = draftKey(draft);
    const reader = draft.prd?.readText ?? null;
    if (pending !== null && (pending.draftKey !== key || pending.prdReader !== reader)) {
      return Object.freeze({
        created: false,
        report: "AMBIGUOUS_CREATE_RETRY_LOCKED: retry the unchanged draft before editing or replacing its PRD.",
        retryUnchanged: true,
      });
    }
    if (pending === null) {
      const frame = getFrame();
      const affordance = goalOffer(frame);
      if (affordance === null) {
        return Object.freeze({ created: false, report: "No current goal.create offer; refresh and retry." });
      }
      const planningRunRef = frame?.goalCreatePlanningRunRef;
      if (typeof planningRunRef !== "string" || planningRunRef.length === 0) {
        return Object.freeze({
          created: false, report: "No daemon-issued planning run for this goal.create offer.",
        });
      }
      const target = affordance["targetAggregateId"] as string;
      const admitted = admitGoalBrief({ instructions: instructionsOf(draft), title: draft.outcome });
      if (!admitted.ok) {
        return Object.freeze({ created: false, report: `${admitted.code} @ ${admitted.layer}` });
      }
      let prd: JsonObject | null = null;
      if (draft.prd !== undefined) {
        if (draft.prd.size > MAX_PRD_BYTES) {
          return Object.freeze({ created: false, report: "GOAL_PRD_TEXT_TOO_LARGE @ CONTROL_ROOM" });
        }
        if (draft.prd.mediaType !== "text/markdown" && draft.prd.mediaType !== "text/plain") {
          return Object.freeze({ created: false, report: "GOAL_PRD_MEDIA_TYPE_UNSUPPORTED @ CONTROL_ROOM" });
        }
        let text: string;
        try {
          text = await draft.prd.readText();
        } catch {
          return Object.freeze({ created: false, report: "GOAL_PRD_READ_FAILED @ CONTROL_ROOM" });
        }
        prd = Object.freeze({
          displayPath: draft.prd.name,
          mediaType: draft.prd.mediaType,
          text,
        });
      }
      const briefPayload: JsonObject = Object.freeze({
        instructions: admitted.brief.instructions,
        title: admitted.brief.title,
      });
      const payload: JsonObject = Object.freeze({
        brief: briefPayload,
        budgetAccountRef: `budget-${target}`,
        goalId: target,
        planningRunRef,
        prd,
        // Compatibility field only. The daemon derives the real witness from
        // its durable project state and never trusts this value.
        witness: Object.freeze({}),
      });
      pending = Object.freeze({ affordance, draftKey: key, payload, prdReader: reader, target });
    }
    const attempt = pending;
    let report;
    try {
      report = await dispatchAffordancePayload({
        affordance: attempt.affordance,
        aggregateId: attempt.target,
        client: setup.client,
        kind: "goal.create",
        payload: attempt.payload,
        sessionCredential: setup.sessionCredential,
        transport: setup.transport,
        version: 0,
      });
    } catch {
      return Object.freeze({
        created: false, report: "UNDELIVERED: TRANSPORT_REQUEST_FAILED", retryUnchanged: true,
      });
    }
    if (report.ok) {
      pending = null;
      return Object.freeze({ created: true, report: `Created ${attempt.target}: ${report.detail}` });
    }
    if (report.stage !== "UNDELIVERED" && report.stage !== "ANSWER_UNREADABLE") pending = null;
    return Object.freeze({
      created: false,
      report: `${report.stage}: ${report.detail}`,
      ...(report.stage === "UNDELIVERED" || report.stage === "ANSWER_UNREADABLE"
        ? { retryUnchanged: true as const } : {}),
    });
  };
}

function notAttached(setup: LiveRefused): GoalsData {
  return {
    source: "live",
    goals: [],
    triage: [],
    goalCountLabel: "NOT ATTACHED",
    comingOnlineNote: `${setup.code}: ${setup.detail}`,
  };
}

export interface LiveGoalsHomeProps {
  readonly setup: LiveSetupResult;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  readonly onOpenBoard: (goalId: string, title: string, planningRunRef?: string) => void;
}

interface OwnedFrame {
  readonly frame: SurfaceFrame;
  readonly owner: LiveSetup;
}

interface OwnedCatalog {
  readonly frame: GoalCatalogFrame;
  readonly navigation: GoalCatalogWindow;
  readonly owner: LiveSetup;
}

export function LiveGoalsHome({ setup, onConnection, onOpenBoard }: LiveGoalsHomeProps): JSX.Element {
  const [catalog, setCatalog] = useState<OwnedCatalog | null>(null);
  const [surface, setSurface] = useState<OwnedFrame | null>(null);
  const frameRef = useRef<OwnedFrame | null>(null);

  const feed = useMemo(() => (setup.ok
    ? createBoardFeed({
      headers: setup.headers,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: (next) => {
        const owned = { frame: next, owner: setup };
        frameRef.current = owned;
        setSurface(owned);
        onConnection?.(next.connection);
      },
    })
    : null), [onConnection, setup]);

  const catalogFeed = useMemo(() => (setup.ok
    ? createGoalCatalogFeed({
      headers: setup.headers,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: (next, navigation) => setCatalog({ frame: next, navigation, owner: setup }),
    })
    : null), [setup]);

  useEffect(() => {
    feed?.start();
    catalogFeed?.start();
    return (): void => { feed?.stop(); catalogFeed?.stop(); };
  }, [catalogFeed, feed]);

  const currentCatalog = catalog?.owner === setup ? catalog : null;
  const data = setup.ok
    ? deriveGoalCatalog(currentCatalog?.frame ?? null)
    : notAttached(setup);
  const currentSurface = surface?.owner === setup ? surface.frame : null;
  const onCreateGoal = useMemo<(draft: GoalDraft) => Promise<GoalCreateResult>>(
    () => {
      if (setup.ok) {
        const dispatch = createGoalDispatcher(setup, () => (
          frameRef.current?.owner === setup ? frameRef.current.frame : null
        ));
        return async (draft: GoalDraft): Promise<GoalCreateResult> => {
          const result = await dispatch(draft);
          if (result.created) catalogFeed?.refresh();
          return result;
        };
      }
      return (): Promise<GoalCreateResult> => Promise.resolve(Object.freeze({
        created: false, report: `Not attached: ${setup.code} \u00b7 ${setup.detail}`,
      }));
    },
    [catalogFeed, setup],
  );
  return (
    <GoalsHome
      catalogNavigation={currentCatalog === null || catalogFeed === null ? undefined : {
        currentPage: currentCatalog.navigation.currentPage,
        hasEarlier: currentCatalog.navigation.hasEarlier,
        hasMore: currentCatalog.navigation.hasMore,
        onFirst: () => catalogFeed.first(),
        onNext: () => catalogFeed.next(),
      }}
      createDisabledReason={goalCreateDisabledReason(currentSurface)}
      data={data}
      key={setupRenderKey(setup)}
      onCreateGoal={onCreateGoal}
      onOpenBoard={onOpenBoard}
    />
  );
}
