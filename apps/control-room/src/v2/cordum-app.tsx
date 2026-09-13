import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import "./cordum-fonts.js";
import type { SurfaceFrame } from "../live/live-board-feed.js";
import type { LiveSetup } from "../live/live-config.js";
import { readDocumentCoverage } from "../live/live-document-coverage.js";
import { LiveRefusalNotice, NoOperatorChannel, useLiveHandshake } from "./cordum-handshake.js";
import type { PreparedHandshake } from "./cordum-handshake.js";
import { MIDDOT } from "./glyphs.js";
import type { GoalDraft, GoalsData } from "./goals/goal-model.js";
import { PRODUCT_EXAMPLE_DATA } from "./workspace/fixtures/fixture-product-catalog.js";
import { GoalsHome } from "./goals/goals-home.js";
import { LiveGoalsHome } from "./goals/live-goals.js";
import { PairingConfirmation } from "./live/pairing-confirmation.js";
import { LiveNewProduct } from "./products/live-new-product.js";
import { ProjectBoundary } from "./projects/project-boundary.js";
import { useAdvancedFrames } from "./shell/advanced-frames.js";
import { CordumShell } from "./shell/cordum-shell.js";
import type { CordumRoute } from "./shell/shell-routes.js";
import { LiveNeedsYou } from "./approvals/live-needs-you.js";
import { LiveRuns } from "./runs/live-runs.js";
import { HEALTH_FAILURE, LiveHealth, LivePolicy, useOpsRead } from "./ops/live-ops.js";
import { LiveResources } from "./resources/live-resources.js";
import { LiveActivate, activatedOn } from "./ops/activation-screen.js";
import { readHealth } from "../live/live-ops.js";
import type { HealthOutcome } from "../live/live-ops.js";
import { ProviderPauseProvider } from "./shell/pause-context.js";
import { describeConnection } from "./shell/shell-model.js";
import type { ConnectionState } from "./shell/shell-model.js";
import { LiveProductWorkspace } from "./workspace/live-product-workspace.js";
import { FixtureProductWorkspace } from "./workspace/fixtures/fixture-product-workspace.js";
import { useProductRoute } from "./workspace/use-product-route.js";

export type { LiveAttempts } from "./cordum-handshake.js";
const PAUSE_POLL_MS = 15_000;
const DETACHED_HEALTH = (): Promise<HealthOutcome> => Promise.resolve(HEALTH_FAILURE);
const HANDSHAKE_PENDING_DATA: GoalsData = Object.freeze({ source: "live", goals: [], triage: [],
  goalCountLabel: "CONNECTING", comingOnlineNote: "Connecting to your project. Products appear when it answers." });
const fixturesCreateGoal = (_draft: GoalDraft): Promise<string> => Promise.resolve("This is an example. Connect to your project to create a product.");
const connectingCreateGoal = (_draft: GoalDraft): Promise<string> => Promise.resolve("Connecting to your project. Try again once it answers.");
export interface CordumAppProps { readonly search?: string; readonly liveSetup?: PreparedHandshake }

/** One product experience. Existing daemon authority planes remain explicit underneath. */
export function CordumApp({ liveSetup, search = "" }: CordumAppProps): JSX.Element {
  const fixtures = new URLSearchParams(search).get("fixtures") === "1";
  const handshake = useLiveHandshake(!fixtures, liveSetup);
  const live = handshake.resolution;
  const attached = !fixtures && live.status === "READY" && live.setup.ok ? live.setup : null;
  const navigation = useProductRoute(attached, search, fixtures ? PRODUCT_EXAMPLE_DATA : null);
  const { open, openProduct, back: closeProduct } = navigation;
  const [view, setView] = useState<Exclude<CordumRoute["kind"], "board">>("goals");
  const [needsYouCount, setNeedsYouCount] = useState<number | null>(null);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [answeredAtMs, setAnsweredAtMs] = useState<number | null>(null);
  const [homeFrame, setHomeFrame] = useState<{ setup: LiveSetup; frame: SurfaceFrame } | null>(null);
  const reportHomeFrame = useCallback((frame: SurfaceFrame) => {
    if (attached !== null) setHomeFrame({ setup: attached, frame });
  }, [attached]);
  const openBoard = useCallback((goalId: string, planningRunRef: string, title: string) => {
    setConnection(null); openProduct(goalId, planningRunRef, title);
  }, [openProduct]);
  const openFromProduct = useCallback((goalId: string, title: string) => {
    setConnection(null); openProduct(goalId, "", title);
  }, [openProduct]);
  const back = useCallback(() => { setConnection(null); closeProduct(); }, [closeProduct]);
  const reportConnection = useCallback((next: SurfaceFrame["connection"]) => {
    setConnection(next); if (next === "CONNECTED") setAnsweredAtMs(Date.now());
  }, []);
  const navigate = useCallback((route: CordumRoute) => {
    setConnection(null);
    if (route.kind === "board") openProduct(route.goalId, route.planningRunRef, route.title);
    else { closeProduct(); setView(route.kind); }
  }, [openProduct, closeProduct]);
  const needsYou = useCallback(() => navigate({ kind: "approvals" }), [navigate]);
  const projectId = attached?.projectId ?? null;
  const healthReader = useMemo(() => attached === null ? DETACHED_HEALTH : () => readHealth(attached.headers), [attached]);
  const health = useOpsRead(healthReader, HEALTH_FAILURE, PAUSE_POLL_MS, undefined);
  const advanced = useAdvancedFrames(attached);
  const paused = health.outcome?.status === "HEALTH" ? health.outcome.agents.paused : null;
  useEffect(() => { setConnection(null); }, [attached]);
  useEffect(() => {
    if (projectId === null) return;
    const previous = document.title; document.title = `Moe ${MIDDOT} ${projectId}`;
    return () => { document.title = previous; };
  }, [projectId]);
  const readCoverage = useMemo(() => attached === null ? null : (goalId: string) => readDocumentCoverage(attached.headers, goalId), [attached]);
  const labels = { approvals: "Needs you", goals: "Products", health: "Health", policy: "Policy", resources: "Resources", runs: "Runs" } as const;
  const title = open?.title ?? labels[view];

  let body: JSX.Element;
  if (open !== null && navigation.query !== null) {
    body = fixtures ? <FixtureProductWorkspace route={open} query={navigation.query} update={navigation.update} />
      : attached !== null && projectId !== null ? <LiveProductWorkspace key={JSON.stringify([projectId, open.goalId])}
        setup={attached} route={open} query={navigation.query} update={navigation.update}
        onBack={back} onNeedsYou={needsYou} onConnection={reportConnection} />
      : <p role="status">Connecting to this product&apos;s project…</p>;
  } else if (navigation.requested && (attached !== null || fixtures)) {
    body = <section className="cr-product-empty"><h2>{navigation.error === null ? "Opening your product…" : "Product unavailable"}</h2>
      <p role="status">{navigation.error ?? "Checking this product in the connected project's catalog."}</p>
      <button className="cr2-btn" type="button" onClick={back}>Back to products</button></section>;
  } else if (fixtures) {
    body = <GoalsHome data={PRODUCT_EXAMPLE_DATA} onCreateGoal={fixturesCreateGoal} onOpenBoard={openBoard} onOpenProduct={openFromProduct} />;
  } else if (live.status === "PENDING") {
    body = <GoalsHome data={HANDSHAKE_PENDING_DATA} onCreateGoal={connectingCreateGoal} onOpenBoard={openBoard} />;
  } else if (live.status === "OPERATOR_CHANNEL_UNAVAILABLE") {
    body = <NoOperatorChannel />;
  } else if (live.status === "PAIRING") {
    body = <PairingConfirmation busy={live.busy} confirmationLabel={live.pairing.confirmationLabel} onConfirm={handshake.claim} />;
  } else if (view === "runs" && live.setup.ok) {
    body = <LiveRuns headers={live.setup.headers} onConnection={reportConnection} onOpenBoard={openBoard} />;
  } else if (view === "policy" && live.setup.ok) {
    body = <LivePolicy headers={live.setup.headers} onConnection={reportConnection} setup={live.setup} />;
  } else if (view === "health" && live.setup.ok) {
    body = <LiveHealth headers={live.setup.headers} setup={live.setup} onConnection={reportConnection} />;
  } else if (view === "resources" && live.setup.ok) {
    body = <LiveResources headers={live.setup.headers} />;
  } else if (view === "approvals" && live.setup.ok) {
    body = <LiveNeedsYou onConnection={reportConnection} onCount={setNeedsYouCount} onOpenBoard={openBoard}
      readCoverage={readCoverage ?? undefined} setup={live.setup} />;
  } else {
    const descriptor = describeConnection(connection);
    const createDisabledReason = live.setup.ok ? descriptor.actionsEnabled ? undefined : descriptor.banner
      : "Actions require an attached daemon session.";
    body = <>
      {!live.setup.ok && <LiveRefusalNotice busy={handshake.busy} onRetry={handshake.retry} setup={live.setup} />}
      <LiveGoalsHome createDisabledReason={createDisabledReason} onConnection={reportConnection}
        onFrame={reportHomeFrame}
        onNeedsYouCount={setNeedsYouCount} onOpenBoard={openBoard} onOpenProduct={openFromProduct}
        readCoverage={readCoverage ?? undefined} setup={live.setup} />
      {live.setup.ok && <details className="cr-product-setup"><summary>Project setup</summary>
        <p>Create or prepare the local project used to build your product.</p>
        <LiveNewProduct setup={live.setup} />
        <LiveActivate activated={homeFrame?.setup === attached && activatedOn(homeFrame.frame)}
          headers={live.setup.headers} pollMs={PAUSE_POLL_MS} setup={live.setup} />
      </details>}
    </>;
  }
  const shellConnection: ConnectionState | null | undefined = fixtures ? undefined
    : live.status !== "READY" ? null : live.setup.ok ? connection : "DISCONNECTED";
  return <ProviderPauseProvider value={paused}><CordumShell activeNav={view}
    advancedEvents={advanced.events} advancedGraph={advanced.graph} answeredAtMs={answeredAtMs}
    backLabel={labels[view]} connection={shellConnection}
    eyebrow={open === null ? `PROJECT ${MIDDOT} ${projectId ?? "PAIRING"}` : "PRD to product"}
    initialConnection={fixtures ? "CONNECTED" : null}
    navBadges={fixtures || needsYouCount === null || needsYouCount === 0 ? undefined
      : { approvals: { count: String(needsYouCount), tone: "info" } }}
    onBack={navigation.requested ? back : undefined} onNavigate={navigate} simulatable={fixtures} title={title}>
    {!fixtures && open === null ? <ProjectBoundary projectId={projectId} /> : null}{body}
  </CordumShell></ProviderPauseProvider>;
}
