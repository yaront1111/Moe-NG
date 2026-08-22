import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { dispatchAffordance } from "../../live/live-dispatch.js";
import { ingestDocument } from "../../live/live-document-ingest.js";
import type { DocumentIngestOutcome, DocumentIngestRequest } from "../../live/live-document-ingest.js";
import type { LiveRefused, LiveSetup, LiveSetupResult } from "../../live/live-config.js";
import { deriveLiveGoals } from "./goal-model.js";
import type { GoalDraft, GoalsData } from "./goal-model.js";
import { GoalsHome } from "./goals-home.js";

/**
 * The LIVE goals home: subscribes to the daemon's affordance surface (the kept
 * board feed), derives the one real goal from it (goal-model.deriveLiveGoals),
 * and wires "Create goal" to a real goal.create dispatch through the kept
 * dispatch layer.
 *
 * The two paths stay clearly separated: fixtures render `FIXTURE_GOALS_DATA` from
 * cordum-app; here every value comes from `deriveLiveGoals`, which fabricates
 * nothing the affordance surface does not carry.
 */

const POLL_INTERVAL_MS = 2_000;

function goalCreateOffer(frame: SurfaceFrame | null): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  return frame.offers.find((offer) => offer["commandKind"] === "goal.create") ?? null;
}

/**
 * Build the create-goal dispatcher. It finds the daemon's own goal.create offer
 * on the current surface and hands it back through `dispatchAffordance`; with no
 * such offer it says so plainly rather than inventing one.
 *
 * Goal PROSE (title/outcome) is NOT durable yet: the dispatch sends the dev
 * goal.create payload the kept layer supplies, not the operator's typed outcome.
 * That backend gap is surfaced in the report and noted as a leftover.
 */
export function createGoalDispatcher(
  setup: LiveSetup,
  getFrame: () => SurfaceFrame | null,
): (draft: GoalDraft) => Promise<string> {
  return async (_draft: GoalDraft): Promise<string> => {
    const offer = goalCreateOffer(getFrame());
    if (offer === null) {
      return "goal.create is not on the affordance surface yet; the daemon offers no create "
        + "affordance to hand back.";
    }
    const report = await dispatchAffordance({
      affordance: offer,
      aggregateId: (offer["targetAggregateId"] as string | null | undefined) ?? null,
      client: setup.client,
      kind: "goal.create",
      sessionCredential: setup.sessionCredential,
      transport: setup.transport,
      version: (offer["expectedVersion"] as number | undefined) ?? null,
    }).catch(() => ({
      detail: "TRANSPORT_REQUEST_FAILED", ok: false as const, stage: "UNDELIVERED" as const,
    }));
    return `${report.stage}: ${report.detail} \u00b7 goal prose is not persisted yet; the goal `
      + "appears when the ledger does.";
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
  readonly onOpenBoard: (goalId: string, title: string) => void;
}

export function LiveGoalsHome({ setup, onOpenBoard }: LiveGoalsHomeProps): JSX.Element {
  const [frame, setFrame] = useState<SurfaceFrame | null>(null);
  const frameRef = useRef<SurfaceFrame | null>(null);

  const feed = useMemo(() => (setup.ok
    ? createBoardFeed({
      headers: setup.headers,
      intervalMs: POLL_INTERVAL_MS,
      onFrame: (next) => { frameRef.current = next; setFrame(next); },
    })
    : null), [setup]);

  useEffect(() => {
    feed?.start();
    return (): void => { feed?.stop(); };
  }, [feed]);

  const data = setup.ok ? deriveLiveGoals(frame) : notAttached(setup);
  const onCreateGoal = useMemo<(draft: GoalDraft) => Promise<string>>(
    () => (setup.ok
      ? createGoalDispatcher(setup, () => frameRef.current)
      : (): Promise<string> => Promise.resolve(`Not attached: ${setup.code} \u00b7 ${setup.detail}`)),
    [setup],
  );
  // Only an attached operator session carries the authenticated header set the
  // ingest route requires; unattached, the drop keeps the honest placeholder path.
  const onIngestPrd = useMemo<
    ((request: DocumentIngestRequest) => Promise<DocumentIngestOutcome>) | undefined
  >(
    () => (setup.ok
      ? (request: DocumentIngestRequest): Promise<DocumentIngestOutcome> =>
        ingestDocument(setup.headers, request)
      : undefined),
    [setup],
  );

  return (
    <GoalsHome data={data} onCreateGoal={onCreateGoal} onIngestPrd={onIngestPrd} onOpenBoard={onOpenBoard} />
  );
}
