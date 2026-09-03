import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { createGoalCatalogFeed } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { LiveSetup } from "../../live/live-config.js";
import { readRuns } from "../../live/live-runs.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { useGoalCoverage } from "../goals/use-goal-coverage.js";
import type { CoverageReader } from "../goals/use-goal-coverage.js";
import { createEscalationPort } from "./escalation-port.js";
import type { EscalationPort } from "./escalation-port.js";
import { createReplanSuccessorPort } from "./replan-successor-port.js";
import type { ReplanSuccessorPort } from "./replan-successor-port.js";
import type { NeedsYouChoice } from "./needs-you.js";
import { createGoalClosePort } from "./goal-close-port.js";
import type { GoalClosePort } from "./goal-close-port.js";
import { NeedsYou, decisionKeyOf } from "./needs-you.js";
import type { DecisionResult } from "./needs-you.js";
import { deriveNeedsYou } from "./needs-you-model.js";
import type { NeedsYouItem } from "./needs-you-model.js";

/**
 * The LIVE Needs-you queue. Four daemon reads feed it and each answers one question: the
 * affordance surface says what this session is OFFERED (plan approvals, escalations, goal
 * closes), the durable goal catalog says which goals exist, the coverage read says where each
 * goal's contract stands, and the runs read names the goal an exhausted node belongs to. The
 * queue is derived from those answers and nothing else; `onCount` hands the derived count to
 * the shell for the nav badge so the badge and the list cannot disagree. A decision spends
 * the daemon's own offer through the matching port and keeps the answer beside its card.
 */

const POLL_INTERVAL_MS = 2_000;
const RUNS_POLL_MS = 5_000;

export interface LiveNeedsYouProps {
  /** Injectable for tests; the default spends the attached session's own wire. */
  readonly closePort?: GoalClosePort | undefined;
  /** Injectable for tests; the default spends the attached session's own wire. */
  readonly escalationPort?: EscalationPort | undefined;
  /** Injectable for tests; the default creates the successor goal through the session's wire. */
  readonly successorPort?: ReplanSuccessorPort | undefined;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  readonly onCount?: ((count: number) => void) | undefined;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
  readonly readCoverage?: CoverageReader | undefined;
  /** Injectable for tests; the default reads POST /runs/read with the session's headers. */
  readonly readRuns?: (() => Promise<RunsOutcome>) | undefined;
  readonly setup: LiveSetup;
}

export function LiveNeedsYou({
  closePort, escalationPort, onConnection, onCount, onOpenBoard, readCoverage, readRuns: readRunsProp, setup,
  successorPort,
}: LiveNeedsYouProps): JSX.Element {
  const [surface, setSurface] = useState<SurfaceFrame | null>(null);
  const [catalog, setCatalog] = useState<GoalCatalogFrame | null>(null);
  const [runs, setRuns] = useState<RunsOutcome | null>(null);
  const [results, setResults] = useState<ReadonlyMap<string, DecisionResult>>(new Map());
  const [runsReader] = useState(() => readRunsProp ?? ((): Promise<RunsOutcome> => readRuns(setup.headers)));
  const [escalate] = useState(() => escalationPort ?? createEscalationPort(setup));
  const [close] = useState(() => closePort ?? createGoalClosePort(setup));

  const feed = useMemo(() => createBoardFeed({
    headers: setup.headers,
    intervalMs: POLL_INTERVAL_MS,
    onFrame: (next) => {
      setSurface(next);
      onConnection?.(next.connection);
    },
  }), [onConnection, setup]);
  const catalogFeed = useMemo(() => createGoalCatalogFeed({
    headers: setup.headers, intervalMs: POLL_INTERVAL_MS, onFrame: setCatalog,
  }), [setup]);
  useEffect(() => {
    feed.start();
    catalogFeed.start();
    return (): void => { feed.stop(); catalogFeed.stop(); };
  }, [catalogFeed, feed]);

  useEffect(() => {
    let live = true;
    const tick = (): void => {
      void runsReader().then((next) => { if (live) setRuns(next); }, () => undefined);
    };
    tick();
    const timer = setInterval(tick, RUNS_POLL_MS);
    return (): void => { live = false; clearInterval(timer); };
  }, [runsReader]);

  const coverage = useGoalCoverage(catalog, readCoverage);
  const data = useMemo(
    () => deriveNeedsYou({ catalog, coverage, runs, surface }), [catalog, coverage, runs, surface],
  );
  const surfaceRef = useRef<SurfaceFrame | null>(null);
  surfaceRef.current = surface;
  const [successor] = useState(() => successorPort ?? createReplanSuccessorPort(setup, () => surfaceRef.current));
  const onDecide = useCallback((item: NeedsYouItem, choice?: NeedsYouChoice) => {
    const key = decisionKeyOf(item);
    const escalation = item.escalation;
    const spend = escalation !== undefined
      ? (choice === "REPLAN"
        // REPLAN is two durable acts: the decision on the node, then the successor goal that
        // carries the findings. The second runs only once the first was accepted.
        ? escalate.submit(escalation.affordance, escalation.nodeKey, "REPLAN").then(async (outcome) =>
          outcome.ok ? successor.create(item, runs) : outcome)
        : escalate.submit(escalation.affordance, escalation.nodeKey, "ALLOW_MORE_ATTEMPTS"))
      : item.close !== undefined
        ? close.submit(item.close.affordance, item.goalId)
        : null;
    if (spend === null) return;
    setResults((previous) => new Map(previous).set(key, { busy: true, choice, outcome: null }));
    void spend.then((outcome) => {
      setResults((previous) => new Map(previous).set(key, { busy: false, choice, outcome }));
    }, () => {
      setResults((previous) => new Map(previous).set(key, {
        busy: false, choice,
        outcome: { code: "DECISION_DISPATCH_FAILED", layer: "CONTROL_ROOM_NEEDS_YOU", ok: false },
      }));
    });
  }, [close, escalate, runs, successor]);
  useEffect(() => { onCount?.(data.items.length); }, [data.items.length, onCount]);

  return <NeedsYou data={data} decisionResults={results} onDecide={onDecide} onOpenBoard={onOpenBoard} />;
}
