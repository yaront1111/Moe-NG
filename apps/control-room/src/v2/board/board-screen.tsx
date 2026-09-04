import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import "../styles/cordum-board.css";
import { readActivity } from "../../live/live-activity.js";
import type { ActivityOutcome } from "../../live/live-activity.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { readDocumentCoverage } from "../../live/live-document-coverage.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { readGoalCatalog } from "../../live/live-goal-catalog.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { readRuns } from "../../live/live-runs.js";
import type { RunGoalView, RunsOutcome } from "../../live/live-runs.js";
import { MIDDOT } from "../glyphs.js";
import { GoalPublish, publishOffer } from "../goals/goal-publish.js";
import type { PublishPort } from "../goals/publish-port.js";
import { deriveGoalStatus } from "../goals/goal-status.js";
import { GOAL_SECTION_IDS } from "../goals/goal-status-strip.js";
import { foldBoard } from "./board-columns.js";
import { BoardFeed } from "./board-feed.js";
import { BoardHeader } from "./board-header.js";
import { BoardLanes } from "./board-lanes.js";

/**
 * THE BOARD: an opened goal as a person monitors it. One header band (where it stands, the
 * one thing to do next), six columns of the goal's nodes, and the decisions down the right.
 * It is built from three reads the opened goal already made - runs, coverage, activity -
 * plus the affordance surface the page already holds; it invents nothing and adds no read
 * beyond one look at the goal catalog for the human's own brief.
 */

export interface BoardPublishing {
  readonly frame: SurfaceFrame | null;
  readonly port: PublishPort | null;
}

export interface BoardScreenProps {
  readonly activity: ActivityOutcome | null;
  readonly brief: string | null;
  readonly coverage: DocumentCoverageOutcome | null;
  readonly goalId: string;
  readonly nowMs: number;
  readonly onNeedsYou?: (() => void) | undefined;
  /** The publish decision's two inputs; absent (tests, fixtures) means no publish card. */
  readonly publishing?: BoardPublishing | undefined;
  readonly runId: string;
  readonly runs: RunsOutcome | null;
  readonly surface: SurfaceFrame | null;
  readonly title: string;
}

function goalOf(runs: RunsOutcome | null, goalId: string): RunGoalView | null {
  if (runs === null || runs.status !== "RUNS") return null;
  return runs.goals.find((goal) => goal.goalId === goalId) ?? null;
}

function criterionStatements(coverage: DocumentCoverageOutcome | null): ReadonlyMap<string, string> {
  const statements = new Map<string, string>();
  if (coverage === null || coverage.status !== "COVERAGE") return statements;
  for (const contract of coverage.contracts) {
    for (const requirement of contract.requirements) {
      for (const criterion of requirement.criteria) statements.set(criterion.criterionId, criterion.statement);
    }
  }
  return statements;
}

export function BoardScreen(props: BoardScreenProps): JSX.Element {
  const { activity, brief, coverage, goalId, nowMs, onNeedsYou, publishing, runId, runs, surface, title } = props;
  const status = deriveGoalStatus({ coverage, goalId, runId, surface });
  const goal = goalOf(runs, goalId);
  const fold = goal === null || goal.nodes.length === 0 ? null : foldBoard(goal.nodes, nowMs);
  const statements = criterionStatements(coverage);
  const objectives = new Map<string, string>((goal?.nodes ?? []).map((node) => [node.nodeKey, node.objective]));
  const offered = publishOffer(surface, goalId) !== null;
  // The publish card is the pipeline's LAST step: it appears only once the daemon offers it or
  // a publish was already decided, never above work that has not landed.
  const showPublish = publishing !== undefined && (offered || (goal?.publish ?? null) !== null);
  return (
    <section className="cr2-kanban" data-testid="cr.kanban.root" id={GOAL_SECTION_IDS.board}>
      <BoardHeader
        brief={brief}
        fold={fold}
        onNeedsYou={onNeedsYou}
        publishOffered={offered}
        status={status}
        title={goal?.title ?? title}
      />
      {showPublish ? (
        <div className="cr2-kanban-publish" id={GOAL_SECTION_IDS.publish}>
          <GoalPublish frame={publishing.frame} goal={goal} goalId={goalId} port={publishing.port} />
        </div>
      ) : null}
      {fold !== null ? (
        <BoardLanes criterionStatement={(id): string | null => statements.get(id) ?? null} fold={fold} nowMs={nowMs} />
      ) : (
        <div className="cr2-kanban-decision-card" data-testid="cr.kanban.empty">
          {runs === null ? (
            <p className="cr2-kanban-note">Reading the board...</p>
          ) : runs.status !== "RUNS" ? (
            <p className="cr2-kanban-note" title={`${runs.code} ${MIDDOT} ${runs.layer}`}>
              The nodes could not be read right now; the header still holds.
            </p>
          ) : (
            <>
              <p className="cr2-kanban-empty-headline">{status.headline}</p>
              <p className="cr2-kanban-note">
                {status.stage === "PLAN" || status.stage === "CONTRACT"
                  ? status.next.detail
                  : "Nodes appear here once a plan is approved and activated."}
              </p>
            </>
          )}
        </div>
      )}
      <BoardFeed
        goalId={goalId}
        nowMs={nowMs}
        objectiveOf={(nodeKey): string | null => objectives.get(nodeKey) ?? null}
        outcome={activity}
        runId={runId}
      />
    </section>
  );
}

const POLL_MS = 5_000;

/** One bounded poller: latest answer wins, a rejected read becomes the given failure value. */
function usePolled<T>(read: () => Promise<T>, failure: T, pollMs: number): { readonly nowMs: number; readonly value: T | null } {
  const [value, setValue] = useState<T | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const generation = useRef(0);
  useEffect(() => {
    const run = generation.current + 1;
    generation.current = run;
    setValue(null);
    let inFlight = false;
    const tick = (): void => {
      if (inFlight) return;
      inFlight = true;
      void read().then((next) => {
        inFlight = false;
        if (generation.current !== run) return;
        setValue(next);
        setNowMs(Date.now());
      }, () => {
        inFlight = false;
        if (generation.current === run) setValue(failure);
      });
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return (): void => { generation.current += 1; clearInterval(timer); };
  }, [failure, pollMs, read]);
  return { nowMs, value };
}

const RUNS_FAILURE: RunsOutcome = Object.freeze({ code: "RUNS_READ_FAILED", layer: "CONTROL_ROOM_BOARD", status: "ERROR" as const });
const ACTIVITY_FAILURE: ActivityOutcome = Object.freeze({ code: "ACTIVITY_READ_FAILED", layer: "CONTROL_ROOM_BOARD", status: "ERROR" as const });
const COVERAGE_FAILURE: DocumentCoverageOutcome = Object.freeze({ code: "DOCUMENT_COVERAGE_READ_FAILED", layer: "CONTROL_ROOM_BOARD", status: "ERROR" as const });
const CATALOG_FAILURE: GoalCatalogFrame = Object.freeze({ connection: "DISCONNECTED" as const, detail: "catalog read failed", goals: Object.freeze([]), outcome: "UNDELIVERED" as const });

export interface LiveBoardProps {
  readonly goalId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly onNeedsYou?: (() => void) | undefined;
  readonly pollMs?: number | undefined;
  readonly publishing?: BoardPublishing | undefined;
  /** Injectable for tests; the defaults read the daemon with the attached session's headers. */
  readonly readActivity?: ((goalId: string) => Promise<ActivityOutcome>) | undefined;
  readonly readCatalog?: (() => Promise<GoalCatalogFrame>) | undefined;
  readonly readCoverage?: ((goalId: string) => Promise<DocumentCoverageOutcome>) | undefined;
  readonly readRuns?: ((goalId: string) => Promise<RunsOutcome>) | undefined;
  readonly runId: string;
  /** The page's one affordance frame, shared so the board and the approval gate agree on offers. */
  readonly surface: SurfaceFrame | null;
  readonly title: string;
}

export function LiveBoard(props: LiveBoardProps): JSX.Element {
  const { goalId, headers, onNeedsYou, pollMs, publishing, runId, surface, title } = props;
  // The base readers are latched once (the injected ones for tests, the wire ones otherwise);
  // the goal they read is taken at call time, so opening another goal re-polls that goal.
  const [runsBase] = useState(() => props.readRuns ?? ((ref: string): Promise<RunsOutcome> => readRuns(headers, undefined, ref)));
  const [coverageBase] = useState(() => props.readCoverage ?? ((ref: string): Promise<DocumentCoverageOutcome> => readDocumentCoverage(headers, ref)));
  const [activityBase] = useState(() => props.readActivity ?? ((ref: string): Promise<ActivityOutcome> => readActivity(headers, ref)));
  const [catalogReader] = useState(() => props.readCatalog ?? ((): Promise<GoalCatalogFrame> => readGoalCatalog({ headers })));
  const runsReader = useCallback((): Promise<RunsOutcome> => runsBase(goalId), [goalId, runsBase]);
  const coverageReader = useCallback((): Promise<DocumentCoverageOutcome> => coverageBase(goalId), [coverageBase, goalId]);
  const activityReader = useCallback((): Promise<ActivityOutcome> => activityBase(goalId), [activityBase, goalId]);
  const runs = usePolled(runsReader, RUNS_FAILURE, pollMs ?? POLL_MS);
  const coverage = usePolled(coverageReader, COVERAGE_FAILURE, pollMs ?? POLL_MS);
  const activity = usePolled(activityReader, ACTIVITY_FAILURE, pollMs ?? POLL_MS);
  // The brief is the human's own words at creation; it never changes, so one read is enough.
  const [catalog, setCatalog] = useState<GoalCatalogFrame | null>(null);
  useEffect(() => {
    let live = true;
    void catalogReader().then((frame) => { if (live) setCatalog(frame); }, () => { if (live) setCatalog(CATALOG_FAILURE); });
    return (): void => { live = false; };
  }, [catalogReader]);
  const brief = catalog?.goals.find((entry) => entry.goalId === goalId)?.brief?.instructions ?? null;
  return (
    <BoardScreen
      activity={activity.value}
      brief={brief}
      coverage={coverage.value}
      goalId={goalId}
      nowMs={runs.nowMs}
      onNeedsYou={onNeedsYou}
      publishing={publishing}
      runId={runId}
      runs={runs.value}
      surface={surface}
      title={title}
    />
  );
}
