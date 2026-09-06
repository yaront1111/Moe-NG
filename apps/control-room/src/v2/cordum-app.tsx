import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import "./cordum-fonts.js";
import type { SurfaceFrame } from "../live/live-board-feed.js";
import { readDocumentCoverage } from "../live/live-document-coverage.js";
import { readPlanningRun } from "../live/live-planning-run.js";
import { readProductContractGate1 } from "../live/live-product-contract-gate-1.js";
import type { ProductContractRevisionRefInput } from "../live/live-product-contract-gate-1.js";
import {
  LiveRefusalNotice, NoOperatorChannel, useLiveHandshake,
} from "./cordum-handshake.js";
import type { PreparedHandshake } from "./cordum-handshake.js";
import { MIDDOT } from "./glyphs.js";
import { ApprovePlan } from "./goals/approve-plan.js";
import type { PlanApprovalSurface } from "./goals/approve-plan-gate.js";
import { createGate1ApprovalPort, readPendingContract } from "./goals/gate1-approval.js";
import { Gate1Card } from "./goals/gate1-card.js";
import { createGate1ApprovalPortV1, readPendingContractV1 } from "./goals/gate1-v1-approval.js";
import { Gate1CardV1 } from "./goals/gate1-v1-card.js";
import { BoardStub } from "./goals/board-stub.js";
import { LiveContractDossier } from "./goals/contract-dossier.js";
import { LiveCriterionEvidence } from "./goals/live-criterion-evidence.js";
import { LiveDesign } from "./goals/design-card.js";
import { LiveDesignVersionNote } from "./goals/design-version-note.js";
import type { Gate1Reader } from "./goals/contract-gates.js";
import type { GoalDraft, GoalsData } from "./goals/goal-model.js";
import { FIXTURE_GOALS_DATA } from "./goals/goals-fixtures.js";
import { GoalsHome } from "./goals/goals-home.js";
import { LiveGoalsHome } from "./goals/live-goals.js";
import { LiveWorkBoard } from "./goals/live-work-board.js";
import { PrdCoverage } from "./goals/prd-coverage.js";
import { LivePrd } from "./goals/prd-panel.js";
import { GOAL_SECTION_IDS } from "./goals/goal-status-strip.js";
import { LiveBoard } from "./board/board-screen.js";
import { createPublishPort } from "./goals/publish-port.js";
import { authorizeApproval, createPlanApprovalPort } from "./goals/plan-approval.js";
import { currentRunOf, planSentBack } from "./goals/plan-run-resolution.js";
import { PairingConfirmation } from "./live/pairing-confirmation.js";
import { LiveNewProduct } from "./products/live-new-product.js";
import { ProjectBoundary } from "./projects/project-boundary.js";
import { useAdvancedFrames } from "./shell/advanced-frames.js";
import { CordumShell } from "./shell/cordum-shell.js";
import { boardRoute } from "./shell/shell-routes.js";
import type { BoardRoute, CordumRoute } from "./shell/shell-routes.js";
import type { NavBadge } from "./shell/nav-rail.js";
import { LiveNeedsYou } from "./approvals/live-needs-you.js";
import { LiveRuns } from "./runs/live-runs.js";
import { HEALTH_FAILURE, LiveHealth, LivePolicy, useOpsRead } from "./ops/live-ops.js";
import { LiveResources } from "./resources/live-resources.js";
import { LiveActivate } from "./ops/activation-screen.js";
import { readHealth } from "../live/live-ops.js";
import type { HealthOutcome } from "../live/live-ops.js";
import { ProviderPauseProvider } from "./shell/pause-context.js";
import { describeConnection } from "./shell/shell-model.js";
import type { ConnectionState, NavId } from "./shell/shell-model.js";

/**
 * The v2 entry, reached at `?v2=1`. It mounts the Cordum shell over the goals home
 * (UI-3): the live path derives the one real goal from the daemon's affordance
 * surface, and fixtures mode (`?v2=1&fixtures=1`) renders the frozen three-goal
 * design view plus the SIMULATE relay control and the designed attention badges.
 *
 * "Open board" routes to a per-goal board stub (the real board is UI-5), with the
 * shell's breadcrumb wired back to the goals list.
 */

const FIXTURE_BADGES: Partial<Record<NavId, NavBadge>> = Object.freeze({
  approvals: { count: "2", tone: "info" },
  health: { count: "1", tone: "danger" },
});

/**
 * The create action in fixtures mode: no daemon is attached, so it authors
 * nothing and says so plainly rather than pretending to have created a goal.
 */
function fixturesCreateGoal(_draft: GoalDraft): Promise<string> {
  return Promise.resolve(
    `goal.create is not dispatched in fixtures mode ${MIDDOT} attach the daemon to author a goal.`,
  );
}

/** The create action while the handshake is still in flight: nothing is attached yet. */
function connectingCreateGoal(_draft: GoalDraft): Promise<string> {
  return Promise.resolve(`Connecting to the daemon ${MIDDOT} try again once the board attaches.`);
}

/** The honest empty home shown while the runtime handshake is still resolving. */
const HANDSHAKE_PENDING_DATA: GoalsData = Object.freeze({
  source: "live",
  goals: Object.freeze([]),
  triage: Object.freeze([]),
  goalCountLabel: "CONNECTING",
  comingOnlineNote: "Pairing with the daemon over the runtime handshake. Nothing is shown until it answers.",
});


/** Re-exported so `main.tsx` keeps importing it from the entry it composes. */
export type { LiveAttempts } from "./cordum-handshake.js";

/** The ONE shell-wide pause poll: slower than a screen's own 5 s read, because a
 * provider limit lifts on the daemon's clock. Published through the context, so no
 * two screens can disagree about it. */
const PAUSE_POLL_MS = 15_000;

/** Unattached (fixtures, pairing, refused): answer without touching the wire at all. */
const DETACHED_HEALTH = (): Promise<HealthOutcome> => Promise.resolve(HEALTH_FAILURE);

export interface CordumAppProps {
  /** The raw location.search; fixtures mode is `?...&fixtures=1`. */
  readonly search?: string;
  /** One replay-safe initial handshake, optionally with a fresh bounded retry factory. */
  readonly liveSetup?: PreparedHandshake;
}

export function CordumApp({ liveSetup, search = "" }: CordumAppProps): JSX.Element {
  const fixtures = new URLSearchParams(search).get("fixtures") === "1";
  // The live path acquires its credential at RUNTIME through the daemon handshake;
  // in fixtures mode the handshake is disabled and nothing reads its result.
  const handshake = useLiveHandshake(!fixtures, liveSetup);
  const live = handshake.resolution;
  // The opened board IS a route from the shell's typed source of truth, so the nav
  // rail and "Open board" cannot disagree about what a board route carries. The
  // DURABLE planning run rides on it: there is no build-time run constant any more,
  // and a second goal opens its own plan.
  const [open, setOpen] = useState<BoardRoute | null>(null);
  // Which home the operator is on when no board is open: the goals list or the Needs-you
  // queue. Both are routes from the shell's source of truth; a board opens over either.
  const [view, setView] = useState<"approvals" | "goals" | "health" | "policy" | "resources" | "runs">("goals");
  const [needsYouCount, setNeedsYouCount] = useState<number | null>(null);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [answeredAtMs, setAnsweredAtMs] = useState<number | null>(null);
  // The board's own affordance frame, held here because the approval gate and the
  // board read the SAME daemon answer. A second poll for the same bytes would be a
  // second source of truth for what this session is offered.
  const [boardFrame, setBoardFrame] = useState<SurfaceFrame | null>(null);
  const openBoard = useCallback((goalId: string, planningRunRef: string, title: string) => {
    setConnection(null);
    setBoardFrame(null);
    setOpen(boardRoute(goalId, planningRunRef, title));
  }, []);
  const back = useCallback(() => {
    setConnection(null);
    setBoardFrame(null);
    setOpen(null);
  }, []);
  const reportConnection = useCallback((next: SurfaceFrame["connection"]) => {
    setConnection(next);
    if (next === "CONNECTED") setAnsweredAtMs(Date.now());
  }, []);
  const reportFrame = useCallback((next: SurfaceFrame) => {
    setBoardFrame(next);
  }, []);
  /**
   * The nav rail hands back the ROUTE its source of truth stated, never a nav id
   * this entry would have to re-map. The rail decides WHICH destinations exist and
   * which are reachable; this only says what arriving at one means.
   */
  const navigate = useCallback((route: CordumRoute) => {
    setConnection(null);
    setBoardFrame(null);
    setOpen(route.kind === "board" ? route : null);
    if (route.kind !== "board") setView(route.kind);
  }, []);

  const title = open !== null ? open.title
    : view === "approvals" ? "Needs you" : view === "runs" ? "Runs"
      : view === "policy" ? "Policy" : view === "health" ? "Health"
        : view === "resources" ? "Resources" : "Goals";

  // Only an attached operator session carries the authenticated header set the
  // plan-review read requires; unattached (fixtures / pending / refused) the open
  // path keeps the daemon-free BoardStub placeholder.
  const attached = !fixtures && live.status === "READY" && live.setup.ok ? live.setup : null;
  // The bound project is the RUNTIME bootstrap's, not a client-side choice. It is
  // null until the session attaches, and the chrome says PAIRING rather than
  // naming a project this tab is not yet bound to.
  const projectId = attached?.projectId ?? null;
  const healthReader = useMemo(() => (attached === null
    ? DETACHED_HEALTH
    : (): Promise<HealthOutcome> => readHealth(attached.headers)), [attached]);
  const health = useOpsRead(healthReader, HEALTH_FAILURE, PAUSE_POLL_MS, undefined);
  // The raw reads the Advanced panel renders. Fetched HERE, at the composition
  // root, because the panel lives in the shell frame and every screen is inside
  // it: a panel handed no frames renders a load that never completes, which is a
  // served read no operator can reach. Unattached this reads nothing at all.
  const advanced = useAdvancedFrames(attached);
  // A refused or errored answer reads as NO PAUSE KNOWN. Keeping the last pause
  // alive past the read that failed to confirm it would be state this app invented.
  const paused = health.outcome !== null && health.outcome.status === "HEALTH"
    ? health.outcome.agents.paused
    : null;
  const eyebrow = open === null
    ? `PROJECT ${MIDDOT} ${projectId ?? "PAIRING"}`
    : `${MIDDOT} ${open.goalId}`;
  useEffect(() => {
    setConnection(null);
  }, [attached]);
  // Name the bound project in the window title so two project tabs are
  // distinguishable at the taskbar. Restored on unmount so a test or a remount
  // cannot leave a stale project name behind.
  useEffect(() => {
    if (projectId === null) return undefined;
    const previous = document.title;
    document.title = `Moe ${MIDDOT} ${projectId}`;
    return (): void => { document.title = previous; };
  }, [projectId]);
  const readRun = useMemo<((runId: string) => ReturnType<typeof readPlanningRun>) | null>(
    () => (attached === null ? null : (runId: string) => readPlanningRun(attached.headers, runId)),
    [attached],
  );
  /**
   * The GATE 1 surface: pending-contract read + the approval dispatch. Both are
   * daemon-authored — the read answers the minted affordance and subject digest
   * the dispatch presents, so the browser composes no approval identity.
   *
   * WHICH card is the daemon's call, not the bundle's. The plane stated on
   * `/bootstrap` selects the wire: on V1 (every installation until
   * `cutover.activate` commits) agents propose on the `/1` plane and the pending
   * revision is behind `/product-contract/pending/read`; on V2 it is the `/2`
   * family. A card bound to the other plane reads a route that refuses by
   * construction, which is exactly the dead Gate 1 this selection retires.
   */
  /** PRD coverage over the opened goal: read-only, the daemon alone decides what is VERIFIED. */
  const readCoverage = useMemo<((goalId: string) => ReturnType<typeof readDocumentCoverage>) | null>(
    () => (attached === null
      ? null : (goalId: string) => readDocumentCoverage(attached.headers, goalId)),
    [attached],
  );
  /**
   * The DURABLE Gate 1 verdict for one revision triple. Plane-independent on purpose: the
   * route derives its answer from the stored human grant, so it is the same question whether
   * the revision was proposed on the `/1` writer or the `/2` family, and a refusal is the
   * honest answer rather than a reason to withhold the read.
   */
  const readGate = useMemo<Gate1Reader | null>(
    () => (attached === null
      ? null
      : (ref: ProductContractRevisionRefInput) =>
        readProductContractGate1(attached.headers, ref)),
    [attached],
  );
  const plane = attached === null ? null : attached.commandAuthorityPlane;
  const gate1Read = useMemo<((goalId: string) => ReturnType<typeof readPendingContract>) | null>(
    () => (attached === null || projectId === null || plane !== "V2"
      ? null : (goalId: string) => readPendingContract(
        attached.headers, goalId, projectId,
      )),
    [attached, plane, projectId],
  );
  const gate1Port = useMemo(
    () => (attached === null || plane !== "V2" ? null : createGate1ApprovalPort(attached)),
    [attached, plane],
  );
  const gate1ReadV1 = useMemo<((goalId: string) => ReturnType<typeof readPendingContractV1>) | null>(
    () => (attached === null || plane !== "V1"
      ? null : (goalId: string) => readPendingContractV1(attached.headers, goalId)),
    [attached, plane],
  );
  const gate1PortV1 = useMemo(
    () => (attached === null || plane !== "V1" ? null : createGate1ApprovalPortV1(attached)),
    [attached, plane],
  );
  // THE RUN THE PLAN GATE ACTS ON: after a reject the goal's immutable `planningRunRef`
  // still names the run the operator sent back. Resolved ONCE and fed to both the grant
  // and the screen; two resolutions could disagree (see plan-run-resolution.ts).
  const planRunId = open === null ? "" : currentRunOf(boardFrame, open.goalId, open.planningRunRef);
  /**
   * The approval surface handed to the plan-review screen: the daemon's OWN verdict
   * on whether this run may be approved, plus the wire to spend that grant. Nothing
   * here decides authorization - `authorizeApproval` reads the daemon's offer roster
   * off the frame, and with no offer the screen renders the control disabled with the
   * measured reason rather than lighting it up on the strength of being attached.
   */
  const approval = useMemo<PlanApprovalSurface | undefined>(() => {
    if (attached === null || open === null) return undefined;
    return {
      authorization: authorizeApproval(boardFrame, planRunId),
      sentBack: planSentBack(boardFrame, open.goalId, open.planningRunRef),
      submit: createPlanApprovalPort(attached).submit,
    };
  }, [attached, boardFrame, open, planRunId]);

  let body: JSX.Element;
  if (open !== null) {
    body = readRun === null || attached === null
      ? <BoardStub goalId={open.goalId} onBack={back} title={open.title} />
      : (
        // THE BOARD first: where the goal stands, its nodes in six columns, the decisions down
        // the right. The Gate 1 card and the plan fold follow only while they need a decision;
        // everything else the page used to stack is one collapsed fold at the end.
        <>
          <LiveBoard
            goalId={open.goalId}
            headers={attached.headers}
            onNeedsYou={(): void => { navigate({ kind: "approvals" }); }}
            publishing={{ frame: boardFrame, port: createPublishPort(attached) }}
            readCoverage={readCoverage ?? undefined}
            runId={open.planningRunRef}
            surface={boardFrame}
            title={open.title}
          />
          <div id={GOAL_SECTION_IDS.contract}>
            {gate1Read !== null && gate1Port !== null ? (
              <Gate1Card goalId={open.goalId} port={gate1Port} read={gate1Read} />
            ) : gate1ReadV1 !== null && gate1PortV1 !== null ? (
              <Gate1CardV1 goalId={open.goalId} port={gate1PortV1} read={gate1ReadV1} />
            ) : null}
            {/* What the approved contract asks for and how far it is covered, with the
                daemon's DURABLE Gate 1 verdict per revision beside it. */}
            {readCoverage === null ? null : (
              <LiveContractDossier
                goalId={open.goalId}
                readCoverage={readCoverage}
                readGate={readGate ?? undefined}
              />
            )}
            <LiveCriterionEvidence goalRef={open.goalId} setup={attached} />
            <LiveDesign goalRef={open.goalId} headers={attached.headers} />
          </div>
          {/* The plan stays in the open while it waits for a decision; once decided (or not
              yet proposed) it folds, so the board and the decisions come first. */}
          <details
            className="cr2-goal-fold"
            data-testid="cr.goal.planfold"
            id={GOAL_SECTION_IDS.plan}
            open={approval?.authorization.status === "AUTHORIZED"}
          >
            <summary className="cr2-goal-fold-summary">
              {approval?.authorization.status === "AUTHORIZED"
                ? "The plan and its acceptance criteria - waiting for your approval"
                : "The plan and its acceptance criteria"}
            </summary>
            <ApprovePlan
              approval={approval}
              goalId={open.goalId}
              onBack={back}
              read={readRun}
              runId={planRunId}
              title={open.title}
            />
            {/*
              THE VERSION THE PLAN WAS COMPILED AGAINST, on the approval surface itself.
              Approving the plan is how the human accepts the design, so the card has to
              name that design or the acceptance is uninformed. It sits INSIDE the fold,
              under the plan it qualifies, rather than beside the Design tab above.
            */}
            <LiveDesignVersionNote goalRef={open.goalId} headers={attached.headers} />
          </details>
          {/* Reference material, folded: the raw daemon offers (which also feed the one
              affordance frame of the page), PRD coverage, the PRD itself, and the project boundary
              of this tab. The decisions are the feed on the board; the ledger with its seat
              records stays on Health. */}
          <details className="cr2-goal-fold" data-testid="cr.goal.detailsfold">
            <summary className="cr2-goal-fold-summary">Everything else: the raw daemon offers, PRD coverage, the PRD, this project</summary>
            <details className="cr2-goal-fold" data-testid="cr.goal.surfacefold">
              <summary className="cr2-goal-fold-summary">Everything the daemon offers this session, as it states it</summary>
              <LiveWorkBoard
                goalId={open.goalId}
                headers={attached.headers}
                onConnection={reportConnection}
                onFrame={reportFrame}
                runId={open.planningRunRef}
              />
            </details>
            {readCoverage === null ? null : (
              <PrdCoverage goalId={open.goalId} read={readCoverage} />
            )}
            <LivePrd goalRef={open.goalId} headers={attached.headers} />
            <ProjectBoundary projectId={projectId} />
          </details>
        </>
      );
  } else if (fixtures) {
    body = <GoalsHome data={FIXTURE_GOALS_DATA} onCreateGoal={fixturesCreateGoal} onOpenBoard={openBoard} />;
  } else if (live.status === "PENDING") {
    body = (
      <GoalsHome data={HANDSHAKE_PENDING_DATA} onCreateGoal={connectingCreateGoal} onOpenBoard={openBoard} />
    );
  } else if (live.status === "OPERATOR_CHANNEL_UNAVAILABLE") {
    body = <NoOperatorChannel />;
  } else if (live.status === "PAIRING") {
    body = <PairingConfirmation
      busy={live.busy}
      confirmationLabel={live.pairing.confirmationLabel}
      onConfirm={handshake.claim}
    />;
  } else {
    const createDisabledReason = live.setup.ok
      ? (() => {
        const descriptor = describeConnection(connection);
        return descriptor.actionsEnabled ? undefined : descriptor.banner;
      })()
      : "Actions require an attached daemon session.";
    body = view === "runs" && live.setup.ok
      ? <LiveRuns headers={live.setup.headers} onConnection={reportConnection} onOpenBoard={openBoard} />
      : view === "policy" && live.setup.ok
      ? <LivePolicy headers={live.setup.headers} onConnection={reportConnection} setup={live.setup} />
      : view === "health" && live.setup.ok
      ? <LiveHealth headers={live.setup.headers} setup={live.setup} onConnection={reportConnection} />
      : view === "resources" && live.setup.ok
      ? <LiveResources headers={live.setup.headers} />
      : view === "approvals" && live.setup.ok
      ? (
        <LiveNeedsYou
          onConnection={reportConnection}
          onCount={setNeedsYouCount}
          onOpenBoard={openBoard}
          readCoverage={readCoverage ?? undefined}
          setup={live.setup}
        />
      )
      : (
        <>
          {!live.setup.ok && <LiveRefusalNotice
            busy={handshake.busy} onRetry={handshake.retry} setup={live.setup}
          />}
          {/*
            THE NEW PRODUCT CARD LIVES HERE, above Activate and for the same reason Activate
            is not behind a nav id: it is where the operator hits the wall, and this wall is
            one step HARDER than the next one. Activate is refused until a project exists;
            before this card there was no way to make one from the browser at all, so a fresh
            operator had nothing to activate and no route to a first goal. ORDER IS THE
            ARGUMENT - a project must EXIST before it can be ACTIVATED - so it renders first.
          */}
          {live.setup.ok && <LiveNewProduct setup={live.setup} />}
          {/*
            THE ACTIVATE CARD LIVES HERE, not behind a nav id of its own: this is where the
            operator hits the wall, because New goal below is refused until the project is
            activated. It reads on the pause poll's cadence rather than the ops screens' 5 s
            one - the daemon MEASURES on every activation read (git HEAD, store, manifest).
          */}
          {live.setup.ok && <LiveActivate
            headers={live.setup.headers} pollMs={PAUSE_POLL_MS} setup={live.setup}
          />}
          <LiveGoalsHome
            createDisabledReason={createDisabledReason}
            onConnection={reportConnection}
            onNeedsYouCount={setNeedsYouCount}
            onOpenBoard={openBoard}
            readCoverage={readCoverage ?? undefined}
            setup={live.setup}
          />
        </>
      );
  }

  // Every live body names its hard project boundary. Fixtures mode is exempt:
  // nothing is attached there, so there is no boundary to state honestly.
  const content = fixtures || open !== null ? body : (
    <>
      <ProjectBoundary projectId={projectId} />
      {body}
    </>
  );

  const shellConnection: ConnectionState | null | undefined = fixtures
    ? undefined
    : live.status !== "READY"
      ? null
      : live.setup.ok ? connection : "DISCONNECTED";

  return (
    <ProviderPauseProvider value={paused}>
      <CordumShell
        activeNav={view}
        advancedEvents={advanced.events}
        advancedGraph={advanced.graph}
        answeredAtMs={answeredAtMs}
        backLabel={view === "approvals" ? "Needs you" : view === "runs" ? "Runs"
          : view === "policy" ? "Policy" : view === "health" ? "Health"
            : view === "resources" ? "Resources" : "Goals"}
        connection={shellConnection}
        eyebrow={eyebrow}
        initialConnection={fixtures ? "CONNECTED" : null}
        navBadges={fixtures
          ? FIXTURE_BADGES
          : needsYouCount === null || needsYouCount === 0
            ? undefined
            : { approvals: { count: String(needsYouCount), tone: "info" } }}
        onBack={open === null ? undefined : back}
        onNavigate={navigate}
        simulatable={fixtures}
        title={title}
      >
        {content}
      </CordumShell>
    </ProviderPauseProvider>
  );
}
