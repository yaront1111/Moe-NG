import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { createBoardFeed } from "../../live/live-board-feed.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { createGoalCatalogFeed } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { LiveSetup } from "../../live/live-config.js";
import { readRuns } from "../../live/live-runs.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { createEscalationPort } from "./escalation-port.js";
import type { EscalationPort } from "./escalation-port.js";
import type { EscalationResult } from "./needs-you.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import { useGoalCoverage } from "../goals/use-goal-coverage.js";
import type { CoverageReader } from "../goals/use-goal-coverage.js";
import { NeedsYou } from "./needs-you.js";
import { deriveNeedsYou } from "./needs-you-model.js";

/**
 * The LIVE Needs-you queue. Three daemon reads feed it and each answers one question: the
 * affordance surface says what this session is OFFERED (plan approvals), the durable goal
 * catalog says which goals exist, and the coverage read says where each goal's contract
 * stands. The queue is derived from those answers and nothing else; `onCount` hands the
 * derived count to the shell for the nav badge so the badge and the list cannot disagree.
 */

const POLL_INTERVAL_MS = 2_000;
const RUNS_POLL_MS = 5_000;

export interface LiveNeedsYouProps {
  /** Injectable for tests; the default spends the attached session's own wire. */
  readonly escalationPort?: EscalationPort | undefined;
  readonly onConnection?: ((connection: SurfaceFrame["connection"]) => void) | undefined;
  readonly onCount?: ((count: number) => void) | undefined;
  readonly onOpenBoard: (goalId: string, planningRunRef: string, title: string) => void;
  readonly readCoverage?: CoverageReader | undefined;
  /** Injectable for tests; the default reads POST /runs/read with the session's headers. */
  readonly readRuns?: (() => Promise<RunsOutcome>) | undefined;
  readonly setup: LiveSetup;
}

export function LiveNeedsYou({
  escalationPort, onConnection, onCount, onOpenBoard, readCoverage, readRuns: readRunsProp, setup,
}: LiveNeedsYouProps): JSX.Element {
  const [surface, setSurface] = useState<SurfaceFrame | null>(null);
  const [catalog, setCatalog] = useState<GoalCatalogFrame | null>(null);
  const [runs, setRuns] = useState<RunsOutcome | null>(null);
  const [results, setResults] = useState<ReadonlyMap<string, EscalationResult>>(new Map());
  const [runsReader] = useState(() => readRunsProp ?? ((): Promise<RunsOutcome> => readRuns(setup.headers)));
  const [port] = useState(() => escalationPort ?? createEscalationPort(setup));

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
  const onEscalate = useCallback((item: NeedsYouItem) => {
    const facts = item.escalation;
    if (facts === undefined) return;
    setResults((previous) => new Map(previous).set(facts.nodeKey, { busy: true, outcome: null }));
    void port.submit(facts.affordance, facts.nodeKey).then((outcome) => {
      setResults((previous) => new Map(previous).set(facts.nodeKey, { busy: false, outcome }));
    }, () => {
      setResults((previous) => new Map(previous).set(facts.nodeKey, {
        busy: false, outcome: { code: "ESCALATION_DISPATCH_FAILED", layer: "CONTROL_ROOM_ESCALATION", ok: false },
      }));
    });
  }, [port]);
  useEffect(() => { onCount?.(data.items.length); }, [data.items.length, onCount]);

  return <NeedsYou data={data} escalationResults={results} onEscalate={onEscalate} onOpenBoard={onOpenBoard} />;
}
